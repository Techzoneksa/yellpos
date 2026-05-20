// Sprint B — Reports server functions.
// All endpoints are admin-gated (owner|manager|finance) and pull live data from
// orders / order_items / order_item_addons / payments / refunds / refund_items /
// shifts / cash_drawer_movements / products / categories / profiles.
//
// Money math is VAT-INCLUSIVE. Refunds reduce net totals. Held / cancelled
// orders are NEVER counted as sales.

import { createServerFn, registerFn, requireSupabaseAuth } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { riyadhDayRange } from "@/lib/riyadh-date";

/* ───────── helpers ───────── */

const PAYMENT_METHODS = ["cash", "mada", "apple_pay", "visa", "mastercard", "card", "mixed"] as const;
const SALES_STATUSES = ["completed", "partially_refunded", "refunded"] as const;

const r2 = (n: number) => Math.round(n * 100) / 100;

async function assertReportAccess(userId: string) {
  const { data: roles, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["owner", "manager", "finance"]);
  if (error) throw new Error(error.message);
  if (!roles || roles.length === 0) throw new Error("Forbidden");
}

// riyadhDayRange is imported from "@/lib/riyadh-date" (shared helper).


const filtersSchema = z.object({
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cashier_id: z.string().uuid().optional(),
  order_type: z.enum(["dine_in", "takeaway", "delivery_app", "delivery"]).optional(),
  payment_method: z.enum(PAYMENT_METHODS).optional(),
  category_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(500).default(200).optional(),
});

type Filters = z.infer<typeof filtersSchema>;

function resolveRange(f: Filters) {
  if (f.date_from && f.date_to) return { from: f.date_from, to: f.date_to };
  return riyadhDayRange(f.date);
}

/* ───────── shared: load completed orders for a window ───────── */
async function loadSalesOrders(f: Filters) {
  const { from, to } = resolveRange(f);
  let q = supabaseAdmin
    .from("orders")
    .select("id, order_number, created_at, cashier_id, shift_id, order_type, status, subtotal_before_discount, discount_amount, total_including_vat, vat_included_amount, net_amount_excluding_vat, customer_id, notes")
    .gte("created_at", from)
    .lt("created_at", to)
    .in("status", SALES_STATUSES as any)
    .order("created_at", { ascending: false });
  if (f.cashier_id) q = q.eq("cashier_id", f.cashier_id);
  if (f.order_type) q = q.eq("order_type", f.order_type);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return { orders: data ?? [], from, to };
}

async function loadPaymentsForOrders(orderIds: string[]) {
  if (!orderIds.length) return [];
  const { data, error } = await supabaseAdmin
    .from("payments")
    .select("order_id, method, amount, paid_at")
    .in("order_id", orderIds);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function loadInvoicesForOrders(orderIds: string[]) {
  if (!orderIds.length) return new Map<string, string>();
  const { data, error } = await supabaseAdmin
    .from("invoices")
    .select("order_id, invoice_number")
    .in("order_id", orderIds);
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((r: any) => [r.order_id, r.invoice_number]));
}

async function loadCashierNames(ids: (string | null)[]) {
  const uniq = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (!uniq.length) return new Map<string, string>();
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, username")
    .in("id", uniq);
  return new Map((data ?? []).map((p: any) => [p.id, p.full_name || p.username || ""]));
}

/* ───────── 1. Dashboard summary (today) ───────── */
export const getDashboardSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    const { from, to } = riyadhDayRange(data.date);

    const [{ orders }, refundsRes, shiftsRes, heldRes] = await Promise.all([
      loadSalesOrders({ date: data.date }),
      supabaseAdmin.from("refunds").select("id, amount, payment_method, refunded_at, order_id").gte("refunded_at", from).lt("refunded_at", to),
      supabaseAdmin.from("shifts").select("id, status, closed_at, opened_at").or(`status.eq.open,and(closed_at.gte.${from},closed_at.lt.${to})`),
      supabaseAdmin.from("held_orders").select("id"),
    ]);
    if (refundsRes.error) throw new Error(refundsRes.error.message);
    if (shiftsRes.error) throw new Error(shiftsRes.error.message);

    const orderIds = orders.map((o) => o.id);
    const payments = await loadPaymentsForOrders(orderIds);

    const byMethod: Record<string, number> = { cash: 0, mada: 0, apple_pay: 0, visa: 0, mastercard: 0, card: 0 };
    const refundsByMethod: Record<string, number> = { cash: 0, mada: 0, apple_pay: 0, visa: 0, mastercard: 0, card: 0 };
    const positiveByOrder = new Map<string, Set<string>>();
    for (const p of payments) {
      if (Number(p.amount) < 0) continue;
      const s = positiveByOrder.get(p.order_id) || new Set();
      s.add(p.method as string);
      positiveByOrder.set(p.order_id, s);
    }
    const mixedOrderIds = new Set<string>();
    for (const [id, s] of positiveByOrder) if (s.size > 1) mixedOrderIds.add(id);

    for (const p of payments) {
      const m = p.method as string;
      const amt = Number(p.amount);
      if (mixedOrderIds.has(p.order_id)) continue; // accounted via mixedTotal/mixedRefunds
      if (amt >= 0) byMethod[m] = (byMethod[m] ?? 0) + amt;
      else refundsByMethod[m] = (refundsByMethod[m] ?? 0) + Math.abs(amt);
    }
    let mixedTotal = 0;
    let mixedRefunds = 0;
    for (const o of orders) if (mixedOrderIds.has(o.id)) mixedTotal += Number(o.total_including_vat);
    for (const p of payments) {
      if (!mixedOrderIds.has(p.order_id)) continue;
      const amt = Number(p.amount);
      if (amt < 0) mixedRefunds += Math.abs(amt);
    }

    const gross = orders.reduce((s, o) => s + Number(o.total_including_vat), 0);
    const discounts = orders.reduce((s, o) => s + Number(o.discount_amount), 0);
    const vatIncluded = orders.reduce((s, o) => s + Number(o.vat_included_amount), 0);
    const refundsTotal = (refundsRes.data ?? []).reduce((s, r: any) => s + Number(r.amount), 0);
    const net = gross - refundsTotal;

    const activeShifts = (shiftsRes.data ?? []).filter((s: any) => s.status === "open").length;
    const closedShiftsToday = (shiftsRes.data ?? []).filter((s: any) => s.status === "closed").length;

    const ordersCount = orders.length;
    const aov = ordersCount ? gross / ordersCount : 0;

    // Top products (today)
    let topProducts: { product_id: string | null; name: string; qty: number; gross: number }[] = [];
    if (orderIds.length) {
      const { data: items } = await supabaseAdmin
        .from("order_items")
        .select("product_id, name_snapshot, quantity, line_total")
        .in("order_id", orderIds);
      const map = new Map<string, { product_id: string | null; name: string; qty: number; gross: number }>();
      for (const it of items ?? []) {
        const key = it.product_id || it.name_snapshot;
        const cur = map.get(key) || { product_id: it.product_id, name: it.name_snapshot, qty: 0, gross: 0 };
        cur.qty += Number(it.quantity);
        cur.gross += Number(it.line_total);
        map.set(key, cur);
      }
      topProducts = [...map.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
    }

    // Sales by cashier (today)
    const cashierAgg = new Map<string, { orders: number; gross: number }>();
    for (const o of orders) {
      const cur = cashierAgg.get(o.cashier_id) || { orders: 0, gross: 0 };
      cur.orders += 1;
      cur.gross += Number(o.total_including_vat);
      cashierAgg.set(o.cashier_id, cur);
    }
    const nameMap = await loadCashierNames([...cashierAgg.keys()]);
    const byCashier = [...cashierAgg.entries()].map(([id, v]) => ({
      cashier_id: id,
      cashier_name: nameMap.get(id) || "",
      ...v,
      gross: r2(v.gross),
    })).sort((a, b) => b.gross - a.gross);

    const byOrderType = ["dine_in", "takeaway", "delivery_app"].map((tid) => ({
      order_type: tid,
      orders: orders.filter((o) => o.order_type === tid).length,
      gross: r2(orders.filter((o) => o.order_type === tid).reduce((s, o) => s + Number(o.total_including_vat), 0)),
    }));

    return {
      range: { from, to },
      gross: r2(gross),
      net: r2(net),
      discounts: r2(discounts),
      refunds: r2(refundsTotal),
      vatIncluded: r2(vatIncluded),
      ordersCount,
      aov: r2(aov),
      activeShifts,
      closedShiftsToday,
      heldOrders: (heldRes.data ?? []).length,
      byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, r2(v)])),
      refundsByMethod: Object.fromEntries(Object.entries(refundsByMethod).map(([k, v]) => [k, r2(v)])),
      mixedTotal: r2(mixedTotal),
      mixedRefunds: r2(mixedRefunds),
      byCashier,
      byOrderType,
      topProducts: topProducts.map((p) => ({ ...p, gross: r2(p.gross) })),
    };
  });
registerFn('getDashboardSummary', getDashboardSummary);

/* ───────── 2. Daily sales report ───────── */
export const getDailySalesReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => filtersSchema.parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    const { orders, from, to } = await loadSalesOrders(data);
    const orderIds = orders.map((o) => o.id);
    const [payments, invMap, refundsRes] = await Promise.all([
      loadPaymentsForOrders(orderIds),
      loadInvoicesForOrders(orderIds),
      supabaseAdmin.from("refunds").select("order_id, amount").gte("refunded_at", from).lt("refunded_at", to),
    ]);
    if (refundsRes.error) throw new Error(refundsRes.error.message);

    const cashierNames = await loadCashierNames(orders.map((o) => o.cashier_id));
    const refundsByOrder = new Map<string, number>();
    for (const r of refundsRes.data ?? []) {
      refundsByOrder.set(r.order_id, (refundsByOrder.get(r.order_id) ?? 0) + Number(r.amount));
    }

    const orderMethods = new Map<string, { positives: { method: string; amount: number }[] }>();
    for (const p of payments) {
      const cur = orderMethods.get(p.order_id) || { positives: [] };
      if (Number(p.amount) >= 0) cur.positives.push({ method: p.method, amount: Number(p.amount) });
      orderMethods.set(p.order_id, cur);
    }
    const totals: Record<string, number> = { cash: 0, mada: 0, apple_pay: 0, visa: 0, mastercard: 0, card: 0, mixed: 0 };
    for (const o of orders) {
      const om = orderMethods.get(o.id);
      const positives = om?.positives ?? [];
      const distinct = new Set(positives.map((p) => p.method));
      if (distinct.size > 1) totals.mixed += Number(o.total_including_vat);
      else if (positives[0]) totals[positives[0].method] = (totals[positives[0].method] ?? 0) + positives[0].amount;
    }

    const gross = orders.reduce((s, o) => s + Number(o.total_including_vat), 0);
    const discounts = orders.reduce((s, o) => s + Number(o.discount_amount), 0);
    const vatIncluded = orders.reduce((s, o) => s + Number(o.vat_included_amount), 0);
    const refunds = (refundsRes.data ?? []).reduce((s, r: any) => s + Number(r.amount), 0);
    let filteredRows = orders.map((o) => {
      const om = orderMethods.get(o.id);
      const positives = om?.positives ?? [];
      const distinct = new Set(positives.map((p) => p.method));
      const primary = distinct.size > 1 ? "mixed" : positives[0]?.method ?? null;
      return {
        id: o.id,
        time: o.created_at,
        order_number: o.order_number,
        invoice_number: invMap.get(o.id) || "",
        cashier_id: o.cashier_id,
        cashier_name: cashierNames.get(o.cashier_id) || "",
        order_type: o.order_type,
        payment_method: primary,
        subtotal: r2(Number(o.subtotal_before_discount)),
        discount: r2(Number(o.discount_amount)),
        vat_included: r2(Number(o.vat_included_amount)),
        total: r2(Number(o.total_including_vat)),
        status: o.status,
        refunded_amount: r2(refundsByOrder.get(o.id) ?? 0),
      };
    });
    if (data.payment_method) filteredRows = filteredRows.filter((r) => r.payment_method === data.payment_method);

    return {
      range: { from, to },
      summary: {
        gross: r2(gross),
        discounts: r2(discounts),
        refunds: r2(refunds),
        net: r2(gross - refunds),
        vatIncluded: r2(vatIncluded),
        ordersCount: orders.length,
        aov: r2(orders.length ? gross / orders.length : 0),
        totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, r2(v)])),
      },
      rows: filteredRows,
    };
  });
registerFn('getDailySalesReport', getDailySalesReport);

/* ───────── 3. Shift / Z-Report ───────── */
export const getShiftReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ shift_id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    const { data: shift, error } = await supabaseAdmin.from("shifts").select("*").eq("id", data.shift_id).single();
    if (error) throw new Error(error.message);

    const [orderRes, movRes, cashierMap] = await Promise.all([
      supabaseAdmin.from("orders").select("id, total_including_vat, discount_amount, status, order_type").eq("shift_id", data.shift_id).in("status", SALES_STATUSES as any),
      supabaseAdmin.from("cash_drawer_movements").select("type, amount").eq("shift_id", data.shift_id),
      loadCashierNames([shift.cashier_id]),
    ]);
    if (orderRes.error) throw new Error(orderRes.error.message);
    if (movRes.error) throw new Error(movRes.error.message);
    const orders = orderRes.data ?? [];
    const orderIds = orders.map((o) => o.id);
    const payments = await loadPaymentsForOrders(orderIds);

    let cashSales = 0, cashRefunds = 0;
    const byMethod: Record<string, number> = { cash: 0, mada: 0, apple_pay: 0, visa: 0, mastercard: 0, card: 0 };
    const refundsByMethod: Record<string, number> = { cash: 0, mada: 0, apple_pay: 0, visa: 0, mastercard: 0, card: 0 };
    const positiveByOrder = new Map<string, Set<string>>();
    for (const p of payments) {
      if (Number(p.amount) < 0) continue;
      const s = positiveByOrder.get(p.order_id) || new Set();
      s.add(p.method as string);
      positiveByOrder.set(p.order_id, s);
    }
    const mixedOrderIds = new Set<string>();
    for (const [id, s] of positiveByOrder) if (s.size > 1) mixedOrderIds.add(id);

    for (const p of payments) {
      const m = p.method as string;
      const amt = Number(p.amount);
      // cashSales/cashRefunds are real cash drawer flows — always count, even within mixed orders
      if (amt >= 0 && m === "cash") cashSales += amt;
      if (amt < 0 && m === "cash") cashRefunds += Math.abs(amt);
      if (mixedOrderIds.has(p.order_id)) continue; // method buckets exclude mixed
      if (amt >= 0) byMethod[m] = (byMethod[m] ?? 0) + amt;
      else refundsByMethod[m] = (refundsByMethod[m] ?? 0) + Math.abs(amt);
    }
    let mixedTotal = 0;
    let mixedRefunds = 0;
    for (const o of orders) if (mixedOrderIds.has(o.id)) mixedTotal += Number(o.total_including_vat);
    for (const p of payments) {
      if (!mixedOrderIds.has(p.order_id)) continue;
      const amt = Number(p.amount);
      if (amt < 0) mixedRefunds += Math.abs(amt);
    }

    let payIn = 0, payOut = 0;
    for (const m of movRes.data ?? []) {
      if (m.type === "pay_in") payIn += Number(m.amount);
      else if (m.type === "pay_out") payOut += Number(m.amount);
    }
    const expected = Number(shift.opening_float) + cashSales - cashRefunds + payIn - payOut;

    const { count: refundCount } = await supabaseAdmin
      .from("refunds").select("id", { count: "exact", head: true })
      .in("order_id", orderIds.length ? orderIds : ["00000000-0000-0000-0000-000000000000"]);

    const { count: heldCount } = await supabaseAdmin
      .from("held_orders").select("id", { count: "exact", head: true }).eq("shift_id", data.shift_id);

    const gross = orders.reduce((s, o) => s + Number(o.total_including_vat), 0);
    const totalRefunds = Object.values(refundsByMethod).reduce((s, v) => s + v, 0) + mixedRefunds;
    const discounts = orders.reduce((s, o) => s + Number(o.discount_amount), 0);

    return {
      shift: { ...shift, cashier_name: cashierMap.get(shift.cashier_id) || "" },
      ordersCount: orders.length,
      gross: r2(gross),
      net: r2(gross - totalRefunds),
      discounts: r2(discounts),
      refunds: r2(totalRefunds),
      refundCount: refundCount ?? 0,
      heldCount: heldCount ?? 0,
      openingCash: r2(Number(shift.opening_float)),
      cashSales: r2(cashSales),
      cashRefunds: r2(cashRefunds),
      payIn: r2(payIn),
      payOut: r2(payOut),
      expectedCash: r2(expected),
      actualCash: shift.closing_cash != null ? r2(Number(shift.closing_cash)) : null,
      variance: shift.variance != null ? r2(Number(shift.variance)) : null,
      byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, r2(v)])),
      refundsByMethod: Object.fromEntries(Object.entries(refundsByMethod).map(([k, v]) => [k, r2(v)])),
      mixedTotal: r2(mixedTotal),
      mixedRefunds: r2(mixedRefunds),
    };
  });
registerFn('getShiftReport', getShiftReport);

/* ───────── 4. End-of-day report ───────── */
export const getEndOfDayReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), cashier_id: z.string().uuid().optional() }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    const { from, to } = riyadhDayRange(data.date);

    let oq = supabaseAdmin
      .from("orders")
      .select("id, cashier_id, shift_id, order_type, total_including_vat, discount_amount, vat_included_amount, status")
      .gte("created_at", from).lt("created_at", to)
      .in("status", SALES_STATUSES as any);
    if (data.cashier_id) oq = oq.eq("cashier_id", data.cashier_id);
    const { data: orders, error } = await oq;
    if (error) throw new Error(error.message);

    const orderIds = (orders ?? []).map((o) => o.id);
    const [payments, refundsRes, shiftsRes] = await Promise.all([
      loadPaymentsForOrders(orderIds),
      supabaseAdmin.from("refunds").select("id, amount, payment_method, order_id").gte("refunded_at", from).lt("refunded_at", to),
      supabaseAdmin.from("shifts").select("*").gte("opened_at", from).lt("opened_at", to),
    ]);
    if (refundsRes.error) throw new Error(refundsRes.error.message);
    if (shiftsRes.error) throw new Error(shiftsRes.error.message);

    const byMethod: Record<string, number> = { cash: 0, mada: 0, apple_pay: 0, visa: 0, mastercard: 0, card: 0 };
    for (const p of payments) {
      const amt = Number(p.amount);
      if (amt >= 0) byMethod[p.method as string] = (byMethod[p.method as string] ?? 0) + amt;
    }
    const gross = (orders ?? []).reduce((s, o) => s + Number(o.total_including_vat), 0);
    const discounts = (orders ?? []).reduce((s, o) => s + Number(o.discount_amount), 0);
    const vatIncluded = (orders ?? []).reduce((s, o) => s + Number(o.vat_included_amount), 0);
    const refundsTotal = (refundsRes.data ?? []).reduce((s, r: any) => s + Number(r.amount), 0);

    let movPayIn = 0, movPayOut = 0;
    let varianceTotal = 0;
    const shifts = shiftsRes.data ?? [];
    if (shifts.length) {
      const { data: movs } = await supabaseAdmin
        .from("cash_drawer_movements")
        .select("type, amount, shift_id")
        .in("shift_id", shifts.map((s: any) => s.id));
      for (const m of movs ?? []) {
        if (m.type === "pay_in") movPayIn += Number(m.amount);
        else movPayOut += Number(m.amount);
      }
      for (const s of shifts) if (s.variance != null) varianceTotal += Number(s.variance);
    }

    const ordersByType = ["dine_in", "takeaway", "delivery_app"].map((t) => ({
      order_type: t,
      orders: (orders ?? []).filter((o) => o.order_type === t).length,
      gross: r2((orders ?? []).filter((o) => o.order_type === t).reduce((s, o) => s + Number(o.total_including_vat), 0)),
    }));

    const cashierAgg = new Map<string, { orders: number; gross: number }>();
    for (const o of orders ?? []) {
      const c = cashierAgg.get(o.cashier_id) || { orders: 0, gross: 0 };
      c.orders += 1; c.gross += Number(o.total_including_vat);
      cashierAgg.set(o.cashier_id, c);
    }
    const nameMap = await loadCashierNames([...cashierAgg.keys(), ...shifts.map((s: any) => s.cashier_id)]);
    const byCashier = [...cashierAgg.entries()].map(([id, v]) => ({
      cashier_id: id, cashier_name: nameMap.get(id) || "", orders: v.orders, gross: r2(v.gross),
    })).sort((a, b) => b.gross - a.gross);

    let topProducts: { name: string; qty: number; gross: number }[] = [];
    if (orderIds.length) {
      const { data: items } = await supabaseAdmin.from("order_items")
        .select("product_id, name_snapshot, quantity, line_total").in("order_id", orderIds);
      const map = new Map<string, { name: string; qty: number; gross: number }>();
      for (const it of items ?? []) {
        const key = it.product_id || it.name_snapshot;
        const cur = map.get(key) || { name: it.name_snapshot, qty: 0, gross: 0 };
        cur.qty += Number(it.quantity); cur.gross += Number(it.line_total);
        map.set(key, cur);
      }
      topProducts = [...map.values()].sort((a, b) => b.qty - a.qty).slice(0, 10).map((p) => ({ ...p, gross: r2(p.gross) }));
    }

    const shiftRows = shifts.map((s: any) => ({
      id: s.id, cashier_id: s.cashier_id, cashier_name: nameMap.get(s.cashier_id) || "",
      opened_at: s.opened_at, closed_at: s.closed_at, status: s.status,
      opening_float: r2(Number(s.opening_float)),
      closing_cash: s.closing_cash != null ? r2(Number(s.closing_cash)) : null,
      expected_cash: s.expected_cash != null ? r2(Number(s.expected_cash)) : null,
      variance: s.variance != null ? r2(Number(s.variance)) : null,
    }));

    return {
      range: { from, to },
      summary: {
        gross: r2(gross), discounts: r2(discounts), refunds: r2(refundsTotal),
        net: r2(gross - refundsTotal), vatIncluded: r2(vatIncluded),
        ordersCount: orders?.length ?? 0,
        aov: r2(orders?.length ? gross / orders.length : 0),
        shiftsCount: shifts.length,
        cashTotal: r2(byMethod.cash),
        cardNetworkTotal: r2(byMethod.mada + byMethod.visa + byMethod.mastercard + byMethod.card),
        applePayTotal: r2(byMethod.apple_pay),
        visaMcTotal: r2(byMethod.visa + byMethod.mastercard),
        cashVarianceTotal: r2(varianceTotal),
        payIn: r2(movPayIn), payOut: r2(movPayOut),
      },
      byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, r2(v)])),
      byOrderType: ordersByType,
      byCashier,
      topProducts,
      shifts: shiftRows,
      refundsCount: (refundsRes.data ?? []).length,
    };
  });
registerFn('getEndOfDayReport', getEndOfDayReport);

/* ───────── 5. Top products report ───────── */
export const getTopProductsReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => filtersSchema.parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    const { orders, from, to } = await loadSalesOrders(data);
    const orderIds = orders.map((o) => o.id);
    if (!orderIds.length) return { range: { from, to }, rows: [] };

    const { data: items, error } = await supabaseAdmin
      .from("order_items")
      .select("id, product_id, name_snapshot, quantity, line_total, order_id")
      .in("order_id", orderIds);
    if (error) throw new Error(error.message);

    const itemIdList = (items ?? []).map((it: any) => it.id).filter(Boolean);
    const { data: refundItems } = itemIdList.length
      ? await supabaseAdmin
          .from("refund_items")
          .select("order_item_id, quantity, amount")
          .in("order_item_id", itemIdList)
      : { data: [] as any[] };
    const refundByItem = new Map<string, { qty: number; amount: number }>();
    for (const r of refundItems ?? []) {
      if (!r.order_item_id) continue;
      const cur = refundByItem.get(r.order_item_id) || { qty: 0, amount: 0 };
      cur.qty += Number(r.quantity); cur.amount += Number(r.amount);
      refundByItem.set(r.order_item_id, cur);
    }

    const prodIds = Array.from(new Set((items ?? []).map((i) => i.product_id).filter(Boolean) as string[]));
    const { data: products } = prodIds.length
      ? await supabaseAdmin.from("products").select("id, name_ar, name_en, category_id").in("id", prodIds)
      : { data: [] as any[] };
    const prodMap = new Map((products ?? []).map((p: any) => [p.id, p]));

    let catFilter = (it: any) => true;
    if (data.category_id) catFilter = (it: any) => prodMap.get(it.product_id)?.category_id === data.category_id;

    const agg = new Map<string, { product_id: string | null; name: string; category_id: string | null; qty: number; gross: number; refQty: number; refAmt: number }>();
    for (const it of (items ?? []).filter(catFilter)) {
      const key = it.product_id || it.name_snapshot;
      const cur = agg.get(key) || { product_id: it.product_id, name: it.name_snapshot, category_id: prodMap.get(it.product_id)?.category_id ?? null, qty: 0, gross: 0, refQty: 0, refAmt: 0 };
      cur.qty += Number(it.quantity);
      cur.gross += Number(it.line_total);
      const r = refundByItem.get(it.id as any);
      if (r) { cur.refQty += r.qty; cur.refAmt += r.amount; }
      agg.set(key, cur);
    }

    const { data: cats } = await supabaseAdmin.from("categories").select("id, name_ar, name_en");
    const catMap = new Map((cats ?? []).map((c: any) => [c.id, c]));

    const rows = [...agg.values()]
      .map((r) => ({
        product_id: r.product_id, name: r.name,
        category_id: r.category_id,
        category_name_ar: r.category_id ? catMap.get(r.category_id)?.name_ar ?? "" : "",
        category_name_en: r.category_id ? catMap.get(r.category_id)?.name_en ?? "" : "",
        qty: r.qty, gross: r2(r.gross),
        refundQty: r.refQty, refundAmount: r2(r.refAmt),
        netQty: r.qty - r.refQty, netSales: r2(r.gross - r.refAmt),
      }))
      .sort((a, b) => b.qty - a.qty);

    return { range: { from, to }, rows };
  });
registerFn('getTopProductsReport', getTopProductsReport);

/* ───────── 6. Sales by payment method ───────── */
export const getSalesByPaymentMethod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => filtersSchema.parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    const { orders, from, to } = await loadSalesOrders(data);
    const orderIds = orders.map((o) => o.id);
    const payments = await loadPaymentsForOrders(orderIds);

    // First pass: classify each order as single-method or mixed (based on POSITIVE payments only).
    const positiveByOrder = new Map<string, Set<string>>();
    for (const p of payments) {
      if (Number(p.amount) < 0) continue;
      const s = positiveByOrder.get(p.order_id) || new Set();
      s.add(p.method as string);
      positiveByOrder.set(p.order_id, s);
    }
    const mixedOrderIds = new Set<string>();
    for (const [id, s] of positiveByOrder) if (s.size > 1) mixedOrderIds.add(id);

    const gross: Record<string, number> = { cash: 0, mada: 0, apple_pay: 0, visa: 0, mastercard: 0, card: 0 };
    const refunds: Record<string, number> = { cash: 0, mada: 0, apple_pay: 0, visa: 0, mastercard: 0, card: 0 };
    const tx: Record<string, number> = { cash: 0, mada: 0, apple_pay: 0, visa: 0, mastercard: 0, card: 0 };
    const orderCountedAsTx = new Set<string>();
    for (const p of payments) {
      const m = p.method as string; const amt = Number(p.amount);
      if (amt >= 0) {
        // Skip positives of mixed orders — they are aggregated under "mixed"
        if (mixedOrderIds.has(p.order_id)) continue;
        gross[m] = (gross[m] ?? 0) + amt;
        if (!orderCountedAsTx.has(p.order_id)) {
          tx[m] = (tx[m] ?? 0) + 1;
          orderCountedAsTx.add(p.order_id);
        }
      } else {
        // Negative payments (refunds) are unambiguous — keep under their method
        refunds[m] = (refunds[m] ?? 0) + Math.abs(amt);
      }
    }
    let mixedGross = 0;
    let mixedRefunds = 0;
    for (const o of orders) {
      if (mixedOrderIds.has(o.id)) mixedGross += Number(o.total_including_vat);
    }
    // For mixed orders, attribute their refunds to "mixed" instead of double-counting under method buckets above.
    // Detect refunds that target mixed orders and shift them from per-method refunds to mixedRefunds.
    const refundsByOrderMethod = new Map<string, { method: string; amount: number }[]>();
    for (const p of payments) {
      const amt = Number(p.amount);
      if (amt >= 0) continue;
      if (!mixedOrderIds.has(p.order_id)) continue;
      const arr = refundsByOrderMethod.get(p.order_id) || [];
      arr.push({ method: p.method as string, amount: Math.abs(amt) });
      refundsByOrderMethod.set(p.order_id, arr);
    }
    for (const arr of refundsByOrderMethod.values()) {
      for (const r of arr) {
        refunds[r.method] = Math.max(0, (refunds[r.method] ?? 0) - r.amount);
        mixedRefunds += r.amount;
      }
    }

    const rows = ["cash", "mada", "apple_pay", "visa", "mastercard"].map((m) => ({
      method: m, transactions: tx[m] ?? 0, gross: r2(gross[m] ?? 0), refunds: r2(refunds[m] ?? 0), net: r2((gross[m] ?? 0) - (refunds[m] ?? 0)),
    }));
    rows.push({ method: "mixed", transactions: mixedOrderIds.size, gross: r2(mixedGross), refunds: r2(mixedRefunds), net: r2(mixedGross - mixedRefunds) });
    return { range: { from, to }, rows };
  });
registerFn('getSalesByPaymentMethod', getSalesByPaymentMethod);

/* ───────── 7. Sales by order type ───────── */
export const getSalesByOrderType = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => filtersSchema.parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    const { orders, from, to } = await loadSalesOrders(data);
    const orderIds = orders.map((o) => o.id);
    const refundsRes = orderIds.length
      ? await supabaseAdmin.from("refunds").select("order_id, amount").in("order_id", orderIds)
      : { data: [] as any[], error: null };
    if (refundsRes.error) throw new Error(refundsRes.error.message);
    const refundByOrder = new Map<string, number>();
    for (const r of refundsRes.data ?? []) refundByOrder.set(r.order_id, (refundByOrder.get(r.order_id) ?? 0) + Number(r.amount));

    const rows = ["dine_in", "takeaway", "delivery_app"].map((tid) => {
      const sub = orders.filter((o) => o.order_type === tid);
      const gross = sub.reduce((s, o) => s + Number(o.total_including_vat), 0);
      const discounts = sub.reduce((s, o) => s + Number(o.discount_amount), 0);
      const refunds = sub.reduce((s, o) => s + (refundByOrder.get(o.id) ?? 0), 0);
      return {
        order_type: tid, orders: sub.length,
        gross: r2(gross), discounts: r2(discounts), refunds: r2(refunds),
        net: r2(gross - refunds), aov: r2(sub.length ? gross / sub.length : 0),
      };
    });
    return { range: { from, to }, rows };
  });
registerFn('getSalesByOrderType', getSalesByOrderType);

/* ───────── 8. Sales by cashier ───────── */
export const getSalesByCashier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => filtersSchema.parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    const { orders, from, to } = await loadSalesOrders(data);
    const orderIds = orders.map((o) => o.id);
    const payments = await loadPaymentsForOrders(orderIds);
    const refundsRes = orderIds.length
      ? await supabaseAdmin.from("refunds").select("order_id, amount").in("order_id", orderIds)
      : { data: [] as any[], error: null };
    if (refundsRes.error) throw new Error(refundsRes.error.message);
    const refundByOrder = new Map<string, number>();
    for (const r of refundsRes.data ?? []) refundByOrder.set(r.order_id, (refundByOrder.get(r.order_id) ?? 0) + Number(r.amount));

    const cashByOrder = new Map<string, number>();
    const cardByOrder = new Map<string, number>();
    for (const p of payments) {
      const amt = Number(p.amount); if (amt < 0) continue;
      if (p.method === "cash") cashByOrder.set(p.order_id, (cashByOrder.get(p.order_id) ?? 0) + amt);
      else cardByOrder.set(p.order_id, (cardByOrder.get(p.order_id) ?? 0) + amt);
    }

    const agg = new Map<string, { orders: number; gross: number; discounts: number; refunds: number; cash: number; card: number }>();
    for (const o of orders) {
      const cur = agg.get(o.cashier_id) || { orders: 0, gross: 0, discounts: 0, refunds: 0, cash: 0, card: 0 };
      cur.orders += 1;
      cur.gross += Number(o.total_including_vat);
      cur.discounts += Number(o.discount_amount);
      cur.refunds += refundByOrder.get(o.id) ?? 0;
      cur.cash += cashByOrder.get(o.id) ?? 0;
      cur.card += cardByOrder.get(o.id) ?? 0;
      agg.set(o.cashier_id, cur);
    }
    const nameMap = await loadCashierNames([...agg.keys()]);
    const { data: shifts } = await supabaseAdmin.from("shifts").select("cashier_id, variance, status").gte("opened_at", from).lt("opened_at", to);
    const varianceMap = new Map<string, number>();
    for (const s of shifts ?? []) if (s.variance != null) varianceMap.set(s.cashier_id, (varianceMap.get(s.cashier_id) ?? 0) + Number(s.variance));

    const rows = [...agg.entries()].map(([id, v]) => ({
      cashier_id: id, cashier_name: nameMap.get(id) || "",
      orders: v.orders, gross: r2(v.gross), discounts: r2(v.discounts),
      refunds: r2(v.refunds), net: r2(v.gross - v.refunds),
      cash: r2(v.cash), card: r2(v.card),
      variance: varianceMap.has(id) ? r2(varianceMap.get(id)!) : null,
    })).sort((a, b) => b.gross - a.gross);
    return { range: { from, to }, rows };
  });
registerFn('getSalesByCashier', getSalesByCashier);

/* ───────── 9. Discounts report ───────── */
export const getDiscountsReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => filtersSchema.parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    const { orders, from, to } = await loadSalesOrders(data);
    const withDiscount = orders.filter((o) => Number(o.discount_amount) > 0);
    const orderIds = withDiscount.map((o) => o.id);
    const invMap = await loadInvoicesForOrders(orderIds);
    const nameMap = await loadCashierNames(withDiscount.map((o) => o.cashier_id));
    const rows = withDiscount.map((o) => ({
      id: o.id, time: o.created_at,
      order_number: o.order_number, invoice_number: invMap.get(o.id) || "",
      cashier_name: nameMap.get(o.cashier_id) || "",
      discount_amount: r2(Number(o.discount_amount)),
      subtotal: r2(Number(o.subtotal_before_discount)),
      total: r2(Number(o.total_including_vat)),
    }));
    const total = rows.reduce((s, r) => s + r.discount_amount, 0);
    return { range: { from, to }, total: r2(total), count: rows.length, rows };
  });
registerFn('getDiscountsReport', getDiscountsReport);

/* ───────── 10. Refunds report ───────── */
export const getRefundsReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    filtersSchema.extend({ refund_type: z.enum(["full", "partial"]).optional() }).parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    const { from, to } = resolveRange(data);
    let q = supabaseAdmin
      .from("refunds")
      .select("id, refunded_at, order_id, cashier_id, amount, type, payment_method, invoice_number, reason")
      .gte("refunded_at", from).lt("refunded_at", to)
      .order("refunded_at", { ascending: false });
    if (data.cashier_id) q = q.eq("cashier_id", data.cashier_id);
    if (data.payment_method) q = q.eq("payment_method", data.payment_method);
    if (data.refund_type) q = q.eq("type", data.refund_type);
    const { data: refunds, error } = await q;
    if (error) throw new Error(error.message);

    const orderIds = Array.from(new Set((refunds ?? []).map((r: any) => r.order_id)));
    const [{ data: orders }, { data: items }] = await Promise.all([
      orderIds.length ? supabaseAdmin.from("orders").select("id, order_number, status").in("id", orderIds) : Promise.resolve({ data: [] as any[] }),
      (async () => {
        const ids = (refunds ?? []).map((r: any) => r.id);
        if (!ids.length) return { data: [] as any[] };
        return supabaseAdmin.from("refund_items").select("refund_id, quantity").in("refund_id", ids);
      })(),
    ]);
    const orderMap = new Map((orders ?? []).map((o: any) => [o.id, o]));
    const itemCount = new Map<string, number>();
    for (const it of items ?? []) itemCount.set(it.refund_id, (itemCount.get(it.refund_id) ?? 0) + Number(it.quantity));

    const nameMap = await loadCashierNames((refunds ?? []).map((r: any) => r.cashier_id));

    const rows = (refunds ?? []).map((r: any) => ({
      id: r.id, time: r.refunded_at,
      order_id: r.order_id, order_number: orderMap.get(r.order_id)?.order_number || "",
      invoice_number: r.invoice_number || "",
      cashier_name: nameMap.get(r.cashier_id) || "",
      refund_type: r.type, items_count: itemCount.get(r.id) ?? 0,
      amount: r2(Number(r.amount)),
      payment_method: r.payment_method,
      order_status_after: orderMap.get(r.order_id)?.status || "",
      reason: r.reason || "",
    }));
    const total = rows.reduce((s, r) => s + r.amount, 0);
    return { range: { from, to }, total: r2(total), count: rows.length, rows };
  });
registerFn('getRefundsReport', getRefundsReport);

/* ───────── List Z-Reports (closed + open shifts) ───────── */
export const listZReports = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ limit: z.number().int().min(1).max(200).default(50), include_open: z.boolean().default(true) }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await assertReportAccess(context.userId);
    let q = supabaseAdmin.from("shifts").select("*").order("opened_at", { ascending: false }).limit(data.limit);
    if (!data.include_open) q = q.eq("status", "closed");
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const nameMap = await loadCashierNames((rows ?? []).map((r: any) => r.cashier_id));
    return (rows ?? []).map((r: any) => ({ ...r, cashier_name: nameMap.get(r.cashier_id) || "" }));
  });
registerFn('listZReports', listZReports);

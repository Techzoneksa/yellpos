// POS: orders, payments, invoices, refunds, recent orders, customers.
import { createServerFn, registerFn, requireSupabaseAuth } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deductOrderInventory } from "./ops.server";
import { logAudit } from "@/lib/audit.server";
import { generateZatcaForInvoice, generateZatcaForRefund } from "@/lib/zatca.server";

async function ensureAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["owner", "manager"]);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Forbidden");
}

const itemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(99),
  notes: z.string().max(200).optional(),
  addon_ids: z.array(z.string().uuid()).max(20).default([]),
});
const paymentSchema = z.object({
  method: z.enum(["cash", "card", "mada", "apple_pay", "visa", "mastercard", "mixed"]),
  amount: z.number(),
  reference: z.string().max(80).optional(),
});

/* ─────── Create order (transactional) ─────── */
export const createOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        order_type: z.enum(["dine_in", "takeaway", "delivery_app"]).default("dine_in"),
        customer_id: z.string().uuid().nullable().optional(),
        notes: z.string().max(500).optional(),
        discount: z.number().min(0).default(0),
        items: z.array(itemSchema).min(1).max(100),
        payments: z.array(paymentSchema).min(1).max(5),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    // Must have open shift
    const { data: shift, error: sErr } = await supabaseAdmin
      .from("shifts")
      .select("id")
      .eq("cashier_id", context.userId)
      .eq("status", "open")
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!shift) throw new Error("Open a shift before creating orders");

    // Load products + addons referenced
    const productIds = Array.from(new Set(data.items.map((i: any) => i.product_id)));
    const addonIds = Array.from(new Set(data.items.flatMap((i: any) => i.addon_ids)));
    const [{ data: products, error: pErr }, addonRes] = await Promise.all([
      supabaseAdmin
        .from("products")
        .select("id, name_ar, price, tax_rate, active")
        .in("id", productIds as any),
      addonIds.length
        ? supabaseAdmin.from("addons").select("id, name_ar, price_delta, active").in("id", addonIds as any)
        : Promise.resolve({ data: [] as any[], error: null }),
    ]);
    if (pErr) throw new Error(pErr.message);
    if (addonRes.error) throw new Error(addonRes.error.message);

    // Map constructor can't infer tuple types from .map() — cast entries explicitly
    const pMap = new Map((products ?? []).map((p) => [p.id, p] as [string, typeof p]));
    const aMap = new Map((addonRes.data ?? []).map((a) => [a.id, a] as [string, any]));

    // Compute totals server-side — PRICES ARE VAT-INCLUSIVE
    let subtotalBeforeDiscount = 0;
    const itemRows: any[] = [];
    const itemAddonRows: { idx: number; addon: any }[] = [];

    for (let i = 0; i < data.items.length; i++) {
      const it = data.items[i];
      const p = pMap.get(it.product_id);
      if (!p || !p.active) throw new Error("Product unavailable");
      const addonSum = it.addon_ids.reduce((s: number, id: any) => {
        const a = aMap.get(id);
        if (!a) throw new Error("Addon unavailable");
        return s + Number(a.price_delta);
      }, 0);
      const unitInclVat = Number(p.price) + addonSum; // VAT-inclusive
      const lineInclVat = unitInclVat * it.quantity;
      subtotalBeforeDiscount += lineInclVat;
      itemRows.push({
        product_id: p.id,
        name_snapshot: p.name_ar,
        unit_price: unitInclVat,
        quantity: it.quantity,
        line_total: lineInclVat,
        notes: it.notes ?? null,
      });
      for (const aid of it.addon_ids) {
        const a = aMap.get(aid)!;
        itemAddonRows.push({ idx: i, addon: a });
      }
    }
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const discountAmount = Math.min(data.discount, subtotalBeforeDiscount);
    const totalIncludingVat = round2(subtotalBeforeDiscount - discountAmount);
    const vatRate = 0.15;
    const netAmountExcludingVat = round2(totalIncludingVat / (1 + vatRate));
    const vatIncludedAmount = round2(totalIncludingVat - netAmountExcludingVat);

    // Verify payments cover total
    const paid = data.payments.reduce((s: number, p: any) => s + p.amount, 0);
    if (Math.abs(paid - totalIncludingVat) > 0.01)
      throw new Error(`Payment ${paid.toFixed(2)} ≠ total ${totalIncludingVat.toFixed(2)}`);

    // Insert order (VAT-INCLUSIVE columns)
    const { data: order, error: oErr } = await supabaseAdmin
      .from("orders")
      .insert({
        shift_id: shift.id,
        cashier_id: context.userId,
        customer_id: data.customer_id ?? null,
        order_type: data.order_type,
        status: "new",
        subtotal_before_discount: round2(subtotalBeforeDiscount),
        discount_amount: round2(discountAmount),
        total_including_vat: totalIncludingVat,
        vat_included_amount: vatIncludedAmount,
        net_amount_excluding_vat: netAmountExcludingVat,
        vat_rate: vatRate,
        notes: data.notes ?? null,
      })
      .select("*")
      .single();
    if (oErr) throw new Error(oErr.message);

    // Items
    const itemsToInsert = itemRows.map((r) => ({ ...r, order_id: order.id }));
    const { data: insertedItems, error: iErr } = await supabaseAdmin
      .from("order_items")
      .insert(itemsToInsert)
      .select("id");
    if (iErr) throw new Error(iErr.message);

    // Addons (map idx → inserted item id)
    if (itemAddonRows.length) {
      const oiaRows = itemAddonRows.map(({ idx, addon }) => ({
        order_item_id: insertedItems![idx].id,
        addon_id: addon.id,
        name_snapshot: addon.name_ar,
        price_delta_snapshot: addon.price_delta,
      }));
      const { error: aErr } = await supabaseAdmin.from("order_item_addons").insert(oiaRows);
      if (aErr) throw new Error(aErr.message);
    }

    // Payments
    const payRows = data.payments.map((p: any) => ({
      order_id: order.id,
      method: p.method,
      amount: p.amount,
      reference: p.reference ?? null,
    }));
    const { error: payErr } = await supabaseAdmin.from("payments").insert(payRows);
    if (payErr) throw new Error(payErr.message);

    // Invoice
    const { data: invoice, error: invErr } = await supabaseAdmin
      .from("invoices")
      .insert({ order_id: order.id })
      .select("*")
      .single();
    if (invErr) throw new Error(invErr.message);

    // Mark order completed (payment + invoice already persisted)
    const { data: completedOrder, error: cErr } = await supabaseAdmin
      .from("orders")
      .update({ status: "completed" })
      .eq("id", order.id)
      .select("*")
      .single();
    if (cErr) throw new Error(cErr.message);

    // Non-blocking inventory deduction based on recipes
    try {
      await deductOrderInventory(
        order.id,
        data.items.map((it: any) => ({ product_id: it.product_id, quantity: it.quantity })),
      );
    } catch (e) {
      console.error("inventory deduction failed", e);
    }

    // Non-blocking ZATCA generation (TLV QR + XML skeleton; submission is
    // gated until device onboarding completes). Never throws.
    try {
      await generateZatcaForInvoice((invoice as any).id);
    } catch (e) {
      console.error("zatca generation failed", e);
    }

    await logAudit({
      userId: context.userId,
      action: "order.create",
      entityType: "order",
      entityId: order.id,
      newValue: {
        order_number: completedOrder.order_number,
        invoice_number: (invoice as any)?.invoice_number ?? null,
        total: (completedOrder as any).total_including_vat,
        order_type: (completedOrder as any).order_type,
        items: data.items.length,
      },
    });
    return { order: completedOrder, invoice };
  });
registerFn('createOrder', createOrder);

/* ─────── Update order status ─────── */
export const updateOrderStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        order_id: z.string().uuid(),
        status: z.enum(["new", "preparing", "ready", "completed", "cancelled"]),
      })
      .parse(i),
  )
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin
      .from("orders")
      .update({ status: data.status })
      .eq("id", data.order_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('updateOrderStatus', updateOrderStatus);

/* ─────── Recent orders with filters: q (order_number / invoice_number), today, shiftOnly ─────── */
export const listRecentOrders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        q: z.string().trim().max(80).optional(),
        today: z.boolean().default(false),
        shiftOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    // Role-based scope: cashiers only see their own orders.
    const { data: rolesRows } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    const roles = (rolesRows ?? []).map((r: any) => r.role);
    const canSeeAll =
      roles.includes("owner") || roles.includes("manager") || roles.includes("finance");

    // If query looks like an invoice number, resolve order_id via invoices first
    let orderIdFromInvoice: string | null = null;
    if (data.q && /^INV-/i.test(data.q)) {
      const { data: inv } = await supabaseAdmin
        .from("invoices")
        .select("order_id")
        .ilike("invoice_number", `%${data.q}%`)
        .maybeSingle();
      orderIdFromInvoice = inv?.order_id ?? null;
      if (!orderIdFromInvoice) return [];
    }

    let query = supabaseAdmin
      .from("orders")
      .select(
        `
        id, order_number, order_type, status,
        subtotal_before_discount, discount_amount, total_including_vat,
        vat_included_amount, net_amount_excluding_vat, vat_rate,
        created_at, cashier_id, customer_id
      `,
      )
      .order("created_at", { ascending: false })
      .range(data.offset, data.offset + data.limit - 1);

    if (!canSeeAll) {
      query = query.eq("cashier_id", context.userId);
    }


    if (data.shiftOnly) {
      const { data: shift } = await supabaseAdmin
        .from("shifts")
        .select("id")
        .eq("cashier_id", context.userId)
        .eq("status", "open")
        .maybeSingle();
      if (!shift) return [];
      query = query.eq("shift_id", shift.id);
    }
    if (data.today) {
      const now = new Date();
      const riyadhOffsetMs = 3 * 60 * 60 * 1000;
      const startLocal = new Date(now.getTime() + riyadhOffsetMs);
      startLocal.setUTCHours(0, 0, 0, 0);
      const startUtc = new Date(startLocal.getTime() - riyadhOffsetMs);
      query = query.gte("created_at", startUtc.toISOString());
    }
    if (orderIdFromInvoice) {
      query = query.eq("id", orderIdFromInvoice);
    } else if (data.q) {
      query = query.ilike("order_number", `%${data.q}%`);
    }
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);

    const orderIds = (rows ?? []).map((r: any) => r.id);
    const cashierIds = Array.from(
      new Set((rows ?? []).map((r: any) => r.cashier_id).filter(Boolean)),
    );
    const customerIds = Array.from(
      new Set((rows ?? []).map((r: any) => r.customer_id).filter(Boolean)),
    );

    const [invR, payR, profR, custR] = await Promise.all([
      orderIds.length
        ? supabaseAdmin.from("invoices").select("order_id, invoice_number").in("order_id", orderIds)
        : Promise.resolve({ data: [] as any[] }),
      orderIds.length
        ? supabaseAdmin.from("payments").select("order_id, method, amount").in("order_id", orderIds)
        : Promise.resolve({ data: [] as any[] }),
      cashierIds.length
        ? supabaseAdmin.from("profiles").select("id, full_name, username").in("id", cashierIds)
        : Promise.resolve({ data: [] as any[] }),
      customerIds.length
        ? supabaseAdmin.from("customers").select("id, phone, name").in("id", customerIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const invMap = new Map((invR.data ?? []).map((i: any) => [i.order_id, i.invoice_number]));
    const payMap = new Map<string, { method: string; amount: number }[]>();
    for (const p of (payR.data ?? []) as any[]) {
      const arr = payMap.get(p.order_id) ?? [];
      arr.push({ method: p.method, amount: Number(p.amount) });
      payMap.set(p.order_id, arr);
    }
    const nameMap = new Map(
      (profR.data ?? []).map((p: any) => [p.id, p.full_name || p.username || ""]),
    );
    const custMap = new Map((custR.data ?? []).map((c: any) => [c.id, c]));

    return (rows ?? []).map((r: any) => {
      const pays = payMap.get(r.id) ?? [];
      const positive = pays.filter((p) => p.amount > 0);
      const primaryMethod = positive.length > 1 ? "mixed" : (positive[0]?.method ?? null);
      const cust = r.customer_id ? custMap.get(r.customer_id) : null;
      return {
        ...r,
        invoice_number: invMap.get(r.id) ?? null,
        payment_method: primaryMethod,
        cashier_name: nameMap.get(r.cashier_id) || "",
        customer_phone: cust?.phone ?? null,
        customer_name: cust?.name ?? null,
      };
    });
  });
registerFn('listRecentOrders', listRecentOrders);

/* ─────── Get full order (items, addons, payments, invoice) ─────── */
export const getOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ order_id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const [orderR, itemsR, payR, invR, refundsR, rolesR] = await Promise.all([
      supabaseAdmin.from("orders").select("*").eq("id", data.order_id).single(),
      supabaseAdmin.from("order_items").select("*").eq("order_id", data.order_id),
      supabaseAdmin
        .from("payments")
        .select("*")
        .eq("order_id", data.order_id)
        .order("paid_at", { ascending: true }),
      supabaseAdmin.from("invoices").select("*").eq("order_id", data.order_id).maybeSingle(),
      supabaseAdmin.from("refunds").select("amount").eq("order_id", data.order_id),
      supabaseAdmin.from("user_roles").select("role").eq("user_id", context.userId),
    ]);
    const roles = (rolesR.data ?? []).map((r: any) => r.role);
    const canSeeAll =
      roles.includes("owner") || roles.includes("manager") || roles.includes("finance");
    if (!canSeeAll && orderR.data?.cashier_id !== context.userId) {
      throw new Error("Forbidden");
    }
    if (orderR.error) throw new Error(orderR.error.message);
    if (itemsR.error) throw new Error(itemsR.error.message);
    if (payR.error) throw new Error(payR.error.message);
    if (invR.error) throw new Error(invR.error.message);
    if (refundsR.error) throw new Error(refundsR.error.message);
    const refundedAmount = (refundsR.data ?? []).reduce(
      (sum: number, r: any) => sum + Number(r.amount),
      0,
    );
    const itemIds = (itemsR.data ?? []).map((it: any) => it.id);
    const [{ data: addons }, { data: refundItems, error: refundItemsErr }] = itemIds.length
      ? await Promise.all([
          supabaseAdmin.from("order_item_addons").select("*").in("order_item_id", itemIds),
          supabaseAdmin
            .from("refund_items")
            .select("order_item_id, quantity")
            .in("order_item_id", itemIds),
        ])
      : [{ data: [] as any[] }, { data: [] as any[], error: null }];
    if (refundItemsErr) throw new Error(refundItemsErr.message);
    const addonsByItem = new Map<string, any[]>();
    for (const a of (addons ?? []) as any[]) {
      const arr = addonsByItem.get(a.order_item_id) ?? [];
      arr.push(a);
      addonsByItem.set(a.order_item_id, arr);
    }
    const refundedQtyByItem = new Map<string, number>();
    for (const ri of (refundItems ?? []) as any[]) {
      refundedQtyByItem.set(
        ri.order_item_id,
        (refundedQtyByItem.get(ri.order_item_id) ?? 0) + Number(ri.quantity),
      );
    }
    const items = (itemsR.data ?? []).map((it: any) => ({
      ...it,
      addons: addonsByItem.get(it.id) ?? [],
      already_refunded_quantity: refundedQtyByItem.get(it.id) ?? 0,
      remaining_refundable_quantity: Math.max(
        0,
        Number(it.quantity) - (refundedQtyByItem.get(it.id) ?? 0),
      ),
    }));
    let customer: any = null;
    if (orderR.data?.customer_id) {
      const { data: c } = await supabaseAdmin
        .from("customers")
        .select("*")
        .eq("id", orderR.data.customer_id)
        .maybeSingle();
      customer = c;
    }
    let cashierName = "";
    if (orderR.data?.cashier_id) {
      const { data: prof } = await supabaseAdmin
        .from("profiles")
        .select("full_name, username")
        .eq("id", orderR.data.cashier_id)
        .maybeSingle();
      cashierName = prof?.full_name || prof?.username || "";
    }
    return {
      order: orderR.data,
      items,
      payments: payR.data ?? [],
      invoice: invR.data,
      customer,
      cashier_name: cashierName,
      refund_summary: {
        already_refunded_amount: Math.round(refundedAmount * 100) / 100,
        remaining_refundable_amount: Math.max(
          0,
          Math.round((Number(orderR.data.total_including_vat) - refundedAmount) * 100) / 100,
        ),
      },
    };
  });
registerFn('getOrder', getOrder);

/* ─────── Customers ─────── */
export const findCustomerByPhone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ phone: z.string().min(3).max(20) }).parse(i))
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("customers")
      .select("*")
      .eq("phone", data.phone)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row;
  });
registerFn('findCustomerByPhone', findCustomerByPhone);

// Find by phone, create if not found. Used by POS quick-add.
export const findOrCreateCustomerByPhone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      phone: z.string().trim().min(3).max(20).regex(/^[+0-9\s-]+$/, "Invalid phone"),
      name: z.string().max(120).optional(),
    }).parse(i),
  )
  .handler(async ({ data }) => {
    const phone = data.phone.replace(/\s+/g, "");
    const { data: existing } = await supabaseAdmin
      .from("customers")
      .select("*")
      .eq("phone", phone)
      .maybeSingle();
    if (existing) return existing;
    const { data: row, error } = await supabaseAdmin
      .from("customers")
      .insert({ phone, name: data.name?.trim() || phone })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });
registerFn('findOrCreateCustomerByPhone', findOrCreateCustomerByPhone);

export const listCustomers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      q: z.string().trim().max(80).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }).parse(i),
  )
  .handler(async ({ data }) => {
    let q = supabaseAdmin.from("customers").select("*").order("created_at", { ascending: false }).limit(data.limit);
    if (data.q) {
      q = q.or(`phone.ilike.%${data.q}%,name.ilike.%${data.q}%`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
registerFn('listCustomers', listCustomers);

export const upsertCustomer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(120),
        phone: z.string().min(3).max(20).nullable().optional(),
        notes: z.string().max(500).nullable().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("customers")
      .upsert(data)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });
registerFn('upsertCustomer', upsertCustomer);

/* ─────── Refunds (cashier may refund own orders; admin sees all) ─────── */
export const createRefund = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        order_id: z.string().uuid(),
        reason: z.string().max(500).optional(),
        type: z.enum(["full", "partial"]),
        payment_method: z.enum([
          "cash",
          "card",
          "mada",
          "apple_pay",
          "visa",
          "mastercard",
          "mixed",
        ]),
        items: z
          .array(
            z.object({
              order_item_id: z.string().uuid(),
              quantity: z.number().int().min(1),
            }),
          )
          .default([]),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    // Load order + items
    const { data: order, error: oErr } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("id", data.order_id)
      .single();
    if (oErr || !order) throw new Error("Order not found");

    // Cashier may refund only own orders; admins may refund any
    const isOwn = order.cashier_id === context.userId;
    if (!isOwn) await ensureAdmin(context.userId);

    if (order.status === "refunded" || order.status === "cancelled")
      throw new Error("Order already fully refunded");

    let amount = 0;
    const refundItemRows: { order_item_id: string; quantity: number; amount: number }[] = [];

    const { data: items, error: iErr } = await supabaseAdmin
      .from("order_items")
      .select("id, quantity, unit_price")
      .eq("order_id", data.order_id);
    if (iErr) throw new Error(iErr.message);

    const orderItems = items ?? [];
    const itemIds = orderItems.map((it) => it.id);
    const { data: previousRefundItems, error: priErr } = itemIds.length
      ? await supabaseAdmin
          .from("refund_items")
          .select("order_item_id, quantity")
          .in("order_item_id", itemIds)
      : { data: [] as any[], error: null };
    if (priErr) throw new Error(priErr.message);

    const refundedQtyByItem = new Map<string, number>();
    for (const ri of (previousRefundItems ?? []) as any[]) {
      refundedQtyByItem.set(
        ri.order_item_id,
        (refundedQtyByItem.get(ri.order_item_id) ?? 0) + Number(ri.quantity),
      );
    }
    const map = new Map(orderItems.map((it) => [it.id, it]));
    const remainingQty = (it: any) =>
      Math.max(0, Number(it.quantity) - (refundedQtyByItem.get(it.id) ?? 0));

    if (data.type === "full") {
      for (const it of orderItems) {
        const remaining = remainingQty(it);
        if (remaining <= 0) continue;
        const line = Number(it.unit_price) * remaining;
        amount += line;
        refundItemRows.push({
          order_item_id: it.id,
          quantity: remaining,
          amount: Math.round(line * 100) / 100,
        });
      }
      amount = Math.round(amount * 100) / 100;
      if (amount <= 0) throw new Error("No remaining quantity available to refund");
    } else {
      if (!data.items.length) throw new Error("Select items to refund");
      const requestedQtyByItem = new Map<string, number>();
      for (const sel of data.items) {
        requestedQtyByItem.set(
          sel.order_item_id,
          (requestedQtyByItem.get(sel.order_item_id) ?? 0) + sel.quantity,
        );
      }
      for (const [orderItemId, requestedQuantity] of requestedQtyByItem) {
        const it = map.get(orderItemId);
        if (!it) throw new Error("Item not in order");
        const remaining = remainingQty(it);
        if (requestedQuantity > remaining) {
          throw new Error(
            `Refund quantity exceeds remaining refundable quantity. Remaining quantity: ${remaining}`,
          );
        }
        const line = Number(it.unit_price) * requestedQuantity;
        amount += line;
        refundItemRows.push({
          order_item_id: orderItemId,
          quantity: requestedQuantity,
          amount: Math.round(line * 100) / 100,
        });
      }
      amount = Math.round(amount * 100) / 100;
      if (amount <= 0) throw new Error("Refund amount must be > 0");
    }

    // Resolve invoice_number snapshot
    const { data: inv } = await supabaseAdmin
      .from("invoices")
      .select("invoice_number")
      .eq("order_id", data.order_id)
      .maybeSingle();

    // Insert refund
    const { data: refund, error } = await supabaseAdmin
      .from("refunds")
      .insert({
        order_id: data.order_id,
        cashier_id: context.userId,
        reason: data.reason ?? null,
        type: data.type,
        amount,
        payment_method: data.payment_method,
        invoice_number: inv?.invoice_number ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    if (refundItemRows.length) {
      const rows = refundItemRows.map((it) => ({ ...it, refund_id: refund.id }));
      const { error: rErr } = await supabaseAdmin.from("refund_items").insert(rows);
      if (rErr) throw new Error(rErr.message);
    }

    // Negative payment row (same method)
    const { error: pErr } = await supabaseAdmin.from("payments").insert({
      order_id: data.order_id,
      method: data.payment_method,
      amount: -amount,
      reference: `REFUND:${refund.id}`,
    });
    if (pErr) throw new Error(pErr.message);

    // Update order status
    const allRemainingRefunded = orderItems.every((it) => {
      const requested = refundItemRows.find((r) => r.order_item_id === it.id)?.quantity ?? 0;
      return requested >= remainingQty(it);
    });
    const newStatus = allRemainingRefunded ? "refunded" : "partially_refunded";
    const { error: statusErr } = await supabaseAdmin
      .from("orders")
      .update({ status: newStatus })
      .eq("id", data.order_id);
    if (statusErr) throw new Error(statusErr.message);

    await logAudit({
      userId: context.userId,
      action: "refund.create",
      entityType: "refund",
      entityId: refund.id,
      newValue: {
        order_id: data.order_id,
        amount: (refund as any).amount,
        reason: (refund as any).reason ?? null,
        new_order_status: newStatus,
      },
    });
    try {
      await generateZatcaForRefund((refund as any).id);
    } catch (e) {
      console.error("zatca credit-note generation failed", e);
    }
    return refund;
  });
registerFn('createRefund', createRefund);

export const listRefunds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ limit: z.number().int().min(1).max(200).default(50) }).parse(i))
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabaseAdmin
      .from("refunds")
      .select("*")
      .order("refunded_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    const orderIds = Array.from(new Set((rows ?? []).map((r: any) => r.order_id).filter(Boolean)));
    const cashierIds = Array.from(
      new Set((rows ?? []).map((r: any) => r.cashier_id).filter(Boolean)),
    );
    const [ordR, profR] = await Promise.all([
      orderIds.length
        ? supabaseAdmin
            .from("orders")
            .select("id, order_number, total_including_vat")
            .in("id", orderIds)
        : Promise.resolve({ data: [] as any[] }),
      cashierIds.length
        ? supabaseAdmin.from("profiles").select("id, full_name, username").in("id", cashierIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const ordMap = new Map((ordR.data ?? []).map((o: any) => [o.id, o]));
    const nameMap = new Map(
      (profR.data ?? []).map((p: any) => [p.id, p.full_name || p.username || ""]),
    );
    return (rows ?? []).map((r: any) => ({
      ...r,
      order_number: ordMap.get(r.order_id)?.order_number ?? null,
      order_total: ordMap.get(r.order_id)?.total_including_vat ?? null,
      cashier_name: nameMap.get(r.cashier_id) || "",
    }));
  });
registerFn('listRefunds', listRefunds);

/* ─────── Held orders ─────── */
export const holdOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        order_type: z.enum(["dine_in", "takeaway", "delivery_app"]).default("dine_in"),
        customer_id: z.string().uuid().nullable().optional(),
        note: z.string().max(500).optional(),
        cart: z.any(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: shift } = await supabaseAdmin
      .from("shifts")
      .select("id")
      .eq("cashier_id", context.userId)
      .eq("status", "open")
      .maybeSingle();
    const { data: row, error } = await supabaseAdmin
      .from("held_orders")
      .insert({
        cashier_id: context.userId,
        shift_id: shift?.id ?? null,
        customer_id: data.customer_id ?? null,
        order_type: data.order_type,
        cart_json: data.cart,
        note: data.note ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });
registerFn('holdOrder', holdOrder);

export const listHeldOrders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(() => ({}))
  .handler(async ({ context }) => {
    const { data, error } = await supabaseAdmin
      .from("held_orders")
      .select("*")
      .eq("cashier_id", context.userId)
      .order("held_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });
registerFn('listHeldOrders', listHeldOrders);

export const resumeHeldOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await supabaseAdmin
      .from("held_orders")
      .select("*")
      .eq("id", data.id)
      .eq("cashier_id", context.userId)
      .single();
    if (error || !row) throw new Error("Held order not found");
    await supabaseAdmin.from("held_orders").delete().eq("id", data.id);
    return row;
  });
registerFn('resumeHeldOrder', resumeHeldOrder);

export const discardHeldOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { error } = await supabaseAdmin
      .from("held_orders")
      .delete()
      .eq("id", data.id)
      .eq("cashier_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('discardHeldOrder', discardHeldOrder);

/* ─────── Cash drawer movements ─────── */
export const recordCashMovement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        type: z.enum(["pay_in", "pay_out"]),
        amount: z.number().positive(),
        reason: z.string().max(300).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: shift } = await supabaseAdmin
      .from("shifts")
      .select("id")
      .eq("cashier_id", context.userId)
      .eq("status", "open")
      .maybeSingle();
    if (!shift) throw new Error("Open a shift first");
    const { data: row, error } = await supabaseAdmin
      .from("cash_drawer_movements")
      .insert({
        shift_id: shift.id,
        cashier_id: context.userId,
        type: data.type,
        amount: data.amount,
        reason: data.reason ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    await logAudit({
      userId: context.userId,
      action: data.type === "pay_in" ? "cash.pay_in" : "cash.pay_out",
      entityType: "cash_drawer_movement",
      entityId: row.id,
      newValue: { shift_id: shift.id, amount: data.amount, reason: data.reason ?? null },
    });
    return row;
  });
registerFn('recordCashMovement', recordCashMovement);

export const listCashMovements = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ shift_id: z.string().uuid().optional() }).parse(i))
  .handler(async ({ data, context }) => {
    let q = supabaseAdmin
      .from("cash_drawer_movements")
      .select("*")
      .order("occurred_at", { ascending: false });
    if (data.shift_id) {
      q = q.eq("shift_id", data.shift_id);
    } else {
      const { data: shift } = await supabaseAdmin
        .from("shifts")
        .select("id")
        .eq("cashier_id", context.userId)
        .eq("status", "open")
        .maybeSingle();
      if (!shift) return [];
      q = q.eq("shift_id", shift.id);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
registerFn('listCashMovements', listCashMovements);

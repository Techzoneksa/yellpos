// Shifts: open/close, get current open shift, list shifts.
import { createServerFn, registerFn, requireSupabaseAuth } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logAudit } from "@/lib/audit.server";

export const getOpenShift = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await supabaseAdmin
      .from("shifts")
      .select("*")
      .eq("cashier_id", context.userId)
      .eq("status", "open")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });
registerFn('getOpenShift', getOpenShift);

export const openShift = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        opening_float: z.number().min(0).default(0),
        notes: z.string().max(500).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    // Block if already open
    const { data: existing } = await supabaseAdmin
      .from("shifts")
      .select("id")
      .eq("cashier_id", context.userId)
      .eq("status", "open")
      .maybeSingle();
    if (existing) throw new Error("You already have an open shift");

    const { data: inserted, error } = await supabaseAdmin
      .from("shifts")
      .insert({
        cashier_id: context.userId,
        opening_float: data.opening_float,
        notes: data.notes ?? null,
        status: "open",
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    await logAudit({
      userId: context.userId,
      action: "shift.open",
      entityType: "shift",
      entityId: inserted.id,
      newValue: { opening_float: data.opening_float, notes: data.notes ?? null },
    });
    return inserted;
  });
registerFn('openShift', openShift);

export const closeShift = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        shift_id: z.string().uuid(),
        closing_cash: z.number().min(0),
        notes: z.string().max(500).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    // Load shift
    const { data: shift, error: sErr } = await supabaseAdmin
      .from("shifts")
      .select("*")
      .eq("id", data.shift_id)
      .single();
    if (sErr) throw new Error(sErr.message);
    if (shift.cashier_id !== context.userId) {
      // allow admins to close any
      const { data: roles } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", context.userId)
        .in("role", ["owner", "manager"]);
      if (!roles || roles.length === 0) throw new Error("Forbidden");
    }
    if (shift.status === "closed") throw new Error("Shift already closed");

    // Expected cash = opening_float
    //               + Σ cash payments (positive)
    //               − Σ cash refunds (cash payment.amount < 0 already accounts for refunds)
    //               + Σ pay_in − Σ pay_out (cash drawer movements)
    const { data: orders } = await supabaseAdmin
      .from("orders")
      .select("id")
      .eq("shift_id", data.shift_id);
    const orderIds = (orders ?? []).map((o) => o.id);

    let cashNet = 0;
    if (orderIds.length) {
      const { data: pays } = await supabaseAdmin
        .from("payments")
        .select("amount, method")
        .in("order_id", orderIds);
      for (const p of pays ?? []) {
        if (p.method === "cash") cashNet += Number(p.amount); // negative for refunds
      }
    }

    let movementsNet = 0;
    const { data: movs } = await supabaseAdmin
      .from("cash_drawer_movements")
      .select("type, amount")
      .eq("shift_id", data.shift_id);
    for (const m of movs ?? []) {
      movementsNet += (m.type === "pay_in" ? 1 : -1) * Number(m.amount);
    }

    const expected = Number(shift.opening_float) + cashNet + movementsNet;
    const variance = data.closing_cash - expected;

    const { data: updated, error } = await supabaseAdmin
      .from("shifts")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        closing_cash: data.closing_cash,
        expected_cash: expected,
        variance,
        notes: data.notes ?? shift.notes,
      })
      .eq("id", data.shift_id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    await logAudit({
      userId: context.userId,
      action: "shift.close",
      entityType: "shift",
      entityId: data.shift_id,
      newValue: {
        closing_cash: data.closing_cash,
        expected_cash: expected,
        variance,
        notes: data.notes ?? null,
      },
    });
    return updated;
  });
registerFn('closeShift', closeShift);

export const getShiftSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ shift_id: z.string().uuid().optional() }).parse(i))
  .handler(async ({ data, context }) => {
    let shiftQuery = supabaseAdmin.from("shifts").select("*");
    shiftQuery = data.shift_id
      ? shiftQuery.eq("id", data.shift_id)
      : shiftQuery.eq("cashier_id", context.userId).eq("status", "open");

    const { data: shift, error: sErr } = await shiftQuery.maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!shift) throw new Error("Open shift not found");
    if (shift.cashier_id !== context.userId) {
      const { data: roles } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", context.userId)
        .in("role", ["owner", "manager"]);
      if (!roles || roles.length === 0) throw new Error("Forbidden");
    }

    const { data: orders, error: oErr } = await supabaseAdmin
      .from("orders")
      .select("id, discount_amount")
      .eq("shift_id", shift.id);
    if (oErr) throw new Error(oErr.message);
    const orderIds = (orders ?? []).map((o) => o.id);

    const byMethod: Record<string, number> = {
      cash: 0,
      card: 0,
      mada: 0,
      apple_pay: 0,
      visa: 0,
      mastercard: 0,
      mixed: 0,
    };
    let cashRefunds = 0;
    let totalRefunds = 0;
    if (orderIds.length) {
      const { data: pays, error: pErr } = await supabaseAdmin
        .from("payments")
        .select("amount, method")
        .in("order_id", orderIds);
      if (pErr) throw new Error(pErr.message);
      for (const p of pays ?? []) {
        const amount = Number(p.amount);
        if (amount >= 0) byMethod[p.method] = (byMethod[p.method] ?? 0) + amount;
        else {
          totalRefunds += Math.abs(amount);
          if (p.method === "cash") cashRefunds += Math.abs(amount);
        }
      }
    }

    let cashAdditions = 0;
    let cashExpenses = 0;
    const { data: movs, error: mErr } = await supabaseAdmin
      .from("cash_drawer_movements")
      .select("type, amount")
      .eq("shift_id", shift.id);
    if (mErr) throw new Error(mErr.message);
    for (const m of movs ?? []) {
      if (m.type === "pay_in") cashAdditions += Number(m.amount);
      if (m.type === "pay_out") cashExpenses += Number(m.amount);
    }

    const discounts = (orders ?? []).reduce((sum, o) => sum + Number(o.discount_amount), 0);
    const expected =
      Number(shift.opening_float) + byMethod.cash - cashRefunds + cashAdditions - cashExpenses;
    return {
      shift,
      openingCash: Number(shift.opening_float),
      cashSales: Math.round(byMethod.cash * 100) / 100,
      cashRefunds: Math.round(cashRefunds * 100) / 100,
      cashExpenses: Math.round(cashExpenses * 100) / 100,
      cashAdditions: Math.round(cashAdditions * 100) / 100,
      expected: Math.round(expected * 100) / 100,
      mada: Math.round(byMethod.mada * 100) / 100,
      apple: Math.round(byMethod.apple_pay * 100) / 100,
      visa: Math.round((byMethod.visa + byMethod.mastercard + byMethod.card) * 100) / 100,
      refunded: Math.round(totalRefunds * 100) / 100,
      discounts: Math.round(discounts * 100) / 100,
      net:
        Math.round((Object.values(byMethod).reduce((sum, n) => sum + n, 0) - totalRefunds) * 100) /
        100,
    };
  });
registerFn('getShiftSummary', getShiftSummary);

export const listShifts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ limit: z.number().int().min(1).max(200).default(50) }).parse(i))
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabaseAdmin
      .from("shifts")
      .select("*")
      .order("opened_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    const cashierIds = Array.from(
      new Set((rows ?? []).map((r: any) => r.cashier_id).filter(Boolean)),
    );
    const { data: profs } = cashierIds.length
      ? await supabaseAdmin.from("profiles").select("id, full_name, username").in("id", cashierIds)
      : { data: [] as any[] };
    const nameMap = new Map(
      (profs ?? []).map((p: any) => [p.id, p.full_name || p.username || ""]),
    );
    return (rows ?? []).map((r: any) => ({
      ...r,
      cashier_name: nameMap.get(r.cashier_id) || "",
    }));
  });
registerFn('listShifts', listShifts);

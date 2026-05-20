// Sprint D — HR & payroll server functions (MVP).
// Schema (already migrated):
//   employees(id, name, job_title, mobile, monthly_salary, start_date, status, notes)
//   employee_adjustments(id, employee_id, kind: advance|deduction, amount, month, notes, created_by)
//   salary_records(id, employee_id, month, basic, advances, deductions, net,
//                  status: paid|partial|unpaid, paid_from_account_id, paid_at, paid_amount, notes)
import { createServerFn, registerFn, requireSupabaseAuth } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { postAccountMovement, riyadhMonth } from "@/lib/finance.server";
import { logAudit, tryPostJournal } from "@/lib/audit.server";

async function userRoles(userId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  return (data ?? []).map((r: any) => r.role);
}
async function ensureAdmin(userId: string) {
  const roles = await userRoles(userId);
  if (!roles.some((r) => r === "owner" || r === "manager")) throw new Error("Forbidden");
}
async function ensureAdminOrFinance(userId: string) {
  const roles = await userRoles(userId);
  if (!roles.some((r) => r === "owner" || r === "manager" || r === "finance"))
    throw new Error("Forbidden");
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/* ════════════════════════════════ EMPLOYEES ════════════════════════════════ */

export const listEmployees = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data, error } = await supabaseAdmin
      .from("employees")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });
registerFn('listEmployees', listEmployees);

export const upsertEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(150),
        job_title: z.string().min(1).max(120),
        mobile: z.string().max(30).nullable().optional(),
        monthly_salary: z.number().nonnegative(),
        start_date: z.string().optional(),
        status: z.enum(["active", "disabled"]).default("active"),
        notes: z.string().max(500).nullable().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const payload = {
      name: data.name,
      job_title: data.job_title,
      mobile: data.mobile ?? null,
      monthly_salary: data.monthly_salary,
      ...(data.start_date ? { start_date: data.start_date } : {}),
      status: data.status,
      notes: data.notes ?? null,
    };
    if (data.id) {
      const { data: updated, error } = await supabaseAdmin
        .from("employees")
        .update(payload)
        .eq("id", data.id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return updated;
    }
    const { data: inserted, error } = await supabaseAdmin
      .from("employees")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return inserted;
  });
registerFn('upsertEmployee', upsertEmployee);

export const setEmployeeStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ id: z.string().uuid(), status: z.enum(["active", "disabled"]) }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("employees")
      .update({ status: data.status })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('setEmployeeStatus', setEmployeeStatus);

/* ═════════════════════ EMPLOYEE ADJUSTMENTS (advance / deduction) ═════════════════════ */

export const listEmployeeAdjustments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        employee_id: z.string().uuid().optional(),
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    let q = supabaseAdmin
      .from("employee_adjustments")
      .select("*")
      .order("created_at", { ascending: false });
    if (data.employee_id) q = q.eq("employee_id", data.employee_id);
    if (data.month) q = q.eq("month", data.month);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
registerFn('listEmployeeAdjustments', listEmployeeAdjustments);

export const createEmployeeAdjustment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        employee_id: z.string().uuid(),
        month: z.string().regex(/^\d{4}-\d{2}$/),
        kind: z.enum(["advance", "deduction"]),
        amount: z.number().positive(),
        notes: z.string().max(300).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { data: row, error } = await supabaseAdmin
      .from("employee_adjustments")
      .insert({
        employee_id: data.employee_id,
        month: data.month,
        kind: data.kind,
        amount: data.amount,
        notes: data.notes ?? null,
        created_by: context.userId,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });
registerFn('createEmployeeAdjustment', createEmployeeAdjustment);

export const deleteEmployeeAdjustment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("employee_adjustments")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('deleteEmployeeAdjustment', deleteEmployeeAdjustment);

/* ════════════════════════════════ PAYROLL ════════════════════════════════ */

type AdjAcc = { advance: number; deduction: number };

async function buildAdjustmentMap(month: string, empIds: string[]): Promise<Map<string, AdjAcc>> {
  const map = new Map<string, AdjAcc>();
  if (!empIds.length) return map;
  const { data: adjs } = await supabaseAdmin
    .from("employee_adjustments")
    .select("*")
    .eq("month", month)
    .in("employee_id", empIds);
  for (const a of adjs ?? []) {
    const acc = map.get(a.employee_id) ?? { advance: 0, deduction: 0 };
    acc[a.kind as "advance" | "deduction"] += Number(a.amount);
    map.set(a.employee_id, acc);
  }
  return map;
}

/** Compute (without persisting) the payroll snapshot for a given month. */
export const previewPayroll = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const month = riyadhMonth(data.month);

    const { data: employees, error } = await supabaseAdmin
      .from("employees")
      .select("*")
      .eq("status", "active");
    if (error) throw new Error(error.message);

    const empIds = (employees ?? []).map((e) => e.id);
    const adjByEmp = await buildAdjustmentMap(month, empIds);

    const { data: existing } = await supabaseAdmin
      .from("salary_records")
      .select("employee_id, id, status")
      .eq("month", month);
    const existingByEmp = new Map<string, any>();
    for (const s of existing ?? []) existingByEmp.set(s.employee_id, s);

    const rows = (employees ?? []).map((e: any) => {
      const adj = adjByEmp.get(e.id) ?? { advance: 0, deduction: 0 };
      const basic = Number(e.monthly_salary);
      const net = basic - adj.advance - adj.deduction;
      return {
        employee_id: e.id,
        employee_name: e.name,
        job_title: e.job_title,
        basic: r2(basic),
        advances: r2(adj.advance),
        deductions: r2(adj.deduction),
        net: r2(net),
        existing_record_id: existingByEmp.get(e.id)?.id ?? null,
        existing_status: existingByEmp.get(e.id)?.status ?? null,
      };
    });

    return {
      month,
      rows,
      totals: {
        basic: r2(rows.reduce((s, r) => s + r.basic, 0)),
        advances: r2(rows.reduce((s, r) => s + r.advances, 0)),
        deductions: r2(rows.reduce((s, r) => s + r.deductions, 0)),
        net: r2(rows.reduce((s, r) => s + r.net, 0)),
      },
    };
  });
registerFn('previewPayroll', previewPayroll);

/** Create salary records (status=unpaid) for any active employee that doesn't already have one. */
export const generatePayroll = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const month = riyadhMonth(data.month);

    const { data: employees, error } = await supabaseAdmin
      .from("employees")
      .select("*")
      .eq("status", "active");
    if (error) throw new Error(error.message);
    const empIds = (employees ?? []).map((e) => e.id);

    const adjByEmp = await buildAdjustmentMap(month, empIds);

    const { data: existing } = await supabaseAdmin
      .from("salary_records")
      .select("employee_id")
      .eq("month", month);
    const existingIds = new Set((existing ?? []).map((s) => s.employee_id));

    const toInsert: any[] = [];
    for (const e of employees ?? []) {
      if (existingIds.has(e.id)) continue;
      const adj = adjByEmp.get(e.id) ?? { advance: 0, deduction: 0 };
      const basic = Number(e.monthly_salary);
      const net = basic - adj.advance - adj.deduction;
      toInsert.push({
        employee_id: e.id,
        month,
        basic,
        advances: adj.advance,
        deductions: adj.deduction,
        net,
        status: "unpaid",
      });
    }

    if (toInsert.length) {
      const { error: insErr } = await supabaseAdmin.from("salary_records").insert(toInsert);
      if (insErr) throw new Error(insErr.message);
    }
    return { created: toInsert.length, month };
  });
registerFn('generatePayroll', generatePayroll);

export const listSalaryRecords = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        employee_id: z.string().uuid().optional(),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    let q = supabaseAdmin
      .from("salary_records")
      .select("*")
      .order("month", { ascending: false });
    if (data.month) q = q.eq("month", data.month);
    if (data.employee_id) q = q.eq("employee_id", data.employee_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
registerFn('listSalaryRecords', listSalaryRecords);

/** Mark a salary record as paid (or partially paid) and post the cash-out movement. */
export const paySalaryRecord = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        id: z.string().uuid(),
        paid_from_account_id: z.string().uuid(),
        amount: z.number().positive(),
        notes: z.string().max(500).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const { data: rec, error } = await supabaseAdmin
      .from("salary_records")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    if (rec.status === "paid") throw new Error("Salary already fully paid");

    const prevPaid = Number(rec.paid_amount ?? 0);
    const net = Number(rec.net);
    const newPaid = prevPaid + data.amount;
    if (newPaid > net + 0.005) throw new Error("Amount exceeds net salary");
    const status: "paid" | "partial" = newPaid >= net - 0.005 ? "paid" : "partial";

    await postAccountMovement({
      account_id: data.paid_from_account_id,
      type: "salary",
      amount_out: data.amount,
      description: `Salary ${rec.month}`,
      reference: "salary",
      reference_id: rec.id,
      notes: data.notes ?? null,
      created_by: context.userId,
    });

    const { data: updated, error: uErr } = await supabaseAdmin
      .from("salary_records")
      .update({
        paid_amount: newPaid,
        paid_from_account_id: data.paid_from_account_id,
        paid_at: new Date().toISOString(),
        status,
      })
      .eq("id", data.id)
      .select("*")
      .single();
    if (uErr) throw new Error(uErr.message);

    // Best-effort auto-journal: Dr Salary Expense (6000), Cr Cash/Bank (1000)
    await tryPostJournal({
      description: `Salary ${rec.month} — record ${rec.id}`,
      source: "salary",
      debitAccountCode: "6000",
      creditAccountCode: "1000",
      amount: data.amount,
      createdBy: context.userId,
    });
    await logAudit({
      userId: context.userId,
      action: "salary.pay",
      entityType: "salary_record",
      entityId: rec.id,
      newValue: {
        month: rec.month,
        amount: data.amount,
        status,
        paid_from_account_id: data.paid_from_account_id,
      },
    });
    return updated;
  });
registerFn('paySalaryRecord', paySalaryRecord);

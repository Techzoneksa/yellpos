// Sprint D — Finance & accounting server functions.
// All endpoints are admin (owner/manager). Finance role gets read-only on most;
// expense / supplier-payment / journal create is admin-only for MVP.
import { createServerFn, registerFn, requireSupabaseAuth } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { postAccountMovement, postJournalEntry } from "@/lib/finance.server";
import { logAudit, tryPostJournal } from "@/lib/audit.server";

/* ───────── role helpers ───────── */
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

/* ════════════════════════════════════════════════════════════
   1. FINANCE ACCOUNTS (cashboxes / banks / network terminals)
   ════════════════════════════════════════════════════════════ */

export const listFinanceAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data, error } = await supabaseAdmin
      .from("finance_accounts")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });
registerFn('listFinanceAccounts', listFinanceAccounts);

export const upsertFinanceAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        id: z.string().uuid().optional(),
        name_en: z.string().min(1).max(120),
        name_ar: z.string().min(1).max(120),
        type: z.enum(["cashbox", "bank", "network"]),
        account_code: z.string().max(20).nullable().optional(),
        opening_balance: z.number().default(0),
        active: z.boolean().default(true),
        notes: z.string().max(500).nullable().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    if (data.id) {
      const { data: updated, error } = await supabaseAdmin
        .from("finance_accounts")
        .update({
          name_en: data.name_en,
          name_ar: data.name_ar,
          type: data.type,
          account_code: data.account_code ?? null,
          opening_balance: data.opening_balance,
          active: data.active,
          notes: data.notes ?? null,
        })
        .eq("id", data.id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return updated;
    }

    // create — seed balance with opening_balance and post an "opening" movement
    const { data: inserted, error } = await supabaseAdmin
      .from("finance_accounts")
      .insert({
        name_en: data.name_en,
        name_ar: data.name_ar,
        type: data.type,
        account_code: data.account_code ?? null,
        opening_balance: data.opening_balance,
        balance: data.opening_balance,
        active: data.active,
        notes: data.notes ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    if (data.opening_balance > 0) {
      await supabaseAdmin.from("account_movements").insert({
        account_id: inserted.id,
        type: "opening",
        amount_in: data.opening_balance,
        amount_out: 0,
        balance_after: data.opening_balance,
        description: "Opening balance",
        created_by: context.userId,
      });
    }
    return inserted;
  });
registerFn('upsertFinanceAccount', upsertFinanceAccount);

export const listAccountMovements = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        account_id: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(500).default(200),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    let q = supabaseAdmin
      .from("account_movements")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(data.limit);
    if (data.account_id) q = q.eq("account_id", data.account_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
registerFn('listAccountMovements', listAccountMovements);

export const transferBetweenAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        from_id: z.string().uuid(),
        to_id: z.string().uuid(),
        amount: z.number().positive(),
        notes: z.string().max(500).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    if (data.from_id === data.to_id) throw new Error("Source and destination must differ");

    await postAccountMovement({
      account_id: data.from_id,
      type: "transfer",
      amount_out: data.amount,
      description: "Transfer out",
      reference: "transfer",
      notes: data.notes ?? null,
      created_by: context.userId,
    });
    await postAccountMovement({
      account_id: data.to_id,
      type: "transfer",
      amount_in: data.amount,
      description: "Transfer in",
      reference: "transfer",
      notes: data.notes ?? null,
      created_by: context.userId,
    });
    await logAudit({
      userId: context.userId,
      action: "account.transfer",
      entityType: "finance_account",
      entityId: data.to_id,
      newValue: { from_id: data.from_id, to_id: data.to_id, amount: data.amount, notes: data.notes ?? null },
    });
    return { ok: true };
  });
registerFn('transferBetweenAccounts', transferBetweenAccounts);

export const recordCashAdjustment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        account_id: z.string().uuid(),
        direction: z.enum(["in", "out"]),
        amount: z.number().positive(),
        description: z.string().min(1).max(200),
        notes: z.string().max(500).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    await postAccountMovement({
      account_id: data.account_id,
      type: data.direction === "in" ? "cash_in" : "cash_out",
      amount_in: data.direction === "in" ? data.amount : 0,
      amount_out: data.direction === "out" ? data.amount : 0,
      description: data.description,
      notes: data.notes ?? null,
      created_by: context.userId,
    });
    await logAudit({
      userId: context.userId,
      action: data.direction === "in" ? "account.cash_in" : "account.cash_out",
      entityType: "finance_account",
      entityId: data.account_id,
      newValue: { amount: data.amount, description: data.description, notes: data.notes ?? null },
    });
    return { ok: true };
  });
registerFn('recordCashAdjustment', recordCashAdjustment);

/* ════════════════════════════════════════════════════════════
   2. EXPENSES
   ════════════════════════════════════════════════════════════ */

export const listExpenses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        limit: z.number().int().min(1).max(500).default(200),
        date_from: z.string().datetime().optional(),
        date_to: z.string().datetime().optional(),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    let q = supabaseAdmin
      .from("expenses")
      .select("*")
      .order("expense_date", { ascending: false })
      .limit(data.limit);
    if (data.date_from) q = q.gte("expense_date", data.date_from);
    if (data.date_to) q = q.lt("expense_date", data.date_to);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
registerFn('listExpenses', listExpenses);

export const createExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        expense_date: z.string().datetime().optional(),
        category: z.enum([
          "salary", "electricity", "water", "internet", "rent",
          "ads", "license", "maintenance", "advance", "other",
        ]),
        description: z.string().min(1).max(300),
        paid_from_account_id: z.string().uuid(),
        amount: z.number().nonnegative(),
        vat_amount: z.number().nonnegative().default(0),
        attachment_url: z.string().url().nullable().optional(),
        notes: z.string().max(500).nullable().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const total = Math.round((data.amount + data.vat_amount) * 100) / 100;
    if (total <= 0) throw new Error("Total must be greater than 0");

    const { data: row, error } = await supabaseAdmin
      .from("expenses")
      .insert({
        expense_date: data.expense_date ?? new Date().toISOString(),
        category: data.category,
        description: data.description,
        paid_from_account_id: data.paid_from_account_id,
        amount: data.amount,
        vat_amount: data.vat_amount,
        total,
        attachment_url: data.attachment_url ?? null,
        notes: data.notes ?? null,
        created_by: context.userId,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    // Post the cash-out movement against the paying account
    await postAccountMovement({
      account_id: data.paid_from_account_id,
      type: "expense",
      amount_out: total,
      description: `${row.number} — ${data.description}`,
      reference: row.number,
      reference_id: row.id,
      created_by: context.userId,
    });
    // Best-effort auto-journal: Dr Expense (5000), Cr Cash/Bank (1000)
    await tryPostJournal({
      description: `${row.number} — ${data.description}`,
      source: "expense",
      debitAccountCode: "5000",
      creditAccountCode: "1000",
      amount: total,
      createdBy: context.userId,
    });
    await logAudit({
      userId: context.userId,
      action: "expense.create",
      entityType: "expense",
      entityId: row.id,
      newValue: { number: row.number, category: data.category, total, description: data.description },
    });
    return row;
  });
registerFn('createExpense', createExpense);

/* ════════════════════════════════════════════════════════════
   3. CHART OF ACCOUNTS
   ════════════════════════════════════════════════════════════ */

export const listChartAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data, error } = await supabaseAdmin
      .from("chart_accounts")
      .select("*")
      .order("code", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });
registerFn('listChartAccounts', listChartAccounts);

export const upsertChartAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        code: z.string().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/),
        name_en: z.string().min(1).max(120),
        name_ar: z.string().min(1).max(120),
        type: z.enum(["asset", "liability", "revenue", "expense", "equity"]),
        parent_code: z.string().max(20).nullable().optional(),
        active: z.boolean().default(true),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { data: row, error } = await supabaseAdmin
      .from("chart_accounts")
      .upsert(
        {
          code: data.code,
          name_en: data.name_en,
          name_ar: data.name_ar,
          type: data.type,
          parent_code: data.parent_code ?? null,
          active: data.active,
        },
        { onConflict: "code" },
      )
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });
registerFn('upsertChartAccount', upsertChartAccount);

/* ════════════════════════════════════════════════════════════
   4. JOURNAL ENTRIES
   ════════════════════════════════════════════════════════════ */

export const listJournalEntries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ limit: z.number().int().min(1).max(500).default(100) }).parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data: entries, error } = await supabaseAdmin
      .from("journal_entries")
      .select("*")
      .order("entry_date", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);

    const ids = (entries ?? []).map((e) => e.id);
    let linesByEntry = new Map<string, any[]>();
    if (ids.length) {
      const { data: lines } = await supabaseAdmin
        .from("journal_lines")
        .select("*")
        .in("journal_entry_id", ids);
      for (const l of lines ?? []) {
        const arr = linesByEntry.get(l.journal_entry_id) ?? [];
        arr.push(l);
        linesByEntry.set(l.journal_entry_id, arr);
      }
    }
    return (entries ?? []).map((e) => ({ ...e, lines: linesByEntry.get(e.id) ?? [] }));
  });
registerFn('listJournalEntries', listJournalEntries);

export const createJournalEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        entry_date: z.string().datetime().optional(),
        description: z.string().min(1).max(300),
        attachment_url: z.string().url().nullable().optional(),
        lines: z
          .array(
            z.object({
              account_code: z.string().min(1).max(20),
              debit: z.number().nonnegative().default(0),
              credit: z.number().nonnegative().default(0),
              notes: z.string().max(200).nullable().optional(),
            }),
          )
          .min(2)
          .max(40),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const entry = await postJournalEntry({
      date: data.entry_date,
      source: "manual",
      description: data.description,
      attachment_url: data.attachment_url ?? null,
      lines: data.lines,
      created_by: context.userId,
    });
    await logAudit({
      userId: context.userId,
      action: "journal.create",
      entityType: "journal_entry",
      entityId: entry.id,
      newValue: { number: entry.number, description: data.description, lines: data.lines },
    });
    return entry;
  });
registerFn('createJournalEntry', createJournalEntry);

export const reverseJournalEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { data: entry, error } = await supabaseAdmin
      .from("journal_entries")
      .select("id, number, description, status")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    if (entry.status !== "posted") throw new Error("Only posted entries can be reversed");

    const { data: lines, error: lErr } = await supabaseAdmin
      .from("journal_lines")
      .select("account_code, debit, credit, notes")
      .eq("journal_entry_id", data.id);
    if (lErr) throw new Error(lErr.message);

    const reversed = await postJournalEntry({
      source: "manual",
      description: `Reversal of ${entry.number}`,
      lines: (lines ?? []).map((l) => ({
        account_code: l.account_code,
        debit: Number(l.credit),
        credit: Number(l.debit),
        notes: l.notes,
      })),
      created_by: context.userId,
    });

    await supabaseAdmin
      .from("journal_entries")
      .update({ status: "reversed", reversed_by: reversed.id })
      .eq("id", data.id);
    await supabaseAdmin
      .from("journal_entries")
      .update({ reverses: data.id })
      .eq("id", reversed.id);

    await logAudit({
      userId: context.userId,
      action: "journal.reverse",
      entityType: "journal_entry",
      entityId: data.id,
      newValue: { reversed_by: reversed.id, number: reversed.number },
    });
    return reversed;
  });
registerFn('reverseJournalEntry', reverseJournalEntry);

/* ════════════════════════════════════════════════════════════
   5. SUPPLIER PAYMENTS
   ════════════════════════════════════════════════════════════ */

export const listSupplierPayments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        supplier_id: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(500).default(200),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    let q = supabaseAdmin
      .from("supplier_payments")
      .select("*")
      .order("paid_at", { ascending: false })
      .limit(data.limit);
    if (data.supplier_id) q = q.eq("supplier_id", data.supplier_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
registerFn('listSupplierPayments', listSupplierPayments);

export const createSupplierPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        supplier_id: z.string().uuid(),
        paid_from_account_id: z.string().uuid(),
        amount: z.number().positive(),
        method: z.enum(["cash", "bank", "transfer"]).default("cash"),
        reference: z.string().max(120).optional(),
        applied_invoice_id: z.string().uuid().nullable().optional(),
        notes: z.string().max(500).optional(),
        paid_at: z.string().datetime().optional(),
        attachment_url: z.string().url().nullable().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const { data: row, error } = await supabaseAdmin
      .from("supplier_payments")
      .insert({
        supplier_id: data.supplier_id,
        paid_from_account_id: data.paid_from_account_id,
        amount: data.amount,
        method: data.method,
        reference: data.reference ?? null,
        applied_invoice_id: data.applied_invoice_id ?? null,
        notes: data.notes ?? null,
        paid_at: data.paid_at ?? new Date().toISOString(),
        attachment_url: data.attachment_url ?? null,
        created_by: context.userId,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    // Reduce paying account
    await postAccountMovement({
      account_id: data.paid_from_account_id,
      type: "supplier_payment",
      amount_out: data.amount,
      description: `${row.number} — supplier payment`,
      reference: row.number,
      reference_id: row.id,
      created_by: context.userId,
    });

    // If applied to an invoice, update its amount_paid + status
    if (data.applied_invoice_id) {
      const { data: inv } = await supabaseAdmin
        .from("purchase_invoices")
        .select("id, total, amount_paid")
        .eq("id", data.applied_invoice_id)
        .maybeSingle();
      if (inv) {
        const nextPaid = Number(inv.amount_paid) + data.amount;
        const total = Number(inv.total);
        const status =
          nextPaid >= total - 0.005 ? "paid" : nextPaid > 0 ? "partially_paid" : "unpaid";
        await supabaseAdmin
          .from("purchase_invoices")
          .update({ amount_paid: nextPaid, status })
          .eq("id", data.applied_invoice_id);
      }
    }
    // Best-effort auto-journal: Dr Accounts Payable (2000), Cr Cash/Bank (1000)
    await tryPostJournal({
      description: `${row.number} — supplier payment`,
      source: "supplier_payment",
      debitAccountCode: "2000",
      creditAccountCode: "1000",
      amount: data.amount,
      createdBy: context.userId,
    });
    await logAudit({
      userId: context.userId,
      action: "supplier_payment.create",
      entityType: "supplier_payment",
      entityId: row.id,
      newValue: {
        number: row.number,
        supplier_id: data.supplier_id,
        amount: data.amount,
        method: data.method,
        applied_invoice_id: data.applied_invoice_id ?? null,
      },
    });
    return row;
  });
registerFn('createSupplierPayment', createSupplierPayment);

/* ════════════════════════════════════════════════════════════
   6. SIMPLE FINANCIAL REPORTS
   ════════════════════════════════════════════════════════════ */

export const getFinanceSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        date_from: z.string().datetime().optional(),
        date_to: z.string().datetime().optional(),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);

    // Sales (POS) total VAT-inclusive within window
    let ordQ = supabaseAdmin
      .from("orders")
      .select("total_including_vat, vat_included_amount, net_amount_excluding_vat, created_at, status")
      .in("status", ["completed", "partially_refunded", "refunded"]);
    if (data.date_from) ordQ = ordQ.gte("created_at", data.date_from);
    if (data.date_to) ordQ = ordQ.lt("created_at", data.date_to);
    const { data: orders } = await ordQ;
    const salesIncl = (orders ?? []).reduce((s, o: any) => s + Number(o.total_including_vat), 0);
    const salesNet = (orders ?? []).reduce((s, o: any) => s + Number(o.net_amount_excluding_vat), 0);
    const salesVat = (orders ?? []).reduce((s, o: any) => s + Number(o.vat_included_amount), 0);

    // Refunds
    let refQ = supabaseAdmin.from("refunds").select("amount, refunded_at");
    if (data.date_from) refQ = refQ.gte("refunded_at", data.date_from);
    if (data.date_to) refQ = refQ.lt("refunded_at", data.date_to);
    const { data: refunds } = await refQ;
    const refundsTotal = (refunds ?? []).reduce((s, r: any) => s + Number(r.amount), 0);

    // Expenses
    let expQ = supabaseAdmin.from("expenses").select("total, vat_amount, expense_date, category");
    if (data.date_from) expQ = expQ.gte("expense_date", data.date_from);
    if (data.date_to) expQ = expQ.lt("expense_date", data.date_to);
    const { data: expenses } = await expQ;
    const expensesTotal = (expenses ?? []).reduce((s, e: any) => s + Number(e.total), 0);
    const expensesByCat: Record<string, number> = {};
    for (const e of expenses ?? []) {
      const c = (e as any).category;
      expensesByCat[c] = (expensesByCat[c] ?? 0) + Number((e as any).total);
    }

    // Purchases (cogs proxy)
    let purQ = supabaseAdmin.from("purchase_invoices").select("total, invoice_date");
    if (data.date_from) purQ = purQ.gte("invoice_date", data.date_from.slice(0, 10));
    if (data.date_to) purQ = purQ.lt("invoice_date", data.date_to.slice(0, 10));
    const { data: purchases } = await purQ;
    const purchasesTotal = (purchases ?? []).reduce((s, p: any) => s + Number(p.total), 0);

    // Salaries paid
    let salQ = supabaseAdmin.from("salary_records").select("paid_amount, paid_at, status");
    if (data.date_from) salQ = salQ.gte("paid_at", data.date_from);
    if (data.date_to) salQ = salQ.lt("paid_at", data.date_to);
    const { data: salaries } = await salQ;
    const salariesPaid = (salaries ?? [])
      .filter((s: any) => s.status !== "unpaid")
      .reduce((sum, s: any) => sum + Number(s.paid_amount ?? 0), 0);

    // Account balances snapshot
    const { data: accounts } = await supabaseAdmin
      .from("finance_accounts")
      .select("id, name_en, name_ar, type, balance")
      .eq("active", true);
    const cashOnHand = (accounts ?? [])
      .filter((a: any) => a.type === "cashbox")
      .reduce((s, a: any) => s + Number(a.balance), 0);
    const bankBalances = (accounts ?? [])
      .filter((a: any) => a.type === "bank")
      .reduce((s, a: any) => s + Number(a.balance), 0);

    // Refunds reduce both gross and net (a refunded sale must not count as full revenue).
    const netSalesAfterRefunds = salesNet - refundsTotal;
    const grossProfit = netSalesAfterRefunds - purchasesTotal;
    const netResult = netSalesAfterRefunds - purchasesTotal - expensesTotal - salariesPaid;

    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      sales: { including_vat: r2(salesIncl), net: r2(salesNet), vat: r2(salesVat) },
      refunds_total: r2(refundsTotal),
      net_sales_after_refunds: r2(netSalesAfterRefunds),
      purchases_total: r2(purchasesTotal),
      expenses: { total: r2(expensesTotal), by_category: expensesByCat },
      salaries_paid: r2(salariesPaid),
      gross_profit: r2(grossProfit),
      net_result: r2(netResult),
      cash_on_hand: r2(cashOnHand),
      bank_balances: r2(bankBalances),
      accounts: (accounts ?? []).map((a: any) => ({ ...a, balance: r2(Number(a.balance)) })),
    };
  });
registerFn('getFinanceSummary', getFinanceSummary);

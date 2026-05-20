// Sprint E — audit log listing + production readiness server functions.
import { createServerFn, registerFn, requireSupabaseAuth } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function userRoles(userId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  return (data ?? []).map((r: any) => r.role);
}
async function ensureAdminOrFinance(userId: string) {
  const roles = await userRoles(userId);
  if (!roles.some((r) => r === "owner" || r === "manager" || r === "finance"))
    throw new Error("Forbidden");
}

/** Paged audit log fetch with filters. */
export const listAuditLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        user_id: z.string().uuid().optional(),
        entity_type: z.string().max(60).optional(),
        action: z.string().max(80).optional(),
        limit: z.number().int().min(1).max(500).default(200),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    let q = supabaseAdmin
      .from("audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.from) q = q.gte("created_at", data.from);
    if (data.to) q = q.lt("created_at", data.to);
    if (data.user_id) q = q.eq("user_id", data.user_id);
    if (data.entity_type) q = q.eq("entity_type", data.entity_type);
    if (data.action) q = q.eq("action", data.action);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    // Best-effort enrichment: join user names.
    const ids = Array.from(
      new Set((rows ?? []).map((r: any) => r.user_id).filter(Boolean)),
    ) as string[];
    let nameById = new Map<string, string>();
    if (ids.length) {
      const { data: profiles } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name, username")
        .in("id", ids);
      for (const p of profiles ?? []) {
        nameById.set((p as any).id, (p as any).full_name || (p as any).username || "");
      }
    }
    return (rows ?? []).map((r: any) => ({
      ...r,
      user_name: r.user_id ? nameById.get(r.user_id) ?? null : null,
    }));
  });
registerFn('listAuditLogs', listAuditLogs);

/** Live counts driving the production readiness checklist. */
export const getReadinessSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdminOrFinance(context.userId);
    const headCount = async (table: string, filter?: (q: any) => any) => {
      let q: any = (supabaseAdmin as any).from(table).select("*", { count: "exact", head: true });
      if (filter) q = filter(q);
      const { count, error } = await q;
      if (error) return 0;
      return count ?? 0;
    };

    const [
      products, activeProducts, categories, addons,
      orders, completedOrders, refunds,
      shifts, openShifts,
      suppliers, inventory, purchases, recipes,
      expenses, financeAccounts, journals, employees, salaries,
      users, customers, auditLogs,
    ] = await Promise.all([
      headCount("products"),
      headCount("products", (q) => q.eq("active", true)),
      headCount("categories"),
      headCount("addons"),
      headCount("orders"),
      headCount("orders", (q) =>
        q.in("status", ["completed", "partially_refunded", "refunded"]),
      ),
      headCount("refunds"),
      headCount("shifts"),
      headCount("shifts", (q) => q.eq("status", "open")),
      headCount("suppliers"),
      headCount("inventory_items"),
      headCount("purchase_invoices"),
      headCount("product_recipes"),
      headCount("expenses"),
      headCount("finance_accounts"),
      headCount("journal_entries"),
      headCount("employees"),
      headCount("salary_records"),
      headCount("profiles"),
      headCount("customers"),
      headCount("audit_logs"),
    ]);

    // Settings completeness probe.
    const { data: s } = await supabaseAdmin
      .from("restaurant_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    const settings = s as any | null;
    const requiredZatcaFields = [
      "legal_name_en",
      "legal_name_ar",
      "vat_number",
      "commercial_registration",
      "national_address",
    ];
    const missingZatca = requiredZatcaFields.filter(
      (f) => !settings?.[f] || String(settings[f]).trim() === "",
    );
    const settingsComplete = missingZatca.length === 0 && !!settings?.brand_name_en;

    return {
      counts: {
        products, activeProducts, categories, addons,
        orders, completedOrders, refunds,
        shifts, openShifts,
        suppliers, inventory, purchases, recipes,
        expenses, financeAccounts, journals, employees, salaries,
        users, customers, auditLogs,
      },
      settings: {
        loaded: !!settings,
        complete: settingsComplete,
        missingZatcaFields: missingZatca,
        vatRate: settings?.vat_rate ?? null,
        pricesIncludeVat: settings?.prices_include_vat ?? null,
        logoUrl: settings?.logo_url ?? null,
        receiptWidth: settings?.receipt_width ?? null,
        printCopies: settings?.print_copies ?? null,
      },
    };
  });
registerFn('getReadinessSnapshot', getReadinessSnapshot);

// Sprint F — ZATCA server functions (admin / finance gated).
//
// PRE-OTP scope:
//   • Read/update settings
//   • Verify onboarding readiness (checks restaurant_settings completeness)
//   • Move onboarding state machine up to "ready_for_otp"
//   • List sync queue / synced / failed / credit notes / logs
//   • Manual retry stub that re-enqueues a failed invoice for the next
//     submission attempt (which will be wired after CSID onboarding)
//
// We DO NOT attempt CSR/CSID/clearance/reporting yet — those are gated
// behind explicit OTP entry, which we stop and ask the user for.

import { createServerFn, registerFn, requireSupabaseAuth } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logAudit } from "@/lib/audit.server";
import {
  generateZatcaForInvoice,
  generateZatcaForRefund,
  zatcaLog,
} from "@/lib/zatca.server";

async function ensureAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["owner", "manager"]);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Forbidden: admin role required");
}
async function ensureAdminOrFinance(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["owner", "manager", "finance"]);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Forbidden: admin/finance required");
}

/* ────────────── Settings ────────────── */
export const getZatcaSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data } = await supabaseAdmin
      .from("zatca_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    return data ?? null;
  });
registerFn('getZatcaSettings', getZatcaSettings);

export const updateZatcaSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        environment: z.enum(["simulation", "production"]).optional(),
        device_name: z.string().min(1).max(60).optional(),
        device_serial: z.string().min(1).max(60).optional(),
        notes: z.string().max(500).nullable().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    // Production switch is intentionally restricted: only allowed when
    // onboarding_status = 'onboarded'.
    if (data.environment === "production") {
      const { data: cur } = await supabaseAdmin
        .from("zatca_settings")
        .select("onboarding_status")
        .eq("id", true)
        .maybeSingle();
      if ((cur as any)?.onboarding_status !== "onboarded") {
        throw new Error("Production requires onboarded device. Complete sandbox onboarding first.");
      }
    }
    const { data: row, error } = await supabaseAdmin
      .from("zatca_settings")
      .update({ ...data, updated_by: context.userId })
      .eq("id", true)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    await logAudit({
      userId: context.userId,
      action: "zatca.settings.update",
      entityType: "zatca_settings",
      entityId: "singleton",
      newValue: data,
    });
    await zatcaLog({ event: "settings.update", detail: data });
    return row;
  });
registerFn('updateZatcaSettings', updateZatcaSettings);

/* ────────────── Onboarding ────────────── */
const REQUIRED_FIELDS = [
  "legal_name_ar",
  "vat_number",
  "commercial_registration",
  "national_address",
] as const;

export const verifyOnboardingReadiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.userId);
    const { data: settings } = await supabaseAdmin
      .from("restaurant_settings")
      .select("legal_name_ar, vat_number, commercial_registration, national_address, brand_name_ar")
      .eq("id", true)
      .maybeSingle();
    const missing: string[] = [];
    for (const f of REQUIRED_FIELDS) {
      const v = (settings as any)?.[f];
      if (!v || String(v).trim().length === 0) missing.push(f);
    }
    // VAT number basic shape check (15 digits, starts/ends with 3 in real KSA).
    const vat = (settings as any)?.vat_number ?? "";
    if (vat && !/^\d{15}$/.test(String(vat))) {
      missing.push("vat_number_format");
    }
    const ready = missing.length === 0;
    const newStatus = ready ? "ready_for_otp" : "settings_missing";

    const { data: cur } = await supabaseAdmin
      .from("zatca_settings")
      .select("onboarding_status, last_error, sandbox_base_url, environment")
      .eq("id", true)
      .maybeSingle();
    // Don't downgrade an already-onboarded device.
    const curStatus = (cur as any)?.onboarding_status;
    if (curStatus !== "onboarded" && curStatus !== "otp_entered" && curStatus !== "onboarding_pending") {
      const patch: any = { onboarding_status: newStatus };
      if (!ready) patch.last_error = "settings_incomplete";
      await supabaseAdmin.from("zatca_settings").update(patch).eq("id", true);
    }
    await zatcaLog({ event: "onboarding.verify", detail: { ready, missing } });
    return {
      ready,
      missing,
      currentStatus: curStatus ?? newStatus,
      lastError: (cur as any)?.last_error ?? null,
      sandboxBaseUrl: (cur as any)?.sandbox_base_url ?? null,
      environment: (cur as any)?.environment ?? null,
    };
  });
registerFn('verifyOnboardingReadiness', verifyOnboardingReadiness);

/* ────────────── Sprint F-2: Device CSR + CSID + queue ────────────── */

import { prepareDevice, requestComplianceCsid } from "@/lib/zatca-onboarding.server";
import { processQueue } from "@/lib/zatca-queue.server";

// Generate key pair + CSR. Stops before OTP (no network call).
export const prepareDeviceCsr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.userId);
    const result = await prepareDevice();
    await logAudit({
      userId: context.userId,
      action: "zatca.csr.prepared",
      entityType: "zatca_device_keys",
      entityId: "singleton",
    });
    return result;
  });
registerFn('prepareDeviceCsr', prepareDeviceCsr);

// Consume OTP + send CSR to ZATCA compliance endpoint. OTP is single-use.
export const submitOnboardingOtp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ otp: z.string().min(4).max(20) }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    // Mark "otp_entered" transiently so the UI knows we tried.
    await supabaseAdmin
      .from("zatca_settings")
      .update({ onboarding_status: "otp_entered", last_error: null })
      .eq("id", true);
    const result = await requestComplianceCsid(data.otp);
    await logAudit({
      userId: context.userId,
      action: "zatca.onboarding.csid_request",
      entityType: "zatca_settings",
      entityId: "singleton",
      newValue: { ok: result.ok, status: result.status, requestId: result.requestId ?? null },
    });
    if (!result.ok) {
      // Revert to ready_for_otp so they can retry with a fresh OTP.
      await supabaseAdmin
        .from("zatca_settings")
        .update({ onboarding_status: "ready_for_otp", last_error: result.error ?? "csid_failed" })
        .eq("id", true);
      return { ok: false, error: result.error, status: result.status };
    }
    return { ok: true, status: result.status, requestId: result.requestId ?? null };
  });
registerFn('submitOnboardingOtp', submitOnboardingOtp);

// Run the queue submitter manually from the dashboard.
export const processZatcaQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ maxItems: z.number().int().min(1).max(100).optional() }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const summary = await processQueue({ maxItems: data.maxItems });
    await logAudit({
      userId: context.userId,
      action: "zatca.queue.process",
      entityType: "zatca",
      entityId: "queue",
      newValue: summary,
    });
    return summary;
  });
registerFn('processZatcaQueue', processZatcaQueue);

// Return a *safe* device-key status (never includes private key, ciphertext or token).
export const getDeviceStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data } = await supabaseAdmin
      .from("zatca_device_keys")
      .select("csr_pem, compliance_csid_token_encrypted, csid_issued_at, csid_expires_at, last_pih_b64, compliance_request_id")
      .eq("id", true)
      .maybeSingle();
    const row: any = data ?? {};
    return {
      hasKey: !!row.csr_pem,
      hasCsr: !!row.csr_pem,
      csrLength: row.csr_pem ? row.csr_pem.length : 0,
      hasComplianceCsid: !!row.compliance_csid_token_encrypted,
      csidIssuedAt: row.csid_issued_at ?? null,
      csidExpiresAt: row.csid_expires_at ?? null,
      complianceRequestId: row.compliance_request_id ?? null,
      pihPresent: !!row.last_pih_b64,
    };
  });
registerFn('getDeviceStatus', getDeviceStatus);



/* ────────────── Manual generation triggers (for backfill or admin retry) ────────────── */
export const regenerateZatcaInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ invoice_id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    await generateZatcaForInvoice(data.invoice_id);
    return { ok: true };
  });
registerFn('regenerateZatcaInvoice', regenerateZatcaInvoice);

export const retryZatcaInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { data: row } = await supabaseAdmin
      .from("zatca_invoices")
      .select("retry_count, status")
      .eq("id", data.id)
      .maybeSingle();
    if (!row) throw new Error("Not found");
    if ((row as any).status === "synced") return { ok: true, noop: true };
    await supabaseAdmin
      .from("zatca_invoices")
      .update({
        status: "pending_sync",
        retry_count: ((row as any).retry_count ?? 0) + 1,
        last_attempt_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", data.id);
    await zatcaLog({ event: "invoice.retry", refType: "zatca_invoices", refId: data.id });
    return { ok: true };
  });
registerFn('retryZatcaInvoice', retryZatcaInvoice);

/* ────────────── Dashboard reads ────────────── */
export const listZatcaInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        status: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(200),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    let q = supabaseAdmin.from("zatca_invoices").select("*").order("created_at", { ascending: false }).limit(data.limit);
    if (data.status) q = q.eq("status", data.status as any);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    // Join invoice + order numbers for display.
    const invIds = (rows ?? []).map((r: any) => r.invoice_id);
    const ordIds = (rows ?? []).map((r: any) => r.order_id);
    const [invR, ordR] = await Promise.all([
      invIds.length
        ? supabaseAdmin.from("invoices").select("id, invoice_number").in("id", invIds)
        : Promise.resolve({ data: [] as any[] } as any),
      ordIds.length
        ? supabaseAdmin.from("orders").select("id, order_number, total_including_vat").in("id", ordIds)
        : Promise.resolve({ data: [] as any[] } as any),
    ]);
    const invMap = new Map(((invR as any).data ?? []).map((r: any) => [r.id, r.invoice_number]));
    const ordMap = new Map(((ordR as any).data ?? []).map((r: any) => [r.id, r]));
    return (rows ?? []).map((r: any) => ({
      ...r,
      invoice_number: invMap.get(r.invoice_id) ?? null,
      order_number: (ordMap.get(r.order_id) as any)?.order_number ?? null,
      total: (ordMap.get(r.order_id) as any)?.total_including_vat ?? null,
    }));
  });
registerFn('listZatcaInvoices', listZatcaInvoices);

export const listZatcaCreditNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data, error } = await supabaseAdmin
      .from("zatca_credit_notes")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
registerFn('listZatcaCreditNotes', listZatcaCreditNotes);

export const listZatcaLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ limit: z.number().int().min(1).max(500).default(200) }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data: rows, error } = await supabaseAdmin
      .from("zatca_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
registerFn('listZatcaLogs', listZatcaLogs);

export const getZatcaForInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ invoice_id: z.string().uuid() }).parse(i))
  .handler(async ({ data }) => {
    const { data: row } = await supabaseAdmin
      .from("zatca_invoices")
      .select("status, qr_payload, zatca_uuid, environment")
      .eq("invoice_id", data.invoice_id)
      .maybeSingle();
    return row ?? null;
  });
registerFn('getZatcaForInvoice', getZatcaForInvoice);

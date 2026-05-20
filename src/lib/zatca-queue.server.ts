// Sprint F-2 — ZATCA queue submitter (server-only).
//
// Picks pending_sync invoices / credit notes, ensures they are signed
// (PIH chain advanced atomically only on success), and reports them to
// the configured sandbox endpoint. Does NOT mark anything as synced
// without a real 2xx response from ZATCA.
//
// SECURITY: server-only. CSID secrets are read from the encrypted store
// and never returned to the caller.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  getDecryptedComplianceCsid,
} from "./zatca-crypto.server";
import {
  advancePih,
  getCurrentPih,
  signInvoiceXml,
} from "./zatca-signing.server";
import {
  buildSimplifiedInvoiceXml,
  buildZatcaTlvQr,
  zatcaLog,
} from "./zatca.server";

interface SettingsRow {
  environment: "simulation" | "production";
  sandbox_base_url: string;
  production_base_url: string;
  onboarding_status: string;
}

async function loadEnv(): Promise<SettingsRow> {
  const { data } = await supabaseAdmin
    .from("zatca_settings")
    .select("environment, sandbox_base_url, production_base_url, onboarding_status")
    .eq("id", true)
    .maybeSingle();
  return data as any;
}

async function basicAuthHeader(): Promise<string> {
  const cs = await getDecryptedComplianceCsid();
  if (!cs) throw new Error("Device not onboarded (no CSID).");
  return "Basic " + Buffer.from(`${cs.token}:${cs.secret}`).toString("base64");
}

interface SubmitResult {
  ok: boolean;
  status: number;
  body: any;
}

async function postReporting(endpoint: string, signedXmlB64: string, invoiceHashB64: string, uuid: string): Promise<SubmitResult> {
  let auth: string;
  try {
    auth = await basicAuthHeader();
  } catch (e: any) {
    return { ok: false, status: 0, body: { error: e.message } };
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Version": "V2",
        Authorization: auth,
      },
      body: JSON.stringify({
        invoiceHash: invoiceHashB64,
        uuid,
        invoice: signedXmlB64,
      }),
    });
    let body: any;
    try { body = await res.json(); } catch { body = { raw: await res.text().catch(() => "") }; }
    return { ok: res.ok, status: res.status, body };
  } catch (e: any) {
    return { ok: false, status: 0, body: { error: String(e?.message ?? e) } };
  }
}

/** Ensure an invoice has a signed XML + hash + ICV + PIH stamped. Idempotent
 * for unsigned rows; never re-signs an already signed row to keep the chain
 * consistent on retries. */
async function ensureSignedInvoice(row: any): Promise<{ signedXmlB64: string; invoiceHashB64: string; uuid: string } | { error: string }> {
  if (row.signed_xml_b64 && row.invoice_hash_b64 && row.zatca_uuid) {
    return {
      signedXmlB64: row.signed_xml_b64,
      invoiceHashB64: row.invoice_hash_b64,
      uuid: row.zatca_uuid,
    };
  }
  // Rebuild XML from invoice + order
  const { data: inv } = await supabaseAdmin.from("invoices").select("invoice_number, issued_at").eq("id", row.invoice_id).maybeSingle();
  const { data: order } = await supabaseAdmin.from("orders").select("total_including_vat, vat_included_amount, net_amount_excluding_vat, discount_amount, created_at").eq("id", row.order_id).maybeSingle();
  const { data: items } = await supabaseAdmin.from("order_items").select("name_snapshot, quantity, unit_price, line_total").eq("order_id", row.order_id);
  const { data: settings } = await supabaseAdmin.from("restaurant_settings").select("legal_name_ar, vat_number, commercial_registration, national_address").eq("id", true).maybeSingle();
  if (!inv || !order || !settings) return { error: "Missing invoice/order/settings" };

  const iso = new Date((inv as any).issued_at ?? (order as any).created_at ?? Date.now()).toISOString();
  const total = Number((order as any).total_including_vat ?? 0);
  const vat = Number((order as any).vat_included_amount ?? 0);
  const net = Number((order as any).net_amount_excluding_vat ?? total - vat);
  const discount = Number((order as any).discount_amount ?? 0);

  const uuid = row.zatca_uuid ?? crypto.randomUUID();
  const unsignedXml = buildSimplifiedInvoiceXml({
    invoiceNumber: (inv as any).invoice_number,
    issueIso: iso,
    uuid,
    seller: {
      nameAr: (settings as any).legal_name_ar ?? "Yellow Chicken",
      vat: (settings as any).vat_number ?? "",
      crNumber: (settings as any).commercial_registration,
      address: (settings as any).national_address,
    },
    totalWithVat: total,
    vatTotal: vat,
    netExVat: net,
    discount,
    items: (items ?? []).map((it: any) => ({
      nameAr: it.name_snapshot,
      qty: Number(it.quantity),
      unitPriceIncVat: Number(it.unit_price),
      lineTotalIncVat: Number(it.line_total),
    })),
  });

  // Allocate ICV + PIH atomically: read current PIH, build signed XML, store.
  const { data: icvRow } = await supabaseAdmin.rpc("next_zatca_icv");
  const icv = Number(icvRow ?? 0);
  const pihB64 = await getCurrentPih();
  const signed = await signInvoiceXml({ unsignedXml, icv, pihB64 });

  await supabaseAdmin
    .from("zatca_invoices")
    .update({
      icv,
      previous_invoice_hash_b64: pihB64,
      invoice_hash_b64: signed.invoiceHashB64,
      signed_xml_b64: Buffer.from(signed.signedXml).toString("base64"),
      zatca_uuid: uuid,
    })
    .eq("id", row.id);

  return {
    signedXmlB64: Buffer.from(signed.signedXml).toString("base64"),
    invoiceHashB64: signed.invoiceHashB64,
    uuid,
  };
}

async function ensureSignedCreditNote(row: any): Promise<{ signedXmlB64: string; invoiceHashB64: string; uuid: string } | { error: string }> {
  if (row.signed_xml_b64 && row.invoice_hash_b64 && row.zatca_uuid) {
    return {
      signedXmlB64: row.signed_xml_b64,
      invoiceHashB64: row.invoice_hash_b64,
      uuid: row.zatca_uuid,
    };
  }
  const { data: refund } = await supabaseAdmin.from("refunds").select("amount, refunded_at, order_id").eq("id", row.refund_id).maybeSingle();
  const { data: origInv } = await supabaseAdmin.from("invoices").select("invoice_number").eq("id", row.original_invoice_id).maybeSingle();
  const { data: settings } = await supabaseAdmin.from("restaurant_settings").select("legal_name_ar, vat_number, vat_rate").eq("id", true).maybeSingle();
  if (!refund || !origInv || !settings) return { error: "Missing refund/original/settings" };

  const vatRate = Number((settings as any).vat_rate ?? 0.15);
  const amount = Number((refund as any).amount);
  const vatPortion = +(amount - amount / (1 + vatRate)).toFixed(2);
  const iso = new Date((refund as any).refunded_at ?? Date.now()).toISOString();
  const uuid = row.zatca_uuid ?? crypto.randomUUID();

  const unsignedXml = buildSimplifiedInvoiceXml({
    invoiceNumber: `CN-${(origInv as any).invoice_number}`,
    issueIso: iso,
    uuid,
    seller: { nameAr: (settings as any).legal_name_ar ?? "Yellow Chicken", vat: (settings as any).vat_number ?? "" },
    totalWithVat: amount,
    vatTotal: vatPortion,
    netExVat: +(amount - vatPortion).toFixed(2),
    discount: 0,
    items: [{ nameAr: "Refund / إرجاع", qty: 1, unitPriceIncVat: amount, lineTotalIncVat: amount }],
    isCreditNote: true,
    originalInvoiceNumber: (origInv as any).invoice_number,
  });

  const { data: icvRow } = await supabaseAdmin.rpc("next_zatca_icv");
  const icv = Number(icvRow ?? 0);
  const pihB64 = await getCurrentPih();
  const signed = await signInvoiceXml({ unsignedXml, icv, pihB64 });

  await supabaseAdmin
    .from("zatca_credit_notes")
    .update({
      icv,
      previous_invoice_hash_b64: pihB64,
      invoice_hash_b64: signed.invoiceHashB64,
      signed_xml_b64: Buffer.from(signed.signedXml).toString("base64"),
      zatca_uuid: uuid,
    })
    .eq("id", row.id);

  return {
    signedXmlB64: Buffer.from(signed.signedXml).toString("base64"),
    invoiceHashB64: signed.invoiceHashB64,
    uuid,
  };
}

export interface ProcessQueueSummary {
  processed: number;
  synced: number;
  failed: number;
  skipped: number;
  reason?: string;
}

export async function processQueue(opts: { maxItems?: number } = {}): Promise<ProcessQueueSummary> {
  const env = await loadEnv();
  if (!env) return { processed: 0, synced: 0, failed: 0, skipped: 0, reason: "no_settings" };
  if (env.onboarding_status !== "onboarded") {
    return { processed: 0, synced: 0, failed: 0, skipped: 0, reason: "not_onboarded" };
  }
  const baseUrl =
    env.environment === "production"
      ? env.production_base_url
      : env.sandbox_base_url;
  if (!baseUrl) return { processed: 0, synced: 0, failed: 0, skipped: 0, reason: "no_base_url" };
  const endpoint = `${baseUrl.replace(/\/$/, "")}/invoices/reporting/single`;
  const cnEndpoint = `${baseUrl.replace(/\/$/, "")}/invoices/reporting/single`; // sandbox uses same path

  const limit = Math.min(opts.maxItems ?? 25, 100);

  // Invoices first
  const { data: invRows } = await supabaseAdmin
    .from("zatca_invoices")
    .select("*")
    .eq("status", "pending_sync")
    .order("created_at", { ascending: true })
    .limit(limit);

  const { data: cnRows } = await supabaseAdmin
    .from("zatca_credit_notes")
    .select("*")
    .eq("status", "pending_sync")
    .order("created_at", { ascending: true })
    .limit(limit);

  let synced = 0;
  let failed = 0;
  let processed = 0;

  for (const row of invRows ?? []) {
    processed++;
    const prepared = await ensureSignedInvoice(row);
    if ("error" in prepared) {
      failed++;
      await supabaseAdmin
        .from("zatca_invoices")
        .update({
          status: "failed",
          error_message: prepared.error,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await zatcaLog({ level: "error", event: "queue.invoice.prepare_failed", refType: "zatca_invoices", refId: row.id, detail: { error: prepared.error } });
      continue;
    }
    const result = await postReporting(endpoint, prepared.signedXmlB64, prepared.invoiceHashB64, prepared.uuid);
    if (result.ok) {
      synced++;
      await advancePih(prepared.invoiceHashB64);
      await supabaseAdmin
        .from("zatca_invoices")
        .update({
          status: "synced",
          submitted_at: new Date().toISOString(),
          submitted_endpoint: endpoint,
          response_payload: result.body,
          error_message: null,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await zatcaLog({ event: "queue.invoice.synced", refType: "zatca_invoices", refId: row.id, detail: { status: result.status } });
    } else {
      failed++;
      const rejected = result.status >= 400 && result.status < 500;
      await supabaseAdmin
        .from("zatca_invoices")
        .update({
          status: rejected ? "rejected" : "failed",
          submitted_endpoint: endpoint,
          response_payload: result.body,
          error_message: `HTTP ${result.status}`,
          retry_count: (row.retry_count ?? 0) + 1,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await zatcaLog({ level: "error", event: "queue.invoice.failed", refType: "zatca_invoices", refId: row.id, detail: { status: result.status, body: result.body } });
    }
  }

  for (const row of cnRows ?? []) {
    processed++;
    const prepared = await ensureSignedCreditNote(row);
    if ("error" in prepared) {
      failed++;
      await supabaseAdmin
        .from("zatca_credit_notes")
        .update({
          status: "failed",
          error_message: prepared.error,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      continue;
    }
    const result = await postReporting(cnEndpoint, prepared.signedXmlB64, prepared.invoiceHashB64, prepared.uuid);
    if (result.ok) {
      synced++;
      await advancePih(prepared.invoiceHashB64);
      await supabaseAdmin
        .from("zatca_credit_notes")
        .update({
          status: "synced",
          submitted_at: new Date().toISOString(),
          submitted_endpoint: cnEndpoint,
          response_payload: result.body,
          error_message: null,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await zatcaLog({ event: "queue.credit_note.synced", refType: "zatca_credit_notes", refId: row.id, detail: { status: result.status } });
    } else {
      failed++;
      const rejected = result.status >= 400 && result.status < 500;
      await supabaseAdmin
        .from("zatca_credit_notes")
        .update({
          status: rejected ? "rejected" : "failed",
          submitted_endpoint: cnEndpoint,
          response_payload: result.body,
          error_message: `HTTP ${result.status}`,
          retry_count: (row.retry_count ?? 0) + 1,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await zatcaLog({ level: "error", event: "queue.credit_note.failed", refType: "zatca_credit_notes", refId: row.id, detail: { status: result.status, body: result.body } });
    }
  }

  // Touch last_sync_at on settings.
  await supabaseAdmin
    .from("zatca_settings")
    .update({ last_sync_at: new Date().toISOString() })
    .eq("id", true);

  return { processed, synced, failed, skipped: 0 };
}

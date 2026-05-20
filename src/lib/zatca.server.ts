// Sprint F — ZATCA server-side helpers.
//
// SECURITY: server-only. Never import from client code.
// This file implements:
//   • TLV → base64 ZATCA Phase-1 QR encoder (real, deterministic).
//   • XML builder for simplified tax invoices (UBL 2.1 skeleton).
//   • Sandbox/simulation "submit" stub — DOES NOT touch the live Fatoora
//     gateway. Real submission is intentionally guarded behind explicit
//     environment="production" + onboarded device + admin approval.
//
// No private keys, no secrets, no live calls are made here yet. The next
// sprint phase (after the user generates the FATOORA OTP) will add the
// CSR + CSID + compliance/reporting calls.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash } from "crypto";

/* ────────────────── TLV QR (ZATCA Phase 1, simplified invoice) ──────────────────
 * Tag 1: Seller name        (UTF-8)
 * Tag 2: VAT number         (string)
 * Tag 3: Invoice timestamp  (ISO 8601, e.g. 2026-05-19T10:30:00Z)
 * Tag 4: Invoice total      (string, VAT-inclusive)
 * Tag 5: VAT total          (string)
 * Output: base64(concat(tag, length, value)*)
 */
export function buildZatcaTlvQr(input: {
  sellerName: string;
  vatNumber: string;
  isoTimestamp: string;
  totalWithVat: number;
  vatTotal: number;
}): string {
  const enc = new TextEncoder();
  const fields: { tag: number; bytes: Uint8Array }[] = [
    { tag: 1, bytes: enc.encode(input.sellerName) },
    { tag: 2, bytes: enc.encode(input.vatNumber) },
    { tag: 3, bytes: enc.encode(input.isoTimestamp) },
    { tag: 4, bytes: enc.encode(input.totalWithVat.toFixed(2)) },
    { tag: 5, bytes: enc.encode(input.vatTotal.toFixed(2)) },
  ];
  const parts: number[] = [];
  for (const f of fields) {
    parts.push(f.tag, f.bytes.length);
    for (const b of f.bytes) parts.push(b);
  }
  return Buffer.from(Uint8Array.from(parts)).toString("base64");
}

/* ────────────────── UBL 2.1 simplified-invoice XML skeleton ──────────────────
 * Intentionally schema-shaped (not yet signed). Phase 2 signing/clearance
 * is appended only after CSID onboarding succeeds.
 */
export function buildSimplifiedInvoiceXml(input: {
  invoiceNumber: string;
  issueIso: string;
  uuid: string;
  seller: { nameAr: string; vat: string; crNumber?: string; address?: string };
  totalWithVat: number;
  vatTotal: number;
  netExVat: number;
  discount: number;
  items: Array<{
    nameAr: string;
    qty: number;
    unitPriceIncVat: number;
    lineTotalIncVat: number;
  }>;
  isCreditNote?: boolean;
  originalInvoiceNumber?: string;
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const typeCode = input.isCreditNote ? "381" : "388";
  const subType = input.isCreditNote ? "0200000" : "0100000"; // simplified

  const lines = input.items
    .map(
      (it, i) => `
    <cac:InvoiceLine>
      <cbc:ID>${i + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">${it.qty}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="SAR">${it.lineTotalIncVat.toFixed(2)}</cbc:LineExtensionAmount>
      <cac:Item><cbc:Name>${esc(it.nameAr)}</cbc:Name></cac:Item>
      <cac:Price><cbc:PriceAmount currencyID="SAR">${it.unitPriceIncVat.toFixed(2)}</cbc:PriceAmount></cac:Price>
    </cac:InvoiceLine>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(input.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${input.uuid}</cbc:UUID>
  <cbc:IssueDate>${input.issueIso.slice(0, 10)}</cbc:IssueDate>
  <cbc:IssueTime>${input.issueIso.slice(11, 19)}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${subType}">${typeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  ${input.isCreditNote && input.originalInvoiceNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(input.originalInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${esc(input.seller.nameAr)}</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(input.seller.vat)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${input.vatTotal.toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${input.netExVat.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${input.netExVat.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${input.totalWithVat.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="SAR">${input.discount.toFixed(2)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="SAR">${input.totalWithVat.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>${lines}
  </cac:InvoiceLine>
</Invoice>`;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function zatcaLog(opts: {
  level?: "info" | "warn" | "error";
  event: string;
  refType?: string | null;
  refId?: string | null;
  detail?: unknown;
}): Promise<void> {
  try {
    await supabaseAdmin.from("zatca_logs").insert({
      level: opts.level ?? "info",
      event: opts.event,
      reference_type: opts.refType ?? null,
      reference_id: opts.refId ?? null,
      detail: (opts.detail ?? null) as any,
    });
  } catch (e) {
    console.error("[zatca_log] write failed:", e);
  }
}

/* ────────────────── Build + persist ZATCA tracking for an invoice ────────────────── */
export async function generateZatcaForInvoice(invoiceId: string): Promise<void> {
  // Load invoice + order + items + settings
  const { data: invoice, error: invErr } = await supabaseAdmin
    .from("invoices")
    .select("id, invoice_number, order_id, issued_at")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invErr || !invoice) {
    await zatcaLog({ level: "error", event: "generate.invoice_not_found", refType: "invoice", refId: invoiceId, detail: invErr });
    return;
  }
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, order_number, total_including_vat, vat_included_amount, net_amount_excluding_vat, discount_amount, created_at")
    .eq("id", (invoice as any).order_id)
    .maybeSingle();
  if (!order) return;
  const { data: items } = await supabaseAdmin
    .from("order_items")
    .select("name_snapshot, quantity, unit_price, line_total")
    .eq("order_id", (invoice as any).order_id);
  const { data: settings } = await supabaseAdmin
    .from("restaurant_settings")
    .select("legal_name_ar, brand_name_ar, vat_number, commercial_registration, national_address")
    .eq("id", true)
    .maybeSingle();
  const { data: zSettings } = await supabaseAdmin
    .from("zatca_settings")
    .select("environment, onboarding_status")
    .eq("id", true)
    .maybeSingle();

  const sellerName = (settings as any)?.legal_name_ar || (settings as any)?.brand_name_ar || "Yellow Chicken";
  const vatNumber = (settings as any)?.vat_number || "";
  const iso = new Date((invoice as any).issued_at ?? (order as any).created_at ?? Date.now()).toISOString();
  const total = Number((order as any).total_including_vat ?? 0);
  const vat = Number((order as any).vat_included_amount ?? 0);
  const net = Number((order as any).net_amount_excluding_vat ?? total - vat);
  const discount = Number((order as any).discount_amount ?? 0);

  const qrPayload = buildZatcaTlvQr({
    sellerName,
    vatNumber,
    isoTimestamp: iso,
    totalWithVat: total,
    vatTotal: vat,
  });

  const uuid = crypto.randomUUID();
  const xml = buildSimplifiedInvoiceXml({
    invoiceNumber: (invoice as any).invoice_number,
    issueIso: iso,
    uuid,
    seller: {
      nameAr: sellerName,
      vat: vatNumber,
      crNumber: (settings as any)?.commercial_registration,
      address: (settings as any)?.national_address,
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
  const xmlHash = sha256Hex(xml);

  const env = (zSettings as any)?.environment ?? "simulation";
  // We mark as "pending_sync" in BOTH environments. The actual call to ZATCA
  // (compliance/clearance/reporting) happens only after device onboarding is
  // complete. Simulation does not auto-mark as synced — admins explicitly
  // mark sandbox invoices from the dashboard or via the (future) sandbox call.
  await supabaseAdmin.from("zatca_invoices").upsert(
    {
      invoice_id: (invoice as any).id,
      order_id: (invoice as any).order_id,
      doc_type: "invoice",
      status: "pending_sync",
      environment: env,
      qr_payload: qrPayload,
      xml_hash: xmlHash,
      zatca_uuid: uuid,
    },
    { onConflict: "invoice_id" },
  );

  await zatcaLog({
    event: "invoice.generated",
    refType: "invoice",
    refId: (invoice as any).id,
    detail: { invoice_number: (invoice as any).invoice_number, env, total, vat },
  });
}

/* ────────────────── Credit-note generation for a refund ────────────────── */
export async function generateZatcaForRefund(refundId: string): Promise<void> {
  const { data: refund } = await supabaseAdmin
    .from("refunds")
    .select("id, order_id, amount, invoice_number, refunded_at")
    .eq("id", refundId)
    .maybeSingle();
  if (!refund) return;
  const { data: originalInv } = await supabaseAdmin
    .from("invoices")
    .select("id, invoice_number, issued_at")
    .eq("order_id", (refund as any).order_id)
    .maybeSingle();
  if (!originalInv) return;
  const { data: settings } = await supabaseAdmin
    .from("restaurant_settings")
    .select("legal_name_ar, brand_name_ar, vat_number, vat_rate")
    .eq("id", true)
    .maybeSingle();
  const { data: zSettings } = await supabaseAdmin
    .from("zatca_settings")
    .select("environment")
    .eq("id", true)
    .maybeSingle();

  const sellerName = (settings as any)?.legal_name_ar || (settings as any)?.brand_name_ar || "Yellow Chicken";
  const vatNumber = (settings as any)?.vat_number || "";
  const vatRate = Number((settings as any)?.vat_rate ?? 0.15);
  const amount = Number((refund as any).amount);
  const vatPortion = +(amount - amount / (1 + vatRate)).toFixed(2);
  const iso = new Date((refund as any).refunded_at ?? Date.now()).toISOString();

  const qrPayload = buildZatcaTlvQr({
    sellerName,
    vatNumber,
    isoTimestamp: iso,
    totalWithVat: amount,
    vatTotal: vatPortion,
  });
  const uuid = crypto.randomUUID();
  const xml = buildSimplifiedInvoiceXml({
    invoiceNumber: `CN-${(originalInv as any).invoice_number}`,
    issueIso: iso,
    uuid,
    seller: { nameAr: sellerName, vat: vatNumber },
    totalWithVat: amount,
    vatTotal: vatPortion,
    netExVat: +(amount - vatPortion).toFixed(2),
    discount: 0,
    items: [
      {
        nameAr: "Refund / إرجاع",
        qty: 1,
        unitPriceIncVat: amount,
        lineTotalIncVat: amount,
      },
    ],
    isCreditNote: true,
    originalInvoiceNumber: (originalInv as any).invoice_number,
  });
  const xmlHash = sha256Hex(xml);
  const env = (zSettings as any)?.environment ?? "simulation";

  await supabaseAdmin.from("zatca_credit_notes").upsert(
    {
      refund_id: (refund as any).id,
      original_invoice_id: (originalInv as any).id,
      order_id: (refund as any).order_id,
      amount,
      vat_amount: vatPortion,
      status: "pending_sync",
      environment: env,
      qr_payload: qrPayload,
      xml_hash: xmlHash,
      zatca_uuid: uuid,
    },
    { onConflict: "refund_id" },
  );
  await zatcaLog({
    event: "credit_note.generated",
    refType: "refund",
    refId: (refund as any).id,
    detail: { amount, vatPortion, env, original: (originalInv as any).invoice_number },
  });
}

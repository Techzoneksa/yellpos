// Sprint F-2 — ZATCA invoice signing & PIH chain (server-only).
//
// Implements:
//   • Canonical XML hash (SHA-256 → base64) used by ZATCA as the
//     "invoice hash" / PIH chain link.
//   • PIH lookup: the previous successfully reported hash, or the
//     base initial hash mandated by ZATCA for the first invoice.
//   • Signed XML scaffold — embeds invoice hash, PIH, ICV, and an
//     ECDSA-secp256k1 signature over the canonicalized XML. This is
//     the sandbox-compatible signed form; full UBL XAdES production
//     signing remains gated behind real CSID activation and explicit
//     production approval.
//
// SECURITY: server-only.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash } from "crypto";
import { ecdsaSignSha256, getDecryptedPrivateKeyHex, loadDeviceKeysRow } from "./zatca-crypto.server";

// ZATCA's well-known initial PIH — base64 of SHA-256("0").
const INITIAL_PIH_B64 = createHash("sha256").update("0").digest("base64");

export function canonicalize(xml: string): string {
  // Lightweight canonicalization sufficient for sandbox: collapse interior
  // whitespace between tags, trim, normalize line endings.
  return xml
    .replace(/\r\n/g, "\n")
    .replace(/>\s+</g, "><")
    .trim();
}

export function invoiceHashB64(xml: string): string {
  return createHash("sha256").update(canonicalize(xml)).digest("base64");
}

export async function getCurrentPih(): Promise<string> {
  const row = await loadDeviceKeysRow();
  if (row?.last_pih_b64) return row.last_pih_b64 as string;
  return INITIAL_PIH_B64;
}

export async function advancePih(newHashB64: string): Promise<void> {
  await supabaseAdmin
    .from("zatca_device_keys")
    .update({ last_pih_b64: newHashB64 })
    .eq("id", true);
}

/* ────────────────── Signed XML wrapper (sandbox-compatible) ──────────────────
 * We embed the ZATCA UBL-required identifiers as cbc:Note nodes so the
 * sandbox can read them without breaking the upstream UBL skeleton. The
 * full XAdES BasicSignedProperties chain is added by a follow-up sprint
 * after sandbox onboarding succeeds.
 */
export async function signInvoiceXml(input: {
  unsignedXml: string;
  icv: number;
  pihB64: string;
}): Promise<{ signedXml: string; invoiceHashB64: string; signatureB64: string }> {
  const hash = invoiceHashB64(input.unsignedXml);
  const skHex = await getDecryptedPrivateKeyHex();
  const sig = ecdsaSignSha256(skHex, Buffer.from(hash, "base64"));

  // Insert chain identifiers just after <cbc:UUID>
  const inject = `<cbc:Note languageID="en">ICV:${input.icv}</cbc:Note>
    <cbc:Note languageID="en">PIH:${input.pihB64}</cbc:Note>
    <cbc:Note languageID="en">IHASH:${hash}</cbc:Note>
    <cbc:Note languageID="en">SIG:${sig.sigB64}</cbc:Note>`;
  const signed = input.unsignedXml.replace(/(<cbc:UUID>[^<]+<\/cbc:UUID>)/, `$1${inject}`);
  return { signedXml: signed, invoiceHashB64: hash, signatureB64: sig.sigB64 };
}

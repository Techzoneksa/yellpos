import { NextRequest } from "next/server";
import { __fnRegistry } from "@/lib/tanstack-compat";

// Force Node.js runtime (this route uses Node-specific modules: Supabase, crypto, fs)
export const runtime = "nodejs";

// Force dynamic import of all function modules so the registry is populated
async function ensureRegistry() {
  if (__fnRegistry.size > 0) return;
  await Promise.all([
    import("@/lib/pos.functions"),
    import("@/lib/shifts.functions"),
    import("@/lib/catalog.functions"),
    import("@/lib/settings.functions"),
    import("@/lib/bootstrap.functions"),
    import("@/lib/reports.functions"),
    import("@/lib/ops.functions"),
    import("@/lib/finance.functions"),
    import("@/lib/hr.functions"),
    import("@/lib/user-mgmt.functions"),
    import("@/lib/audit.functions"),
    import("@/lib/zatca.functions"),
  ]);
}

export async function POST(request: NextRequest) {
  try {
    const { fnName, data: rawData } = await request.json();
    if (!fnName) return Response.json({ error: "Missing fnName" }, { status: 400 });

    await ensureRegistry();

    const fn = __fnRegistry.get(fnName);
    if (!fn) return Response.json({ error: `Unknown function: ${fnName}` }, { status: 404 });

    // Validate input
    let validated = rawData;
    if (fn._validator) {
      try {
        validated = fn._validator(rawData);
      } catch (err: any) {
        return Response.json({ error: err.message || "Validation failed" }, { status: 400 });
      }
    }

    // Execute handler
    const result = await fn._handler({ data: validated, context: {} });
    return Response.json(result);
  } catch (err: any) {
    console.error("[RPC]", err);
    return Response.json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}

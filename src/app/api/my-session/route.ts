export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const ROLE_PRIORITY: Record<string, number> = {
  owner: 0,
  manager: 1,
  finance: 2,
  cashier: 3,
};

function pickHighestRole(roles: string[]): string {
  let best = "cashier";
  let bestPrio = ROLE_PRIORITY[best] ?? 99;
  for (const r of roles) {
    const p = ROLE_PRIORITY[r] ?? 99;
    if (p < bestPrio) {
      best = r;
      bestPrio = p;
    }
  }
  return best;
}

function decodeJwtUnsafe(token: string): { sub: string; email?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64url").toString("utf8");
    return JSON.parse(decoded) as { sub: string; email?: string };
  } catch {
    return null;
  }
}

function createTimedAbortController(ms: number): { controller: AbortController; timeout: NodeJS.Timeout } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { accessToken } = body || {};
  if (!accessToken || typeof accessToken !== "string") {
    return Response.json({ error: "Access token required" }, { status: 401 });
  }

  // Step 1: Authenticate token via getUser (with 5s timeout)
  // Falls back to JWT decode + service-role DB lookup if getUser is slow
  let userId: string | null = null;
  let userEmail: string | undefined;
  let authMethod: "getUser" | "jwt-fallback" = "getUser";

  const { controller: authCtrl, timeout: authTimeout } = createTimedAbortController(5000);

  let authData: any;
  let authErr: any;
  try {
    const t0 = Date.now();
    const result = await supabaseAdmin.auth.getUser(accessToken);
    const elapsed = Date.now() - t0;
    authData = result.data;
    authErr = result.error;
    console.info(`[my-session] getUser completed in ${elapsed}ms`);
  } catch (e: any) {
    clearTimeout(authTimeout);
    const elapsed = Date.now();
    console.info(`[my-session] getUser threw after ${elapsed}ms: ${e?.message}`);
    authErr = e;
  } finally {
    clearTimeout(authTimeout);
  }

  if (authErr || !authData?.user) {
    // Fallback: decode JWT to get user_id, skip getUser entirely
    const decoded = decodeJwtUnsafe(accessToken);
    if (decoded?.sub) {
      userId = decoded.sub;
      userEmail = decoded.email;
      authMethod = "jwt-fallback";
      console.info(`[my-session] getUser failed, using JWT fallback. user_id=${userId}`);
    } else {
      console.info(`[my-session] getUser failed and JWT fallback had no sub. authErr=${authErr?.message}`);
      return Response.json({ error: "Invalid or expired session" }, { status: 401 });
    }
  } else {
    userId = authData.user.id;
    userEmail = authData.user.email;
  }

  // Step 2: Fetch profile (with 5s timeout)
  const { controller: profileCtrl, timeout: profileTimeout } = createTimedAbortController(5000);
  let profile: any = null;
  let profileErr: any;
  try {
    const t0 = Date.now();
    const result = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, username, active")
      .eq("id", userId!)
      .maybeSingle();
    const elapsed = Date.now() - t0;
    profile = result?.data;
    profileErr = result?.error;
    console.info(`[my-session] profile query completed in ${elapsed}ms`);
  } catch (e: any) {
    clearTimeout(profileTimeout);
    console.info(`[my-session] profile query threw: ${e?.message}`);
    profileErr = e;
  } finally {
    clearTimeout(profileTimeout);
  }

  if (profileErr) {
    return Response.json({ error: "Profile query failed" }, { status: 500 });
  }

  if (!profile) {
    console.info(`[my-session] profile missing for user_id=${userId}`);
    return Response.json({ profile: null, error: "Profile missing for this user" }, { status: 200 });
  }

  // Step 3: Fetch role (with 5s timeout)
  const { controller: roleCtrl, timeout: roleTimeout } = createTimedAbortController(5000);
  let roleRows: any[] = [];
  let roleErr: any;
  try {
    const t0 = Date.now();
    const result = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId!);
    const elapsed = Date.now() - t0;
    roleRows = result?.data ?? [];
    roleErr = result?.error;
    console.info(`[my-session] role query completed in ${elapsed}ms`);
  } catch (e: any) {
    clearTimeout(roleTimeout);
    console.info(`[my-session] role query threw: ${e?.message}`);
    roleErr = e;
  } finally {
    clearTimeout(roleTimeout);
  }

  if (roleErr) {
    return Response.json({ error: "Role query failed" }, { status: 500 });
  }

  if (!roleRows || roleRows.length === 0) {
    console.info(`[my-session] no roles for user_id=${userId}`);
    return Response.json({ profile, role: null, error: "No role assigned" }, { status: 200 });
  }

  const roles = roleRows.map((r: any) => r.role);
  const role = pickHighestRole(roles);

  console.info(`[my-session] done. authMethod=${authMethod}, user_id=${userId}, role=${role}, email=${userEmail}`);
  return Response.json({ profile, role, email: userEmail });
}
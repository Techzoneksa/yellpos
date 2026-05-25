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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  let authData: any;
  let authErr: any;
  try {
    const result = await supabaseAdmin.auth.getUser(accessToken);
    authData = result.data;
    authErr = result.error;
  } catch (e: any) {
    clearTimeout(timeout);
    return Response.json({ error: "Auth service unavailable" }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }

  if (authErr || !authData?.user) {
    return Response.json({ error: authErr?.message || "Invalid or expired session" }, { status: 401 });
  }

  const user = authData.user;

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, username, active")
    .eq("id", user.id)
    .maybeSingle();

  if (profileErr) {
    return Response.json({ error: "Profile query failed" }, { status: 500 });
  }

  if (!profile) {
    return Response.json({ profile: null, error: "Profile missing for this user" }, { status: 200 });
  }

  const { data: roleRows, error: roleErr } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);

  if (roleErr) {
    return Response.json({ error: "Role query failed" }, { status: 500 });
  }

  if (!roleRows || roleRows.length === 0) {
    return Response.json({ profile, role: null, error: "No role assigned" }, { status: 200 });
  }

  const roles = roleRows.map((r: any) => r.role);
  const role = pickHighestRole(roles);

  return Response.json({ profile, role, email: user.email });
}
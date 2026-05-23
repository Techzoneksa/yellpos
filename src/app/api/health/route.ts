export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  const checks = {
    server: true,
    supabase_url: Boolean(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabase_anon_key: Boolean(
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ),
    supabase_service_role_key: Boolean(serviceRole),
    service_role_is_publishable: serviceRole.startsWith("sb_publishable_"),
    service_role_is_secret_key: serviceRole.startsWith("sb_secret_"),
    service_role_is_legacy_jwt: serviceRole.startsWith("eyJ"),
    node_env: process.env.NODE_ENV === "production",
  };

  return Response.json({
    status: "ok",
    checks,
    timestamp: new Date().toISOString(),
  });
}

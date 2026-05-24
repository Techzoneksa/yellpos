export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: "Missing env vars" }, { status: 500 });
  }

  // Check if user exists in auth
  const userResp = await fetch(
    `${supabaseUrl}/auth/v1/admin/users?email=aabanurs@gmail.com`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const userData = await userResp.json();
  const user = Array.isArray(userData?.users) ? userData.users[0] : null;

  if (!user) {
    return Response.json({ error: "User not found in auth", userData });
  }

  // Check if email is confirmed
  const emailConfirmed = !!user.email_confirmed_at;
  const userMeta = user.user_metadata || {};

  // Check profile
  const profileResp = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}&select=id,username,full_name,active`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const profile = await profileResp.json();

  // Check role
  const roleResp = await fetch(
    `${supabaseUrl}/rest/v1/user_roles?user_id=eq.${user.id}&select=user_id,role`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const role = await roleResp.json();

  return Response.json({
    userExists: true,
    email: user.email,
    emailConfirmed,
    userMeta,
    profile: Array.isArray(profile) ? profile[0] || null : null,
    role: Array.isArray(role) ? role[0] || null : null,
    fixPasswordUrl: `${supabaseUrl}/auth/v1/admin/users/${user.id}`,
    message: emailConfirmed
      ? "المستخدم موجود. لوحة التحكم أو كلمة المرور قد تمنع الدخول. جرب إعادة تعيين كلمة المرور."
      : "البريد الإلكتروني غير مؤكد. هناك مشكلة في إنشاء المستخدم.",
  });
}

export async function POST(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: "Missing env vars" }, { status: 500 });
  }

  try {
    const body = await request.json();
    const { email, password } = body;

    // Find user
    const userResp = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email || "aabanurs@gmail.com")}`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const userData = await userResp.json();
    const user = Array.isArray(userData?.users) ? userData.users[0] : null;
    if (!user) return Response.json({ error: "User not found" }, { status: 404 });

    // Reset password
    const resetResp = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        password: password || "Sultan2030@%_Y",
        email_confirm: true,
      }),
    });
    const resetData = await resetResp.json();

    if (!resetResp.ok) {
      return Response.json({ error: resetData.msg || resetResp.statusText, detail: resetData }, { status: 500 });
    }

    return Response.json({
      success: true,
      message: "تم إعادة تعيين كلمة المرور. جرب تسجيل الدخول الآن.",
      email: "aabanurs@gmail.com",
      password: "Sultan2030@%_Y",
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

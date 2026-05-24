export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getOwnerCredentials() {
  const email = process.env.SEED_OWNER_EMAIL || "aabanurs@gmail.com";
  const password = process.env.SEED_OWNER_PASSWORD || "Sultan2030@%_Y";
  const username = process.env.SEED_OWNER_USERNAME || "sultan";
  const fullName = process.env.SEED_OWNER_FULLNAME || "Sultan";
  return { email, password, username, fullName };
}

async function getUsers(url: string, key: string) {
  const { email } = getOwnerCredentials();
  const resp = await fetch(`${url}/auth/v1/admin/users`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!resp.ok) return { error: `Auth API ${resp.status}` };
  const data = await resp.json();
  const users = data?.users || [];
  const user = users.find((u: any) => u.email === email) || null;
  return { user, allUsers: users.map((u: any) => ({ email: u.email, id: u.id })) };
}

async function fixProfile(url: string, key: string, userId: string) {
  const { fullName, username } = getOwnerCredentials();
  const pResp = await fetch(`${url}/rest/v1/profiles?id=eq.${userId}&select=id`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const pData = await pResp.json();
  const hasProfile = Array.isArray(pData) && pData.length > 0;

  if (!hasProfile) {
    await fetch(`${url}/rest/v1/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" },
      body: JSON.stringify({ id: userId, full_name: fullName, username, active: true }),
    });
  }

  const rResp = await fetch(`${url}/rest/v1/user_roles?user_id=eq.${userId}&select=user_id`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const rData = await rResp.json();
  const hasRole = Array.isArray(rData) && rData.length > 0;

  if (!hasRole) {
    await fetch(`${url}/rest/v1/user_roles?user_id=eq.${userId}`, {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    await fetch(`${url}/rest/v1/user_roles`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: userId, role: "owner" }),
    });
  }

  return { profileFixed: !hasProfile, roleFixed: !hasRole };
}

async function createFullOwner(url: string, key: string) {
  const { email, password, fullName, username } = getOwnerCredentials();
  const createResp = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, username, role: "owner" },
    }),
  });
  if (!createResp.ok) {
    const err = await createResp.json().catch(() => ({}));
    return { error: err.msg || createResp.statusText, code: createResp.status };
  }
  const data = await createResp.json();
  await fixProfile(url, key, data.id);
  return { created: true, id: data.id };
}

export async function GET(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: "Missing env vars" }, { status: 500 });
  }

  const { email } = getOwnerCredentials();
  const url = new URL(request.url);
  const autoFix = url.searchParams.get("fix") === "1";

  const { user, error, allUsers } = await getUsers(supabaseUrl, serviceKey);
  if (error) {
    return Response.json({ error: `Cannot reach Supabase Auth API: ${error}` }, { status: 500 });
  }
  if (!user) {
    const result = await createFullOwner(supabaseUrl, serviceKey);
    if (result.error) {
      return Response.json({
        userNotFound: true,
        allUsers,
        createError: result.error,
        message: `لم يتم العثور على ${email}. جرب حذف المستخدمين الموجودين من Supabase Auth ثم ارجع للرابط.`,
      });
    }
    return Response.json({
      success: true,
      message: `تم إنشاء المستخدم ${email} والبروفايل والصلاحية. سجل دخول الآن.`,
    });
  }

  const { profileFixed, roleFixed } = autoFix ? await fixProfile(supabaseUrl, serviceKey, user.id) : { profileFixed: false, roleFixed: false };

  return Response.json({
    email: user.email,
    emailConfirmed: !!user.email_confirmed_at,
    userMeta: user.user_metadata || {},
    profileFixed,
    roleFixed,
    message: profileFixed || roleFixed
      ? "تم إصلاح البيانات الناقصة. جرب تسجيل الدخول الآن."
      : "البيانات كاملة. جرب إعادة تعيين كلمة المرور عبر POST request.",
    fixUrl: `${supabaseUrl}/seed-owner?fix=1`,
  });
}

export async function POST(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: "Missing env vars" }, { status: 500 });
  }

  const { email, password } = getOwnerCredentials();

  const { user, error } = await getUsers(supabaseUrl, serviceKey);
  if (error) return Response.json({ error: `Auth API error: ${error}` }, { status: 500 });
  if (!user) {
    const result = await createFullOwner(supabaseUrl, serviceKey);
    if (result.error) return Response.json({ error: result.error }, { status: 500 });
    return Response.json({ success: true, message: "تم إنشاء المالك" });
  }

  const resetResp = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ password, email_confirm: true }),
  });
  if (!resetResp.ok) {
    const err = await resetResp.json().catch(() => ({}));
    return Response.json({ error: err.msg || resetResp.statusText }, { status: 500 });
  }

  await fixProfile(supabaseUrl, serviceKey, user.id);

  return Response.json({
    success: true,
    message: "تم إعادة تعيين كلمة المرور وإصلاح البيانات. سجل دخول الآن.",
  });
}

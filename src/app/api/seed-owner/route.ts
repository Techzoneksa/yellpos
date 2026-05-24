export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function migrationSQL(): string {
  return `-- Run this in Supabase Dashboard > SQL Editor
-- ========== Yellow Chicken POS Schema ==========
create type if not exists public.app_role as enum ('owner','manager','finance','cashier');
create table if not exists public.profiles (id uuid primary key references auth.users(id) on delete cascade, full_name text not null default '', username text unique not null, active boolean not null default true, last_login timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
alter table public.profiles enable row level security;
create table if not exists public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, role public.app_role not null, created_at timestamptz not null default now(), unique(user_id, role));
alter table public.user_roles enable row level security;
create or replace function public.has_role(_user_id uuid, _role public.app_role) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.user_roles where user_id = _user_id and role = _role) $$;
create or replace function public.is_admin(_user_id uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.user_roles where user_id = _user_id and role in ('owner','manager')) $$;
do $$ begin if not exists (select 1 from pg_policies where policyname = 'Users can view their own profile') then create policy "Users can view their own profile" on public.profiles for select using (auth.uid() = id); end if; if not exists (select 1 from pg_policies where policyname = 'Admins can view all profiles') then create policy "Admins can view all profiles" on public.profiles for select using (public.is_admin(auth.uid())); end if; if not exists (select 1 from pg_policies where policyname = 'Users can update their own profile') then create policy "Users can update their own profile" on public.profiles for update using (auth.uid() = id); end if; if not exists (select 1 from pg_policies where policyname = 'Admins can update any profile') then create policy "Admins can update any profile" on public.profiles for update using (public.is_admin(auth.uid())); end if; if not exists (select 1 from pg_policies where policyname = 'Admins can insert profiles') then create policy "Admins can insert profiles" on public.profiles for insert with check (public.is_admin(auth.uid())); end if; if not exists (select 1 from pg_policies where policyname = 'Admins can delete profiles') then create policy "Admins can delete profiles" on public.profiles for delete using (public.is_admin(auth.uid())); end if; if not exists (select 1 from pg_policies where policyname = 'Users can view their own roles') then create policy "Users can view their own roles" on public.user_roles for select using (auth.uid() = user_id); end if; if not exists (select 1 from pg_policies where policyname = 'Admins can view all roles') then create policy "Admins can view all roles" on public.user_roles for select using (public.is_admin(auth.uid())); end if; if not exists (select 1 from pg_policies where policyname = 'Admins manage roles') then create policy "Admins manage roles" on public.user_roles for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid())); end if; end $$;
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists profiles_touch on public.profiles; create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$ declare v_username text; v_full_name text; v_role public.app_role; begin v_username := coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)); v_full_name := coalesce(new.raw_user_meta_data->>'full_name', ''); v_role := coalesce((new.raw_user_meta_data->>'role')::public.app_role, 'cashier'::public.app_role); if exists (select 1 from public.profiles where id = new.id) then return new; end if; if exists (select 1 from public.profiles where username = v_username) then v_username := v_username || '_' || substr(new.id::text, 1, 6); end if; insert into public.profiles (id, full_name, username) values (new.id, v_full_name, v_username); insert into public.user_roles (user_id, role) values (new.id, v_role) on conflict do nothing; return new; end; $$;
drop trigger if exists on_auth_user_created on auth.users; create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();`;
}

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!supabaseUrl || !serviceKey) {
    return Response.json({
      error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      supabaseUrl: !!supabaseUrl,
      serviceKey: !!serviceKey,
    }, { status: 500 });
  }

  // 1. Test connectivity: try to reach Supabase Auth API
  let authReachable = false;
  let dbReachable = false;
  let diag: any = {};

  try {
    const testResp = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    authReachable = testResp.ok || testResp.status === 401;
    diag.authStatus = testResp.status;
    diag.authStatusText = testResp.statusText;
  } catch (e: any) {
    diag.authError = e?.cause?.code || e.message;
  }

  try {
    const dbResp = await fetch(`${supabaseUrl}/rest/v1/profiles?select=id&limit=1&head=true`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    dbReachable = true;
    diag.dbStatus = dbResp.status;
  } catch (e: any) {
    diag.dbError = e?.cause?.code || e.message;
  }

  // If Supabase API unreachable, show diagnostics
  if (!authReachable || !dbReachable) {
    return Response.json({
      error: "Cannot reach Supabase API from this server",
      diagnostics: diag,
      supabaseUrl: supabaseUrl,
      tips: [
        "تحقق من أن Supabase URL صحيح",
        "تأكد من أن مشروع Supabase غير متوقف (Paused)",
        "إذا كنت في Hostinger، قد يكون هناك حاجة لتفعيل Outbound Access في خطة الاستضافة",
      ],
    });
  }

  // 2. Check if tables exist
  const tablesExist = await (async () => {
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/profiles?select=id&limit=1&head=true`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      return r.status !== 404;
    } catch { return false; }
  })();

  if (!tablesExist) {
    return Response.json({
      needsMigration: true,
      message: "جداول قاعدة البيانات غير موجودة. شغّل الـ SQL أدناه في Supabase Dashboard > SQL Editor ثم ارجع لهذا الرابط",
      migrationSQL: migrationSQL(),
    });
  }

  // 3. Check if profiles exist
  const countResp = await fetch(`${supabaseUrl}/rest/v1/profiles?select=id&limit=0`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const countData = await countResp.json();
  const profileCount = Array.isArray(countData) ? countData.length : 0;

  if (profileCount > 0) {
    return Response.json({
      success: true,
      message: "يوجد مستخدمون بالفعل. سجل دخول: aabanurs@gmail.com / Sultan2030@%_Y",
      loginUrl: "https://crmprom.com/",
    });
  }

  // 4. Create auth user via Admin API
  const body = JSON.stringify({
    email: "aabanurs@gmail.com",
    password: "Sultan2030@%_Y",
    email_confirm: true,
    user_metadata: { full_name: "Sultan", username: "sultan", role: "owner" },
  });

  const createResp = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body,
  });

  const createData = await createResp.json();
  if (!createResp.ok) {
    return Response.json({
      error: createData.msg || createData.error || createResp.statusText,
      hint: "تأكد من أن SUPABASE_SERVICE_ROLE_KEY هو legacy service_role JWT (eyJ...) من Supabase Dashboard > Settings > API > Legacy keys",
    }, { status: 500 });
  }

  const userId = createData.id;

  // 5. Insert into profiles
  await fetch(`${supabaseUrl}/rest/v1/profiles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ id: userId, full_name: "Sultan", username: "sultan", active: true }),
  });

  // 6. Insert into user_roles
  await fetch(`${supabaseUrl}/rest/v1/user_roles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ user_id: userId, role: "owner" }),
  });

  return Response.json({
    success: true,
    message: "تم إنشاء المالك بنجاح! سجل دخول: aabanurs@gmail.com / Sultan2030@%_Y",
    loginUrl: "https://crmprom.com/",
  });
}

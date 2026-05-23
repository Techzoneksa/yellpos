export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient } from "@supabase/supabase-js";

async function getAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function migrationSQL(): string {
  return `-- Run this in Supabase Dashboard > SQL Editor
-- ========== Yellow Chicken POS Schema ==========

create type if not exists public.app_role as enum ('owner','manager','finance','cashier');

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  username text unique not null,
  active boolean not null default true,
  last_login timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique(user_id, role)
);

alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.user_roles where user_id = _user_id and role = _role) $$;

create or replace function public.is_admin(_user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.user_roles where user_id = _user_id and role in ('owner','manager')) $$;

-- RLS policies
do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'Users can view their own profile') then
    create policy "Users can view their own profile" on public.profiles for select using (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Admins can view all profiles') then
    create policy "Admins can view all profiles" on public.profiles for select using (public.is_admin(auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Users can update their own profile') then
    create policy "Users can update their own profile" on public.profiles for update using (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Admins can update any profile') then
    create policy "Admins can update any profile" on public.profiles for update using (public.is_admin(auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Admins can insert profiles') then
    create policy "Admins can insert profiles" on public.profiles for insert with check (public.is_admin(auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Admins can delete profiles') then
    create policy "Admins can delete profiles" on public.profiles for delete using (public.is_admin(auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Users can view their own roles') then
    create policy "Users can view their own roles" on public.user_roles for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Admins can view all roles') then
    create policy "Admins can view all roles" on public.user_roles for select using (public.is_admin(auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'Admins manage roles') then
    create policy "Admins manage roles" on public.user_roles for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
  end if;
end $$;

-- Trigger for updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_username text; v_full_name text; v_role public.app_role;
begin
  v_username := coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1));
  v_full_name := coalesce(new.raw_user_meta_data->>'full_name', '');
  v_role := coalesce((new.raw_user_meta_data->>'role')::public.app_role, 'cashier'::public.app_role);
  if exists (select 1 from public.profiles where id = new.id) then return new; end if;
  if exists (select 1 from public.profiles where username = v_username) then v_username := v_username || '_' || substr(new.id::text, 1, 6); end if;
  insert into public.profiles (id, full_name, username) values (new.id, v_full_name, v_username);
  insert into public.user_roles (user_id, role) values (new.id, v_role) on conflict do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();`;
}

export async function GET() {
  const supabase = await getAdmin();
  if (!supabase) {
    return Response.json({ error: "Supabase not configured", missingEnv: true }, { status: 500 });
  }

  // Check if tables exist
  const { error: tableCheck } = await supabase.from("profiles").select("id", { count: "exact", head: true });

  if (tableCheck && (tableCheck.message?.includes("does not exist") || tableCheck.code === "PGRST116" || tableCheck.code === "42P01")) {
    return Response.json({
      exists: false,
      message: "جداول قاعدة البيانات غير موجودة. شغّل الـ SQL أدناه في Supabase Dashboard > SQL Editor",
      migrationSQL: migrationSQL(),
    });
  }

  // Tables exist — check if owner already exists
  const { count } = await supabase.from("profiles").select("id", { count: "exact", head: true });

  if ((count ?? 0) > 0) {
    const { data: existingUser } = await supabase.from("profiles").select("id, username").eq("username", "sultan").maybeSingle();
    if (existingUser) {
      return Response.json({
        exists: true,
        message: "المالك موجود بالفعل! سجل دخول: aabanurs@gmail.com / Sultan2030@%_Y",
        loginUrl: "https://crmprom.com/pos/login",
      });
    }
    return Response.json({
      exists: true,
      message: "يوجد مستخدمون في النظام. المالك لم يتم إنشاؤه بعد. استخدم bootstrap page أو SQL Editor.",
    });
  }

  // Create the owner
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: "aabanurs@gmail.com",
    password: "Sultan2030@%_Y",
    email_confirm: true,
    user_metadata: { full_name: "Sultan", username: "sultan", role: "owner" },
  });

  if (createErr) {
    return Response.json({
      error: createErr.message,
      hint: "تأكد من أن SUPABASE_SERVICE_ROLE_KEY هو legacy service_role JWT (eyJ...) وليس sb_secret_",
    }, { status: 500 });
  }

  const id = created.user!.id;

  await supabase.from("profiles").update({ full_name: "Sultan", username: "sultan", active: true }).eq("id", id);
  await supabase.from("user_roles").delete().eq("user_id", id);
  await supabase.from("user_roles").insert({ user_id: id, role: "owner" });

  return Response.json({
    success: true,
    message: "تم إنشاء المالك بنجاح! سجل دخول: aabanurs@gmail.com / Sultan2030@%_Y",
    loginUrl: "https://crmprom.com/",
  });
}

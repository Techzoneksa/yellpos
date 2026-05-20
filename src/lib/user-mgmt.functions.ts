// Server functions for user management. Owner/Manager only.
import { createServerFn, registerFn, requireSupabaseAuth } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type AppRole = "owner" | "manager" | "finance" | "cashier";

export type UserDTO = {
  id: string;
  full_name: string;
  username: string;
  email: string | null;
  role: AppRole;
  active: boolean;
  last_login: string | null;
  created_at: string;
};

const usernameSchema = z
  .string()
  .min(2)
  .max(50)
  .regex(/^[a-zA-Z0-9_.-]+$/, "Username may only contain letters, numbers, _, ., -");

const roleSchema = z.enum(["owner", "manager", "finance", "cashier"]);

function cashierEmail(username: string) {
  return `${username.toLowerCase()}@pos.local`;
}

async function ensureCallerIsAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["owner", "manager"]);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Forbidden: admin role required");
}

async function loadUsers(): Promise<UserDTO[]> {
  const { data: profiles, error: pErr } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, username, active, last_login, created_at")
    .order("created_at", { ascending: false });
  if (pErr) throw new Error(pErr.message);

  const { data: roles, error: rErr } = await supabaseAdmin
    .from("user_roles")
    .select("user_id, role");
  if (rErr) throw new Error(rErr.message);

  const roleByUser = new Map<string, AppRole>();
  for (const r of roles ?? []) roleByUser.set(r.user_id, r.role as AppRole);

  // pull emails via admin api
  const { data: authUsers, error: aErr } = await supabaseAdmin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (aErr) throw new Error(aErr.message);
  const emailByUser = new Map<string, string | null>();
  for (const u of authUsers.users) emailByUser.set(u.id, u.email ?? null);

  return (profiles ?? []).map((p) => {
    const email = emailByUser.get(p.id) ?? null;
    const role = roleByUser.get(p.id) ?? "cashier";
    return {
      id: p.id,
      full_name: p.full_name,
      username: p.username,
      email: role === "cashier" ? null : email,
      role,
      active: p.active,
      last_login: p.last_login,
      created_at: p.created_at,
    };
  });
}

/* ──────────────── list users ──────────────── */
export const listUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureCallerIsAdmin(context.userId);
    return loadUsers();
  });
registerFn('listUsers', listUsers);

/* ──────────────── create user ──────────────── */
export const createUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        fullName: z.string().min(1).max(120),
        username: usernameSchema,
        role: roleSchema,
        email: z.string().email().optional().nullable(),
        password: z.string().min(4).max(128),
        active: z.boolean().optional().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await ensureCallerIsAdmin(context.userId);
    const uname = data.username.toLowerCase();
    const email = data.role === "cashier" ? cashierEmail(uname) : data.email;
    if (!email) throw new Error("Email is required for dashboard users");

    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: data.password,
      email_confirm: true,
      user_metadata: {
        full_name: data.fullName,
        username: uname,
        role: data.role,
      },
    });
    if (error) throw new Error(error.message);
    const newId = created.user!.id;

    // Trigger created profile + cashier role by default. Force the right role/state.
    await supabaseAdmin
      .from("profiles")
      .update({ full_name: data.fullName, username: uname, active: data.active ?? true })
      .eq("id", newId);

    await supabaseAdmin.from("user_roles").delete().eq("user_id", newId);
    await supabaseAdmin.from("user_roles").insert({ user_id: newId, role: data.role });

    return { id: newId };
  });
registerFn('createUser', createUser);

/* ──────────────── update user (no credentials) ──────────────── */
export const updateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        fullName: z.string().min(1).max(120),
        username: usernameSchema,
        role: roleSchema,
        email: z.string().email().optional().nullable(),
        active: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await ensureCallerIsAdmin(context.userId);
    const uname = data.username.toLowerCase();

    await supabaseAdmin
      .from("profiles")
      .update({ full_name: data.fullName, username: uname, active: data.active })
      .eq("id", data.id);

    // Update email
    const newEmail = data.role === "cashier" ? cashierEmail(uname) : data.email;
    if (newEmail) {
      const { error: eErr } = await supabaseAdmin.auth.admin.updateUserById(data.id, {
        email: newEmail,
        email_confirm: true,
        user_metadata: { full_name: data.fullName, username: uname, role: data.role },
      });
      if (eErr) throw new Error(eErr.message);
    }

    // Update role if changed
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.id);
    await supabaseAdmin.from("user_roles").insert({ user_id: data.id, role: data.role });

    return { ok: true };
  });
registerFn('updateUser', updateUser);

/* ──────────────── reset credentials ──────────────── */
export const resetCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        password: z.string().min(4).max(128),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await ensureCallerIsAdmin(context.userId);
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.id, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('resetCredentials', resetCredentials);

/* ──────────────── toggle active ──────────────── */
export const setUserActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ id: z.string().uuid(), active: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await ensureCallerIsAdmin(context.userId);
    await supabaseAdmin.from("profiles").update({ active: data.active }).eq("id", data.id);
    // Also ban/unban auth user so inactive accounts can't login
    await supabaseAdmin.auth.admin.updateUserById(data.id, {
      ban_duration: data.active ? "none" : "876000h", // ~100 years
    });
    return { ok: true };
  });
registerFn('setUserActive', setUserActive);

/* ──────────────── delete user ──────────────── */
export const deleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await ensureCallerIsAdmin(context.userId);
    if (data.id === context.userId) throw new Error("Cannot delete yourself");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('deleteUser', deleteUser);

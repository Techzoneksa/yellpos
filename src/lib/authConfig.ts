// Real auth via Supabase. Cashiers use synthetic email {username}@pos.local + PIN as password.
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "owner" | "manager" | "finance" | "cashier";

export type SessionUser = {
  id: string;
  fullName: string;
  username: string;
  email: string | null;
  role: AppRole;
};

function cashierEmail(username: string) {
  return `${username.trim().toLowerCase()}@pos.local`;
}

const STUB_ERR = "Supabase not configured";

function isStubError(err: any): boolean {
  return err?.message === STUB_ERR || (typeof err === "string" && err === STUB_ERR);
}

async function fetchMySession(): Promise<SessionUser | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session ?? null;
  if (!session) throw new Error("Session missing after login");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let res: Response;
  try {
    res = await fetch("/api/my-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: session.access_token }),
      signal: controller.signal,
    });
  } catch (fetchErr: any) {
    clearTimeout(timeout);
    if (fetchErr?.name === "AbortError") {
      throw new Error("انتهت مهلة الاتصال بالخادم");
    }
    throw new Error("تعذر الاتصال بالخادم");
  } finally {
    clearTimeout(timeout);
  }

  const result = await res.json().catch(() => ({ error: "Invalid response from server" }));

  if (!res.ok) {
    const msg = result?.error || "Role lookup failed";
    if (msg.includes("Invalid session") || msg.includes("Access token") || msg.includes("expired")) {
      throw new Error("انتهت الجلسة، يرجى تسجيل الدخول مجددًا");
    }
    throw new Error(msg);
  }

  if (!result.profile) {
    throw new Error("تعذر جلب بيانات الحساب");
  }

  if (!result.profile.active) {
    await supabase.auth.signOut();
    throw new Error("الحساب غير مفعل");
  }

  if (!result.role) {
    throw new Error("لا يوجد دور مسجل لهذا المستخدم");
  }

  return {
    id: result.profile.id,
    fullName: result.profile.full_name,
    username: result.profile.username,
    email: result.email ?? null,
    role: result.role as AppRole,
  };
}

export async function signInCashier(username: string, pin: string): Promise<SessionUser> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: cashierEmail(username),
    password: pin,
  });
  if (isStubError(error)) throw new Error("Supabase client not configured — check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are set during build");
  if (error || !data.user) {
    if (error?.message?.includes("Email not confirmed")) throw new Error("Email not confirmed");
    if (error?.status === 400 || error?.status === 401) throw new Error("Password is incorrect or not synced with Supabase Auth");
    throw new Error("Invalid credentials");
  }
  const u = await fetchMySession();
  if (!u) throw new Error("Profile missing");
  if (u.role !== "cashier") {
    await supabase.auth.signOut();
    throw new Error("Not a cashier account");
  }
  await supabase.from("profiles").update({ last_login: new Date().toISOString() }).eq("id", u.id);
  return u;
}

export async function signInAdmin(email: string, password: string): Promise<SessionUser> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (isStubError(error)) throw new Error("Supabase client not configured — check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are set during build");
  if (error || !data.user) {
    if (error?.message?.includes("Email not confirmed")) throw new Error("البريد الإلكتروني غير مؤكد");
    if (error?.status === 400 || error?.status === 401) throw new Error("كلمة المرور غير صحيحة");
    throw new Error("بيانات الدخول غير صحيحة");
  }
  const u = await fetchMySession();
  if (!u) throw new Error("Login succeeded but role lookup failed");
  if (u.role === "cashier") {
    await supabase.auth.signOut();
    throw new Error("الرجاء استخدام دخول الكاشير");
  }
  await supabase.from("profiles").update({ last_login: new Date().toISOString() }).eq("id", u.id);
  return u;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getCurrentSessionUser(): Promise<SessionUser | null> {
  try {
    const sessionResult = await supabase.auth.getSession();
    const session = sessionResult?.data?.session ?? null;
    if (!session?.user) return null;
    return await fetchMySession();
  } catch {
    return null;
  }
}

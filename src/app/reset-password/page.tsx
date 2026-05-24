"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function PasswordInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} type={show ? "text" : "password"} required className="h-11 pe-10" />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">
        {show ? "إخفاء" : "إظهار"}
      </button>
    </div>
  );
}

export default function ResetPasswordPage() {
  const [step, setStep] = useState<"parsing" | "expired" | "invalid" | "ready" | "done">("parsing");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);

    const type = params.get("type");
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const error = params.get("error");

    if (error === "otp_expired") {
      setStep("expired");
      return;
    }

    if (type !== "recovery" || !accessToken || !refreshToken) {
      setStep("invalid");
      return;
    }

    supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error: sessionErr }) => {
        if (sessionErr) {
          setStep("invalid");
        } else {
          setStep("ready");
        }
      })
      .catch(() => {
        setStep("invalid");
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr("");

    if (password.length < 8) {
      setErr("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
      return;
    }
    if (password !== confirm) {
      setErr("كلمة المرور غير متطابقة");
      return;
    }

    setBusy(true);
    try {
      const { error: updateErr } = await supabase.auth.updateUser({ password });
      if (updateErr) {
        setErr(updateErr.message);
        return;
      }
      setStep("done");
    } catch {
      setErr("حدث خطأ أثناء تغيير كلمة المرور");
    } finally {
      setBusy(false);
    }
  };

  if (step === "parsing") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">جاري التحقق من الرابط...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="card-soft p-7 sm:p-8">
          <div className="mb-6 flex flex-col items-center text-center">
            <Logo className="h-14 w-auto" />
            <h1 className="mt-4 text-xl font-bold">إعادة تعيين كلمة المرور</h1>
          </div>

          {step === "expired" && (
            <p className="text-center text-sm text-destructive">
              انتهت صلاحية رابط إعادة تعيين كلمة المرور. اطلب رابطًا جديدًا.
            </p>
          )}

          {step === "invalid" && (
            <p className="text-center text-sm text-destructive">
              رابط إعادة تعيين كلمة المرور غير صالح أو منتهي.
            </p>
          )}

          {step === "done" && (
            <>
              <p className="mb-4 text-center text-sm text-success">تم تغيير كلمة المرور بنجاح</p>
              <Button onClick={() => { window.location.href = "/dashboard/login"; }} className="h-11 w-full">
                تسجيل الدخول
              </Button>
            </>
          )}

          {step === "ready" && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">كلمة المرور الجديدة</label>
                <PasswordInput value={password} onChange={setPassword} />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">تأكيد كلمة المرور</label>
                <PasswordInput value={confirm} onChange={setConfirm} />
              </div>
              {err && <p className="text-xs text-destructive">{err}</p>}
              <Button type="submit" disabled={busy} className="h-11 w-full">
                {busy ? "..." : "تغيير كلمة المرور"}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

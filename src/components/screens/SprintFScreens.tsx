// Sprint F — ZATCA / E-Invoicing dashboard.
// Tabs: Setup • Onboarding • Queue • Failed • Synced • Credit Notes • Logs.
// All data live from backend. No mock rows.
import { useEffect, useMemo, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useApp } from "@/lib/store";
import {
  getZatcaSettings, updateZatcaSettings,
  verifyOnboardingReadiness, submitOnboardingOtp,
  listZatcaInvoices, listZatcaCreditNotes, listZatcaLogs,
  retryZatcaInvoice, prepareDeviceCsr, getDeviceStatus, processZatcaQueue,
} from "@/lib/zatca.functions";

const STATUS_LABEL: Record<string, { ar: string; en: string; cls: string }> = {
  pending_generation: { ar: "قيد التوليد", en: "Pending generation", cls: "bg-muted text-foreground" },
  generated:           { ar: "تم التوليد",  en: "Generated",           cls: "bg-muted text-foreground" },
  pending_sync:        { ar: "بانتظار الإرسال", en: "Pending sync",   cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  synced:              { ar: "تم الإرسال",  en: "Synced",              cls: "bg-success/15 text-success" },
  failed:              { ar: "فشل",         en: "Failed",              cls: "bg-destructive/15 text-destructive" },
  rejected:            { ar: "مرفوض",       en: "Rejected",            cls: "bg-destructive/15 text-destructive" },
};

function StatusBadge({ s, lang }: { s: string; lang: "ar" | "en" }) {
  const m = STATUS_LABEL[s] ?? { ar: s, en: s, cls: "bg-muted" };
  return <span className={`rounded-full px-2 py-0.5 text-xs ${m.cls}`}>{lang === "ar" ? m.ar : m.en}</span>;
}

export function ManagerZatcaHub() {
  const { lang } = useApp();
  return (
    <div className="min-h-screen bg-background">
      <TopBar title={lang === "ar" ? "الفوترة الإلكترونية (ZATCA)" : "E-Invoicing (ZATCA)"} />
      <div className="mx-auto max-w-7xl p-4">
        <Tabs defaultValue="setup">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="setup">{lang === "ar" ? "الإعداد" : "Setup"}</TabsTrigger>
            <TabsTrigger value="onboarding">{lang === "ar" ? "تسجيل الجهاز" : "Device Onboarding"}</TabsTrigger>
            <TabsTrigger value="queue">{lang === "ar" ? "قائمة الإرسال" : "Sync Queue"}</TabsTrigger>
            <TabsTrigger value="failed">{lang === "ar" ? "الفواتير الفاشلة" : "Failed"}</TabsTrigger>
            <TabsTrigger value="synced">{lang === "ar" ? "تم الإرسال" : "Synced"}</TabsTrigger>
            <TabsTrigger value="credit">{lang === "ar" ? "إشعارات دائنة" : "Credit Notes"}</TabsTrigger>
            <TabsTrigger value="logs">{lang === "ar" ? "السجلات" : "Logs"}</TabsTrigger>
          </TabsList>
          <TabsContent value="setup"><SetupTab /></TabsContent>
          <TabsContent value="onboarding"><OnboardingTab /></TabsContent>
          <TabsContent value="queue"><InvoicesTab statusFilter="pending_sync" /></TabsContent>
          <TabsContent value="failed"><InvoicesTab statusFilter="failed" allowRetry /></TabsContent>
          <TabsContent value="synced"><InvoicesTab statusFilter="synced" /></TabsContent>
          <TabsContent value="credit"><CreditNotesTab /></TabsContent>
          <TabsContent value="logs"><LogsTab /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/* ─────────── Setup ─────────── */
function SetupTab() {
  const { lang } = useApp();
  const [settings, setSettings] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { getZatcaSettings().then(setSettings).catch((e: any) => toast.error(e.message)); }, []);
  if (!settings) return <p className="p-6 text-sm text-muted-foreground">{lang === "ar" ? "جارٍ التحميل..." : "Loading..."}</p>;

  async function save(patch: any) {
    setBusy(true);
    try {
      const row = await updateZatcaSettings({ data: patch });
      setSettings(row);
      toast.success(lang === "ar" ? "تم الحفظ" : "Saved");
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Card><CardContent className="space-y-4 p-6">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Label>{lang === "ar" ? "البيئة" : "Environment"}</Label>
          <Select value={settings.environment} onValueChange={(v) => save({ environment: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="simulation">{lang === "ar" ? "محاكاة (Sandbox)" : "Simulation (Sandbox)"}</SelectItem>
              <SelectItem value="production">{lang === "ar" ? "الإنتاج" : "Production"}</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">
            {lang === "ar"
              ? "لا يمكن تفعيل الإنتاج إلا بعد إكمال تسجيل الجهاز."
              : "Production can only be enabled after device onboarding completes."}
          </p>
        </div>
        <div>
          <Label>{lang === "ar" ? "اسم الجهاز" : "Device name"}</Label>
          <Input defaultValue={settings.device_name} onBlur={(e) => e.target.value !== settings.device_name && save({ device_name: e.target.value })} />
        </div>
        <div>
          <Label>{lang === "ar" ? "الرقم التسلسلي" : "Serial"}</Label>
          <Input defaultValue={settings.device_serial} onBlur={(e) => e.target.value !== settings.device_serial && save({ device_serial: e.target.value })} />
        </div>
        <div>
          <Label>{lang === "ar" ? "حالة التسجيل" : "Onboarding status"}</Label>
          <div className="mt-2"><Badge>{settings.onboarding_status}</Badge></div>
        </div>
        <div>
          <Label>{lang === "ar" ? "آخر مزامنة" : "Last sync"}</Label>
          <div className="mt-2 text-sm text-muted-foreground">{settings.last_sync_at ?? (lang === "ar" ? "لا يوجد" : "—")}</div>
        </div>
        <div>
          <Label>{lang === "ar" ? "آخر خطأ" : "Last error"}</Label>
          <div className="mt-2 text-sm text-muted-foreground">{settings.last_error ?? "—"}</div>
        </div>
      </div>
      <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        {lang === "ar"
          ? "المفاتيح والشهادات تُحفظ على الخادم فقط ولا تظهر هنا."
          : "Private keys and certificates are stored server-side and never shown in the UI."}
      </p>
      {busy && <p className="text-xs text-muted-foreground">…</p>}
    </CardContent></Card>
  );
}

/* ─────────── Onboarding ─────────── */
function OnboardingTab() {
  const { lang } = useApp();
  const [verify, setVerify] = useState<any>(null);
  const [device, setDevice] = useState<any>(null);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    try {
      const [v, d] = await Promise.all([verifyOnboardingReadiness(), getDeviceStatus()]);
      setVerify(v); setDevice(d);
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { check(); /* eslint-disable-next-line */ }, []);

  async function prepare() {
    setBusy(true);
    try {
      const r = await prepareDeviceCsr();
      toast.success(lang === "ar" ? `تم توليد CSR (${r.csrLength} حرف)` : `CSR generated (${r.csrLength} chars)`);
      await check();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!otp.trim()) return;
    setBusy(true);
    try {
      const res = await submitOnboardingOtp({ data: { otp: otp.trim() } });
      if (res.ok) {
        toast.success(lang === "ar" ? "تم استلام CSID من ZATCA" : "CSID obtained from ZATCA");
      } else {
        toast.error(res.error ?? (lang === "ar" ? "فشل الطلب" : "Request failed"));
      }
      setOtp("");
      await check();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  const canPrepare = verify?.ready && !device?.hasComplianceCsid;
  const canOtp = verify?.ready && device?.hasCsr && !device?.hasComplianceCsid;
  const onboarded = !!device?.hasComplianceCsid;

  async function regenerate() {
    if (!confirm(lang === "ar"
      ? "سيتم توليد زوج مفاتيح جديد و CSR جديد واستبدال القديم. متابعة؟"
      : "This will generate a new key pair + CSR and replace the old one. Continue?")) return;
    await prepare();
  }

  return (
    <Card><CardContent className="space-y-4 p-6">
      <ol className="list-inside list-decimal space-y-2 text-sm">
        <li>{lang === "ar" ? "أكمل بيانات الشركة (الاسم النظامي / الرقم الضريبي 15 رقم / السجل التجاري / العنوان الوطني)." : "Complete company info (legal name / 15-digit VAT / CR / national address)."}</li>
        <li>{lang === "ar" ? "ولّد زوج المفاتيح و CSR (تلقائيًا في الخادم)." : "Generate key pair + CSR (server-side, automatic)."}</li>
        <li>{lang === "ar" ? "اطلب OTP من بوابة فاتورة." : "Generate OTP from the FATOORA portal."}</li>
        <li>{lang === "ar" ? "أرسل OTP ليتم استدعاء ZATCA لاستلام CSID." : "Submit OTP — ZATCA is called immediately to issue the CSID."}</li>
      </ol>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">{lang === "ar" ? "حالة الإعدادات" : "Settings readiness"}</div>
          {verify ? (
            <div className="mt-1">
              <Badge className="text-xs">{verify.currentStatus}</Badge>
              {!verify.ready && verify.missing?.length > 0 && (
                <ul className="mt-2 list-inside list-disc text-xs text-destructive">
                  {verify.missing.map((m: string) => <li key={m}>{m}</li>)}
                </ul>
              )}
            </div>
          ) : <div className="text-sm text-muted-foreground">…</div>}
          <Button size="sm" variant="outline" className="mt-2" onClick={check} disabled={busy}>
            {lang === "ar" ? "إعادة التحقق" : "Re-check"}
          </Button>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">{lang === "ar" ? "حالة الجهاز" : "Device state"}</div>
          {device ? (
            <ul className="mt-1 space-y-1 text-xs">
              <li>{lang === "ar" ? "زوج المفاتيح موجود:" : "Key pair present:"} <b>{device.hasKey ? "✓" : "—"}</b></li>
              <li>{lang === "ar" ? "CSR موجود:" : "CSR present:"} <b>{device.hasCsr ? `✓ (${device.csrLength} chars)` : "—"}</b></li>
              <li>{lang === "ar" ? "CSID مستلم:" : "Compliance CSID:"} <b>{device.hasComplianceCsid ? "✓" : "—"}</b></li>
              {device.csidIssuedAt && <li>{lang === "ar" ? "تاريخ الإصدار:" : "Issued at:"} {new Date(device.csidIssuedAt).toLocaleString()}</li>}
              <li>{lang === "ar" ? "سلسلة PIH نشطة:" : "PIH chain active:"} <b>{device.pihPresent ? "✓" : "—"}</b></li>
            </ul>
          ) : <div className="text-sm text-muted-foreground">…</div>}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
        <div className="space-y-1">
          <Label className="text-xs">{lang === "ar" ? "1) توليد المفاتيح + CSR" : "1) Generate keys + CSR"}</Label>
          <div className="flex gap-2">
            {!device?.hasCsr && (
              <Button onClick={prepare} disabled={busy || !canPrepare}>
                {lang === "ar" ? "توليد CSR الآن" : "Prepare CSR"}
              </Button>
            )}
            {device?.hasCsr && !onboarded && (
              <>
                <Button variant="outline" disabled>
                  {lang === "ar" ? `CSR جاهز (${device.csrLength})` : `CSR ready (${device.csrLength})`}
                </Button>
                <Button variant="destructive" onClick={regenerate} disabled={busy || !canPrepare}>
                  {lang === "ar" ? "إعادة توليد CSR" : "Regenerate CSR"}
                </Button>
              </>
            )}
            {onboarded && (
              <Button variant="outline" disabled>
                {lang === "ar" ? "تم التسجيل" : "Onboarded"}
              </Button>
            )}
          </div>
        </div>

        <div className="flex-1 space-y-1 min-w-[220px]">
          <Label className="text-xs">{lang === "ar" ? "2) OTP من فاتورة" : "2) FATOORA OTP"}</Label>
          <div className="flex gap-2">
            <Input
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              disabled={!canOtp || onboarded}
              placeholder="123456"
              maxLength={20}
            />
            <Button onClick={send} disabled={busy || !canOtp}>
              {lang === "ar" ? "إرسال OTP" : "Submit OTP"}
            </Button>
          </div>
        </div>
      </div>

      {verify?.lastError && !onboarded && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {lang === "ar" ? "آخر خطأ من ZATCA: " : "Last ZATCA error: "}<b>{verify.lastError}</b>
          {verify.environment && verify.sandboxBaseUrl && (
            <span className="block mt-1 opacity-80">
              env=<b>{verify.environment}</b> · url=<b dir="ltr">{verify.sandboxBaseUrl}</b>
            </span>
          )}
        </p>
      )}

      {onboarded && (
        <p className="rounded-md border bg-success/10 p-3 text-xs text-success">
          {lang === "ar" ? "تم تسجيل الجهاز ومستعد لإرسال الفواتير." : "Device onboarded. Invoices can now be reported to ZATCA."}
        </p>
      )}
    </CardContent></Card>
  );
}


/* ─────────── Invoices tab (queue / failed / synced) ─────────── */
function InvoicesTab({ statusFilter, allowRetry }: { statusFilter: string; allowRetry?: boolean }) {
  const { lang } = useApp();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  async function refresh() {
    setLoading(true);
    try { setRows(await listZatcaInvoices({ data: { status: statusFilter } })); }
    catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [statusFilter]);

  async function retry(id: string) {
    try { await retryZatcaInvoice({ data: { id } }); toast.success("Retry queued"); refresh(); }
    catch (e: any) { toast.error(e.message); }
  }

  return (
    <Card><CardContent className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{lang === "ar" ? `الفواتير — ${statusFilter}` : `Invoices — ${statusFilter}`}</h3>
        <div className="flex gap-2">
          {(statusFilter === "pending_sync" || allowRetry) && (
            <Button size="sm" onClick={async () => {
              try {
                const s = await processZatcaQueue({ data: {} });
                toast.success(`${s.processed}✓ / ${s.failed}✗`);
                refresh();
              } catch (e: any) { toast.error(e.message); }
            }}>{lang === "ar" ? "تشغيل الإرسال الآن" : "Process queue now"}</Button>
          )}
          <Button size="sm" variant="outline" onClick={refresh}>{lang === "ar" ? "تحديث" : "Refresh"}</Button>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{lang === "ar" ? "الفاتورة" : "Invoice"}</TableHead>
            <TableHead>{lang === "ar" ? "الطلب" : "Order"}</TableHead>
            <TableHead>{lang === "ar" ? "النوع" : "Type"}</TableHead>
            <TableHead>{lang === "ar" ? "البيئة" : "Env"}</TableHead>
            <TableHead>{lang === "ar" ? "الإجمالي" : "Total"}</TableHead>
            <TableHead>{lang === "ar" ? "محاولات" : "Retries"}</TableHead>
            <TableHead>{lang === "ar" ? "الحالة" : "Status"}</TableHead>
            {allowRetry && <TableHead></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableRow><TableCell colSpan={8} className="text-center text-sm text-muted-foreground">…</TableCell></TableRow>}
          {!loading && rows.length === 0 && (
            <TableRow><TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
              {lang === "ar" ? "لا توجد فواتير." : "No invoices."}
            </TableCell></TableRow>
          )}
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono text-xs">{r.invoice_number ?? "—"}</TableCell>
              <TableCell className="font-mono text-xs">{r.order_number ?? "—"}</TableCell>
              <TableCell><Badge variant="outline" className="text-xs">{r.doc_type}</Badge></TableCell>
              <TableCell><Badge variant="outline" className="text-xs">{r.environment}</Badge></TableCell>
              <TableCell className="tabular-nums">{r.total ? Number(r.total).toFixed(2) : "—"}</TableCell>
              <TableCell>{r.retry_count ?? 0}</TableCell>
              <TableCell><StatusBadge s={r.status} lang={lang} /></TableCell>
              {allowRetry && (
                <TableCell>
                  <Button size="sm" variant="outline" onClick={() => retry(r.id)}>{lang === "ar" ? "إعادة المحاولة" : "Retry"}</Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}

/* ─────────── Credit notes ─────────── */
function CreditNotesTab() {
  const { lang } = useApp();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    listZatcaCreditNotes().then(setRows).catch((e: any) => toast.error(e.message)).finally(() => setLoading(false));
  }, []);
  return (
    <Card><CardContent className="p-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{lang === "ar" ? "المرجع" : "Reference"}</TableHead>
            <TableHead>{lang === "ar" ? "المبلغ" : "Amount"}</TableHead>
            <TableHead>{lang === "ar" ? "الضريبة" : "VAT"}</TableHead>
            <TableHead>{lang === "ar" ? "البيئة" : "Env"}</TableHead>
            <TableHead>{lang === "ar" ? "الحالة" : "Status"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableRow><TableCell colSpan={5} className="text-center">…</TableCell></TableRow>}
          {!loading && rows.length === 0 && (
            <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
              {lang === "ar" ? "لا توجد إشعارات دائنة." : "No credit notes yet."}
            </TableCell></TableRow>
          )}
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono text-xs">{r.refund_id?.slice(0, 8)}</TableCell>
              <TableCell className="tabular-nums">{Number(r.amount).toFixed(2)}</TableCell>
              <TableCell className="tabular-nums">{Number(r.vat_amount).toFixed(2)}</TableCell>
              <TableCell><Badge variant="outline" className="text-xs">{r.environment}</Badge></TableCell>
              <TableCell><StatusBadge s={r.status} lang={lang} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}

/* ─────────── Logs ─────────── */
function LogsTab() {
  const { lang } = useApp();
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { listZatcaLogs({ data: { limit: 200 } }).then(setRows).catch((e: any) => toast.error(e.message)); }, []);
  const sorted = useMemo(() => rows, [rows]);
  return (
    <Card><CardContent className="p-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{lang === "ar" ? "الوقت" : "Time"}</TableHead>
            <TableHead>{lang === "ar" ? "المستوى" : "Level"}</TableHead>
            <TableHead>{lang === "ar" ? "الحدث" : "Event"}</TableHead>
            <TableHead>{lang === "ar" ? "المرجع" : "Reference"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.length === 0 && (
            <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
              {lang === "ar" ? "لا توجد سجلات." : "No logs yet."}
            </TableCell></TableRow>
          )}
          {sorted.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="text-xs">{new Date(l.created_at).toLocaleString(lang === "ar" ? "ar-SA-u-ca-gregory" : "en-GB")}</TableCell>
              <TableCell><Badge variant={l.level === "error" ? "destructive" : "outline"} className="text-xs">{l.level}</Badge></TableCell>
              <TableCell className="font-mono text-xs">{l.event}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{l.reference_type ? `${l.reference_type}:${String(l.reference_id ?? "").slice(0, 8)}` : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}

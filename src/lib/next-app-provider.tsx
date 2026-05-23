"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getCurrentSessionUser, signOut as authSignOut } from "./authConfig";
import { Ctx, type CartItem, type CompletedOrder, type HeldOrder, type Lang, type Screen, type Theme, type UserRole } from "./store";
import { VAT_RATE } from "./data";
import { CatalogCtx, type BCategory, type BProduct, type BAddonGroup, type BAddon, type BLink } from "./catalog-context";
import { SettingsCtx, type RestaurantSettings } from "./settings-context";
import { useServerFn } from "@/lib/use-server-fn";
import { openShift as openShiftFn, getOpenShift } from "@/lib/shifts.functions";
import { createOrder as createOrderFn, holdOrder as holdOrderFn, listHeldOrders as listHeldOrdersFn, resumeHeldOrder as resumeHeldOrderFn, discardHeldOrder as discardHeldOrderFn, findOrCreateCustomerByPhone } from "@/lib/pos.functions";
import { listCatalog } from "@/lib/catalog.functions";
import { getRestaurantSettings } from "@/lib/settings.functions";
import { toast } from "sonner";

const DEFAULT_SETTINGS: RestaurantSettings = {
  id: true,
  legal_name_ar: "شركة مطاعم سلطان العبدلي لتقديم الوجبات",
  legal_name_en: "Sultan Al-Abdali Restaurants Co.",
  brand_name_ar: "يلو تشكن",
  brand_name_en: "Yellow Chicken",
  branch_ar: "مكة المكرمة - حي الشوقية",
  branch_en: "Makkah - Al Shawqiya",
  vat_number: "",
  commercial_registration: "",
  national_address: "",
  vat_rate: 0.15,
  prices_include_vat: true,
  receipt_width: "80mm",
  printer_type: "USB",
  print_method: "browser",
  print_copies: 2,
  logo_url: null,
  footer_note_ar: "شكرًا لزيارتكم",
  footer_note_en: "Thank you for your visit",
  updated_at: new Date().toISOString(),
};

function uid() { return Math.random().toString(36).slice(2, 10); }

export function NextAppProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>("ar");
  const [theme, setTheme] = useState<Theme>("dark");
  const [user, setUser] = useState<{ name: string; role: UserRole } | null>(null);
  const [shift, setShift] = useState<{ open: boolean; id?: string; openedAt?: number; openingCash: number }>({ open: false, openingCash: 0 });
  const [screen, setScreen] = useState<Screen>("login_selector");
  const [orderType, setOrderType] = useState<string>("dine_in");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [discount, setDiscount] = useState<{ type: "fixed" | "percent"; value: number }>({ type: "fixed", value: 0 });
  const [customerPhone, setCustomerPhone] = useState("");
  const [heldOrders, setHeld] = useState<HeldOrder[]>([]);
  const [heldLoading, setHeldLoading] = useState(false);
  const [completedOrders, setCompleted] = useState<CompletedOrder[]>([]);
  const [lastOrder, setLastOrder] = useState<CompletedOrder | null>(null);
  const [refundOrderId, setRefundOrderId] = useState<string | null>(null);
  const [orderCounter, setOrderCounter] = useState(1001);

  const openShiftCall = useServerFn(openShiftFn);
  const getOpenShiftCall = useServerFn(getOpenShift);
  const createOrderCall = useServerFn(createOrderFn);
  const holdOrderCall = useServerFn(holdOrderFn);
  const findOrCreateCustomer = useServerFn(findOrCreateCustomerByPhone);
  const listHeldCall = useServerFn(listHeldOrdersFn);
  const resumeHeldCall = useServerFn(resumeHeldOrderFn);
  const discardHeldCall = useServerFn(discardHeldOrderFn);

  const refreshHeld = useCallback(async (shiftId?: string) => {
    setHeldLoading(true);
    try {
      const rows: any[] = await listHeldCall();
      const activeShiftId = shiftId ?? shift.id;
      const mapped: HeldOrder[] = (rows || [])
        .filter((r: any) => !activeShiftId || r.shift_id === activeShiftId)
        .map((r: any) => ({
          id: r.id,
          number: `H-${String(r.id).slice(0, 4).toUpperCase()}`,
          time: new Date(r.held_at).getTime(),
          orderType: r.order_type,
          items: (r.cart_json?.items ?? []) as CartItem[],
        }));
      setHeld(mapped);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load held orders");
    } finally {
      setHeldLoading(false);
    }
  }, [listHeldCall, shift.id]);

  // Hydrate from Supabase session
  useEffect(() => {
    const hydrateShift = async (role: UserRole) => {
      if (role !== "cashier") return;
      try {
        const s: any = await getOpenShiftCall();
        if (s) {
          setShift({ open: true, id: s.id, openedAt: new Date(s.opened_at).getTime(), openingCash: Number(s.opening_float) });
          await refreshHeld(s.id);
        }
      } catch { /* no open shift */ }
    };

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!session?.user) {
        setUser(null);
        setShift({ open: false, openingCash: 0 });
        setScreen("login_selector");
        return;
      }
      setTimeout(async () => {
        const u = await getCurrentSessionUser();
        if (u) {
          setUser({ name: u.fullName || u.username, role: u.role });
          await hydrateShift(u.role);
        } else setUser(null);
      }, 0);
    });
    (async () => {
      const u = await getCurrentSessionUser();
      if (u) {
        setUser({ name: u.fullName || u.username, role: u.role });
        await hydrateShift(u.role);
        setScreen(u.role === "cashier" ? "open_shift" : "dashboard");
      }
    })();
    return () => sub?.subscription?.unsubscribe();
  }, []);

  // Theme / lang side-effects
  useEffect(() => { document.documentElement.lang = lang; document.documentElement.dir = lang === "ar" ? "rtl" : "ltr"; }, [lang]);
  useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);

  const fmtMoney = (n: number) => `${n.toFixed(2)} ${lang === "ar" ? "ر.س" : "SAR"}`;
  const locName = (m: { ar: string; en: string }) => (lang === "ar" ? m.ar : m.en);

  const subtotal = cart.reduce((s, i) => {
    const addons = i.addons.reduce((a, x) => a + (x.price || 0), 0);
    return s + (i.product.price + addons) * i.qty;
  }, 0);
  const discountAmt = Math.min(subtotal, discount.type === "fixed" ? discount.value : (subtotal * discount.value) / 100);
  const total = Math.max(0, subtotal - discountAmt);
  const vatPortion = total - total / (1 + VAT_RATE);
  const net = total - vatPortion;

  return (
    <Ctx.Provider value={{
      lang, setLang, theme, setTheme,
      t: {} as any,
      user,
      signIn: (n, r) => {
        setUser({ name: n, role: r });
        if (r === "cashier") setScreen(shift.open ? "pos" : "open_shift");
        else setScreen("dashboard");
      },
      signOut: () => {
        const wasCashier = user?.role === "cashier";
        if (wasCashier && shift.open && typeof window !== "undefined" && !window.confirm("Close shift before logout?")) return;
        void authSignOut();
        setUser(null);
        setScreen(wasCashier ? "pos_login" : "dashboard_login");
      },
      shift,
      openShift: async (cash) => {
        try {
          const s: any = await openShiftCall({ data: { opening_float: Number(cash) || 0 } });
          setShift({ open: true, id: s.id, openedAt: new Date(s.opened_at).getTime(), openingCash: Number(s.opening_float) });
          await refreshHeld(s.id);
          setScreen("pos");
        } catch (e: any) {
          toast.error(e?.message || "Failed to open shift");
        }
      },
      closeShift: () => { setShift({ open: false, openingCash: 0 }); setScreen("pos_login"); setUser(null); },

      screen, setScreen,
      orderType, setOrderType,
      cart,
      addToCart: (i) => setCart(c => [...c, { ...i, uid: uid() }]),
      updateQty: (u, q) => setCart(c => c.map(it => it.uid === u ? { ...it, qty: Math.max(1, q) } : it)),
      removeItem: (u) => setCart(c => c.filter(it => it.uid !== u)),
      clearCart: () => { setCart([]); setDiscount({ type: "fixed", value: 0 }); setCustomerPhone(""); },
      discount, setDiscount,
      customerPhone, setCustomerPhone,
      heldOrders, heldLoading,
      refreshHeld: () => refreshHeld(),
      holdOrder: async () => {
        if (!cart.length) return;
        try {
          await holdOrderCall({ data: {
            order_type: (["dine_in", "takeaway", "delivery_app"].includes(orderType) ? orderType : "dine_in") as any,
            cart: { items: cart, discount, customerPhone, orderType },
          }});
          setCart([]); setDiscount({ type: "fixed", value: 0 }); setCustomerPhone("");
          await refreshHeld();
          toast.success("Order held");
        } catch (e: any) {
          toast.error(e?.message || "Failed to hold order");
        }
      },
      resumeHeld: async (id) => {
        try {
          const row: any = await resumeHeldCall({ data: { id } });
          const cj = row?.cart_json || {};
          setCart((cj.items ?? []) as CartItem[]);
          setOrderType(cj.orderType || row.order_type || "dine_in");
          if (cj.discount) setDiscount(cj.discount);
          if (cj.customerPhone) setCustomerPhone(cj.customerPhone);
          await refreshHeld();
          setScreen("pos");
        } catch (e: any) {
          toast.error(e?.message || "Failed to resume order");
        }
      },
      deleteHeld: async (id) => {
        try {
          await discardHeldCall({ data: { id } });
          await refreshHeld();
        } catch (e: any) {
          toast.error(e?.message || "Failed to delete held order");
        }
      },

      completedOrders, lastOrder, setLastOrder, refundOrderId, setRefundOrderId,
      completeOrder: async (payment) => {
        if (!cart.length) return null;
        if (!shift.open) { toast.error("Open shift first"); return null; }
        const methodMap: Record<string, string> = { cash:"cash", card:"card", mada:"mada", apple_pay:"apple_pay", visa:"visa", mastercard:"mastercard", mixed:"mixed" };
        const orderTypeMap: Record<string, string> = { dine_in:"dine_in", takeaway:"takeaway", delivery:"delivery_app", delivery_app:"delivery_app" };
        const items = cart.map(ci => ({
          product_id: ci.product.id,
          quantity: ci.qty,
          notes: ci.note || undefined,
          addon_ids: [...(ci.spice?.id ? [ci.spice.id] : []), ...ci.addons.map(a => a.id), ...ci.removals.map(r => r.id)].filter(Boolean) as string[],
        }));
        try {
          let customer_id: string | undefined;
          if (customerPhone?.trim()) {
            try {
              const c: any = await findOrCreateCustomer({ data: { phone: customerPhone.trim() } });
              customer_id = c?.id;
            } catch (err: any) {
              toast.error(err?.message || "Invalid customer phone");
            }
          }
          const res: any = await createOrderCall({ data: {
            order_type: orderTypeMap[orderType] || "dine_in",
            discount: discountAmt,
            items,
            payments: [{ method: methodMap[payment] || "cash", amount: total }],
            customer_id,
          }});
          const order: CompletedOrder = {
            id: res.order.id,
            number: res.order.order_number || `#${orderCounter}`,
            invoice: res.invoice?.invoice_number || `INV-${2026000 + orderCounter}`,
            invoiceId: res.invoice?.id,
            time: new Date(res.order.created_at).getTime(),
            orderType, items: cart, subtotal,
            discount: discountAmt, total, payment,
            cashier: user?.name || "—",
            customerPhone: customerPhone || undefined,
          };
          setOrderCounter(n => n + 1);
          setCompleted(c => [order, ...c]);
          setLastOrder(order);
          setCart([]); setDiscount({ type: "fixed", value: 0 }); setCustomerPhone("");
          setScreen("invoice");
          return order;
        } catch (e: any) {
          toast.error(e?.message || "Failed to create order");
          return null;
        }
      },
      refundOrder: (id) => setCompleted(c => c.map(o => o.id === id ? { ...o, refunded: true } : o)),
      totals: { subtotal, discountAmt, total, vatPortion, net },
      fmtMoney, name: locName,
    }}>
      {children}
    </Ctx.Provider>
  );
}

/* ─── Catalog provider (loads from RPC) ─── */
export function NextCatalogProvider({ children }: { children: ReactNode }) {
  const fetchCatalog = useServerFn(listCatalog);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    categories: BCategory[]; products: BProduct[]; addonGroups: BAddonGroup[]; addons: BAddon[]; productAddonGroups: BLink[];
  }>({ categories: [], products: [], addonGroups: [], addons: [], productAddonGroups: [] });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r: any = await fetchCatalog();
      setData({
        categories: (r.categories as BCategory[]).filter((c: any) => c.active ?? true),
        products: (r.products as BProduct[]).filter((p: any) => p.active ?? true),
        addonGroups: r.addonGroups as BAddonGroup[],
        addons: (r.addons as BAddon[]).filter((a: any) => a.active ?? true),
        productAddonGroups: r.productAddonGroups as BLink[],
      });
    } catch (e: any) {
      setError(e?.message ?? "Failed to load catalog");
    } finally { setLoading(false); }
  }, [fetchCatalog]);

  useEffect(() => {
    supabase.auth.getSession().then((result: any) => {
      const session = result?.data?.session;
      if (session?.user) load();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.user) load();
    });
    return () => sub?.subscription?.unsubscribe();
  }, [load]);

  const groupsForProduct = useCallback((productId: string) => {
    const ids = data.productAddonGroups.filter(l => l.product_id === productId).map(l => l.group_id);
    return data.addonGroups.filter(g => ids.includes(g.id));
  }, [data]);

  const addonsForGroup = useCallback((groupId: string) =>
    data.addons.filter(a => a.group_id === groupId), [data]);

  return (
    <CatalogCtx.Provider value={{
      loading, error,
      categories: data.categories, products: data.products,
      addonGroups: data.addonGroups, addons: data.addons,
      productAddonGroups: data.productAddonGroups,
      groupsForProduct, addonsForGroup, reload: load,
    }}>{children}</CatalogCtx.Provider>
  );
}

/* ─── Settings provider (loads from RPC) ─── */
export function NextSettingsProvider({ children }: { children: ReactNode }) {
  const fetchSettings = useServerFn(getRestaurantSettings);
  const [settings, setSettings] = useState<RestaurantSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r: any = await fetchSettings();
      if (r) setSettings({ ...DEFAULT_SETTINGS, ...r });
    } catch { /* keep defaults */ }
    finally { setLoading(false); }
  }, [fetchSettings]);

  useEffect(() => {
    supabase.auth.getSession().then((result: any) => {
      const session = result?.data?.session;
      if (session?.user) load();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.user) load();
    });
    return () => sub?.subscription?.unsubscribe();
  }, [load]);

  return (
    <SettingsCtx.Provider value={{
      settings, loading, reload: load,
      applyLocal: (p) => setSettings(s => ({ ...s, ...p })),
    }}>
      {children}
    </SettingsCtx.Provider>
  );
}

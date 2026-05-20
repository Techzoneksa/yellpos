// Sprint C server functions: suppliers, inventory, purchases, recipes, adjustments, waste, customer history.
import { createServerFn, registerFn, requireSupabaseAuth } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { applyMovement } from "./ops.server";
import { logAudit } from "./audit.server";

async function ensureAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["owner", "manager"]);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Forbidden");
}

async function ensureAdminOrFinance(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["owner", "manager", "finance"]);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Forbidden");
}

/* ────────── SUPPLIERS ────────── */
const supplierSchema = z.object({
  id: z.string().uuid().optional(),
  supplier_name: z.string().min(1).max(200),
  mobile: z.string().max(40).nullable().optional(),
  representative_name: z.string().max(120).nullable().optional(),
  vat_number: z.string().max(40).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  payment_terms: z.string().max(120).nullable().optional(),
  opening_balance: z.number().default(0),
  active: z.boolean().default(true),
  notes: z.string().max(500).nullable().optional(),
});

export const listSuppliers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data, error } = await supabaseAdmin
      .from("suppliers")
      .select("*")
      .order("supplier_name", { ascending: true });
    if (error) throw new Error(error.message);
    return { suppliers: data ?? [] };
  });
registerFn('listSuppliers', listSuppliers);

export const upsertSupplier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => supplierSchema.parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const payload: any = { ...data };
    if (!payload.id) delete payload.id;
    const { data: up, error } = await supabaseAdmin.from("suppliers").upsert(payload).select("id, supplier_name").single();
    if (error) throw new Error(error.message);
    await logAudit({
      userId: context.userId,
      action: data.id ? "supplier.update" : "supplier.create",
      entityType: "supplier",
      entityId: up.id,
      newValue: { name: up.supplier_name },
    });
    return { ok: true };
  });
registerFn('upsertSupplier', upsertSupplier);

export const setSupplierActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid(), active: z.boolean() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("suppliers").update({ active: data.active }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('setSupplierActive', setSupplierActive);

export const getSupplierProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    const [{ data: supplier, error: sErr }, { data: invoices, error: iErr }] = await Promise.all([
      supabaseAdmin.from("suppliers").select("*").eq("id", data.id).maybeSingle(),
      supabaseAdmin
        .from("purchase_invoices")
        .select("id, invoice_date, total, amount_paid, status, payment_method, supplier_invoice_number, created_at")
        .eq("supplier_id", data.id)
        .order("invoice_date", { ascending: false }),
    ]);
    if (sErr) throw new Error(sErr.message);
    if (iErr) throw new Error(iErr.message);
    if (!supplier) throw new Error("Supplier not found");
    const totalPurchases = (invoices ?? []).reduce((s, x) => s + Number(x.total), 0);
    const totalPaid = (invoices ?? []).reduce((s, x) => s + Number(x.amount_paid ?? 0), 0);
    const outstanding = Number(supplier.opening_balance ?? 0) + totalPurchases - totalPaid;
    const lastPurchase = invoices && invoices.length ? invoices[0].invoice_date : null;
    return { supplier, invoices: invoices ?? [], totalPurchases, totalPaid, outstanding, lastPurchase };
  });

/* ────────── INVENTORY ────────── */
const invSchema = z.object({
  id: z.string().uuid().optional(),
  name_ar: z.string().min(1).max(200),
  name_en: z.string().max(200).default(""),
  category: z.string().min(1).max(80),
  unit: z.string().min(1).max(40),
  current_quantity: z.number().default(0),
  minimum_stock_level: z.number().min(0).default(0),
  average_cost: z.number().min(0).default(0),
  active: z.boolean().default(true),
  notes: z.string().max(500).nullable().optional(),
});
registerFn('getSupplierProfile', getSupplierProfile);

export const listInventory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("inventory_items")
      .select("*")
      .order("name_ar", { ascending: true });
    if (error) throw new Error(error.message);
    return { items: data ?? [] };
  });
registerFn('listInventory', listInventory);

export const upsertInventoryItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => invSchema.parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const payload: any = { ...data };
    if (!payload.id) delete payload.id;
    const { error } = await supabaseAdmin.from("inventory_items").upsert(payload).select("id").single();
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('upsertInventoryItem', upsertInventoryItem);

export const setInventoryActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid(), active: z.boolean() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("inventory_items").update({ active: data.active }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('setInventoryActive', setInventoryActive);

export const listItemMovements = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(500).default(100) }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data: rows, error } = await supabaseAdmin
      .from("inventory_movements")
      .select("*")
      .eq("inventory_item_id", data.id)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return { movements: rows ?? [] };
  });

/* ────────── PURCHASES ────────── */
const purchaseItemSchema = z.object({
  inventory_item_id: z.string().uuid(),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(40),
  unit_cost: z.number().min(0),
  vat_amount: z.number().min(0).default(0),
  line_total: z.number().min(0),
});
const purchaseSchema = z.object({
  supplier_id: z.string().uuid(),
  supplier_invoice_number: z.string().max(80).nullable().optional(),
  invoice_date: z.string(),
  subtotal: z.number().min(0),
  vat_amount: z.number().min(0).default(0),
  total: z.number().min(0),
  payment_method: z.enum(["cash", "bank", "credit"]),
  status: z.enum(["paid", "partially_paid", "unpaid"]),
  amount_paid: z.number().min(0).default(0),
  attachment_url: z.string().max(500).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  items: z.array(purchaseItemSchema).min(1).max(100),
});
registerFn('listItemMovements', listItemMovements);

export const listPurchases = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data, error } = await supabaseAdmin
      .from("purchase_invoices")
      .select("*, supplier:suppliers(supplier_name)")
      .order("invoice_date", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return { purchases: data ?? [] };
  });
registerFn('listPurchases', listPurchases);

export const getPurchase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    const [{ data: inv, error }, { data: items, error: iErr }] = await Promise.all([
      supabaseAdmin.from("purchase_invoices").select("*, supplier:suppliers(supplier_name)").eq("id", data.id).maybeSingle(),
      supabaseAdmin
        .from("purchase_items")
        .select("*, inventory_item:inventory_items(name_ar, name_en, unit)")
        .eq("purchase_invoice_id", data.id),
    ]);
    if (error) throw new Error(error.message);
    if (iErr) throw new Error(iErr.message);
    return { invoice: inv, items: items ?? [] };
  });
registerFn('getPurchase', getPurchase);

export const createPurchase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => purchaseSchema.parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);

    const { data: inv, error } = await supabaseAdmin
      .from("purchase_invoices")
      .insert({
        supplier_id: data.supplier_id,
        supplier_invoice_number: data.supplier_invoice_number ?? null,
        invoice_date: data.invoice_date,
        subtotal: data.subtotal,
        vat_amount: data.vat_amount,
        total: data.total,
        payment_method: data.payment_method,
        status: data.status,
        amount_paid: data.amount_paid,
        attachment_url: data.attachment_url ?? null,
        notes: data.notes ?? null,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const itemsRows = data.items.map((it: any) => ({
      purchase_invoice_id: inv.id,
      inventory_item_id: it.inventory_item_id,
      quantity: it.quantity,
      unit: it.unit,
      unit_cost: it.unit_cost,
      vat_amount: it.vat_amount,
      line_total: it.line_total,
    }));
    const { error: piErr } = await supabaseAdmin.from("purchase_items").insert(itemsRows);
    if (piErr) throw new Error(piErr.message);

    // Increase stock for each item and record movement
    for (const it of data.items) {
      await applyMovement({
        inventory_item_id: it.inventory_item_id,
        delta: it.quantity,
        movement_type: "purchase",
        reference_type: "purchase_invoice",
        reference_id: inv.id,
        unit_cost: it.unit_cost,
        created_by: context.userId,
      });
    }
    await logAudit({
      userId: context.userId,
      action: "purchase.create",
      entityType: "purchase_invoice",
      entityId: inv.id,
      newValue: { supplier_id: data.supplier_id, total: data.total, items: data.items.length },
    });
    return { id: inv.id };
  });

/* ────────── RECIPES ────────── */
const ingredientSchema = z.object({
  inventory_item_id: z.string().uuid(),
  quantity_used: z.number().positive(),
  unit: z.string().min(1).max(40),
});
const recipeSchema = z.object({
  product_id: z.string().uuid(),
  active: z.boolean().default(true),
  ingredients: z.array(ingredientSchema).max(50),
});
registerFn('createPurchase', createPurchase);

export const listRecipes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.userId);
    const [{ data: recipes, error }, { data: ings, error: iErr }] = await Promise.all([
      supabaseAdmin.from("product_recipes").select("*"),
      supabaseAdmin.from("recipe_ingredients").select("*"),
    ]);
    if (error) throw new Error(error.message);
    if (iErr) throw new Error(iErr.message);
    return { recipes: recipes ?? [], ingredients: ings ?? [] };
  });
registerFn('listRecipes', listRecipes);

export const saveRecipe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => recipeSchema.parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { data: recipe, error } = await supabaseAdmin
      .from("product_recipes")
      .upsert({ product_id: data.product_id, active: data.active }, { onConflict: "product_id" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    // Replace ingredients
    const { error: dErr } = await supabaseAdmin.from("recipe_ingredients").delete().eq("recipe_id", recipe.id);
    if (dErr) throw new Error(dErr.message);
    if (data.ingredients.length) {
      const rows = data.ingredients.map((g: any) => ({
        recipe_id: recipe.id,
        inventory_item_id: g.inventory_item_id,
        quantity_used: g.quantity_used,
        unit: g.unit,
      }));
      const { error: insErr } = await supabaseAdmin.from("recipe_ingredients").insert(rows);
      if (insErr) throw new Error(insErr.message);
    }
    return { ok: true };
  });
registerFn('saveRecipe', saveRecipe);

export const deleteRecipe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ product_id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("product_recipes").delete().eq("product_id", data.product_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* ────────── STOCK ADJUSTMENTS ────────── */
const adjustSchema = z.object({
  inventory_item_id: z.string().uuid(),
  new_quantity: z.number().min(0),
  reason: z.string().min(1).max(80),
  notes: z.string().max(500).nullable().optional(),
});
registerFn('deleteRecipe', deleteRecipe);

export const createAdjustment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => adjustSchema.parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { data: item, error } = await supabaseAdmin
      .from("inventory_items")
      .select("current_quantity")
      .eq("id", data.inventory_item_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!item) throw new Error("Inventory item not found");
    const oldQty = Number(item.current_quantity);
    const diff = data.new_quantity - oldQty;

    const { error: aErr } = await supabaseAdmin.from("stock_adjustments").insert({
      inventory_item_id: data.inventory_item_id,
      old_quantity: oldQty,
      new_quantity: data.new_quantity,
      difference: diff,
      reason: data.reason,
      notes: data.notes ?? null,
      created_by: context.userId,
    });
    if (aErr) throw new Error(aErr.message);

    if (diff !== 0) {
      await applyMovement({
        inventory_item_id: data.inventory_item_id,
        delta: diff,
        movement_type: "adjustment",
        reference_type: "adjustment",
        notes: data.reason,
        created_by: context.userId,
      });
    }
    await logAudit({
      userId: context.userId,
      action: "stock.adjustment",
      entityType: "inventory_item",
      entityId: data.inventory_item_id,
      oldValue: { qty: oldQty },
      newValue: { qty: data.new_quantity, diff, reason: data.reason },
    });
    return { ok: true };
  });
registerFn('createAdjustment', createAdjustment);

export const listAdjustments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("stock_adjustments")
      .select("*, inventory_item:inventory_items(name_ar, unit)")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return { adjustments: data ?? [] };
  });

/* ────────── WASTE ────────── */
const wasteSchema = z.object({
  inventory_item_id: z.string().uuid(),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(40),
  reason: z.string().min(1).max(80),
  estimated_cost: z.number().min(0).default(0),
  notes: z.string().max(500).nullable().optional(),
});
registerFn('listAdjustments', listAdjustments);

export const createWaste = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => wasteSchema.parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("waste_records").insert({
      inventory_item_id: data.inventory_item_id,
      quantity: data.quantity,
      unit: data.unit,
      reason: data.reason,
      estimated_cost: data.estimated_cost,
      notes: data.notes ?? null,
      created_by: context.userId,
    });
    if (error) throw new Error(error.message);
    await applyMovement({
      inventory_item_id: data.inventory_item_id,
      delta: -data.quantity,
      movement_type: "waste",
      reference_type: "waste",
      notes: data.reason,
      created_by: context.userId,
    });
    await logAudit({
      userId: context.userId,
      action: "waste.record",
      entityType: "inventory_item",
      entityId: data.inventory_item_id,
      newValue: { quantity: data.quantity, unit: data.unit, reason: data.reason, cost: data.estimated_cost },
    });
    return { ok: true };
  });
registerFn('createWaste', createWaste);

export const listWaste = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("waste_records")
      .select("*, inventory_item:inventory_items(name_ar, unit)")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return { records: data ?? [] };
  });
registerFn('listWaste', listWaste);

/* ────────── CUSTOMER HISTORY (no loyalty) ────────── */
export const listCustomersWithStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data: customers, error } = await supabaseAdmin
      .from("customers")
      .select("id, name, phone, created_at")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) throw new Error(error.message);
    const ids = (customers ?? []).map((c) => c.id);
    if (!ids.length) return { customers: [] };
    const { data: orders, error: oErr } = await supabaseAdmin
      .from("orders")
      .select("id, customer_id, total_including_vat, created_at, status")
      .in("customer_id", ids)
      .eq("status", "completed");
    if (oErr) throw new Error(oErr.message);
    const map = new Map<string, { count: number; total: number; last: string | null }>();
    (orders ?? []).forEach((o) => {
      const k = o.customer_id as string;
      const e = map.get(k) || { count: 0, total: 0, last: null };
      e.count += 1;
      e.total += Number(o.total_including_vat);
      if (!e.last || (o.created_at && o.created_at > e.last)) e.last = o.created_at as string;
      map.set(k, e);
    });
    return {
      customers: (customers ?? []).map((c) => ({
        ...c,
        orders_count: map.get(c.id)?.count ?? 0,
        total_purchases: map.get(c.id)?.total ?? 0,
        last_order_at: map.get(c.id)?.last ?? null,
      })),
    };
  });
registerFn('listCustomersWithStats', listCustomersWithStats);

export const getCustomerHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(100).default(50) }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdminOrFinance(context.userId);
    const { data: orders, error } = await supabaseAdmin
      .from("orders")
      .select("id, order_number, total_including_vat, order_type, status, created_at")
      .eq("customer_id", data.id)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return { orders: orders ?? [] };
  });
registerFn('getCustomerHistory', getCustomerHistory);

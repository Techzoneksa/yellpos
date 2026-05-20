// Catalog: categories, products, addon groups, addons, links.
import { createServerFn, registerFn, requireSupabaseAuth } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logAudit } from "@/lib/audit.server";

async function ensureAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["owner", "manager"]);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Forbidden: admin role required");
}

/* ─────── Read (any signed-in user) ─────── */
export const listCatalog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const [cats, prods, groups, addons, links] = await Promise.all([
      supabaseAdmin.from("categories").select("*").order("sort_order"),
      supabaseAdmin.from("products").select("*").order("name_ar"),
      supabaseAdmin.from("addon_groups").select("*").order("name_ar"),
      supabaseAdmin.from("addons").select("*").order("name_ar"),
      supabaseAdmin.from("product_addon_groups").select("*"),
    ]);
    for (const r of [cats, prods, groups, addons, links]) {
      if (r.error) throw new Error(r.error.message);
    }
    return {
      categories: cats.data ?? [],
      products: prods.data ?? [],
      addonGroups: groups.data ?? [],
      addons: addons.data ?? [],
      productAddonGroups: links.data ?? [],
    };
  });
registerFn('listCatalog', listCatalog);

/* ─────── Categories ─────── */
export const upsertCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      id: z.string().uuid().optional(),
      name_ar: z.string().min(1).max(80),
      name_en: z.string().max(80).default(""),
      sort_order: z.number().int().default(0),
      color: z.string().max(20).nullable().optional(),
      icon: z.string().max(40).nullable().optional(),
      active: z.boolean().default(true),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("categories").upsert(data);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('upsertCategory', upsertCategory);

export const deleteCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("categories").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('deleteCategory', deleteCategory);

/* ─────── Products ─────── */
const productTypeSchema = z.enum(["broasted", "sandwich", "burger", "side", "drink", "other"]);

export const upsertProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      id: z.string().uuid().optional(),
      category_id: z.string().uuid().nullable().optional(),
      name_ar: z.string().min(1).max(120),
      name_en: z.string().max(120).default(""),
      sku: z.string().max(40).nullable().optional(),
      price: z.number().min(0),
      image_url: z.string().url().nullable().optional(),
      tax_rate: z.number().min(0).max(1).default(0.15),
      active: z.boolean().default(true),
      product_type: productTypeSchema.default("other"),
      calories: z.number().int().min(0).nullable().optional(),
      size: z.string().max(40).nullable().optional(),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    // Capture previous price for audit so we record real changes only.
    let oldPrice: number | null = null;
    if (data.id) {
      const { data: prev } = await supabaseAdmin
        .from("products")
        .select("price")
        .eq("id", data.id)
        .maybeSingle();
      oldPrice = prev ? Number((prev as any).price) : null;
    }
    const { error } = await supabaseAdmin.from("products").upsert(data);
    if (error) throw new Error(error.message);
    await logAudit({
      userId: context.userId,
      action: data.id ? "product.update" : "product.create",
      entityType: "product",
      entityId: data.id ?? null,
      oldValue: oldPrice != null ? { price: oldPrice } : null,
      newValue: { name_ar: data.name_ar, price: data.price, active: data.active },
    });
    return { ok: true };
  });
registerFn('upsertProduct', upsertProduct);

export const deleteProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("products").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('deleteProduct', deleteProduct);

/* ─────── Addon groups & addons ─────── */
export const upsertAddonGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      id: z.string().uuid().optional(),
      name_ar: z.string().min(1).max(80),
      name_en: z.string().max(80).default(""),
      min_select: z.number().int().min(0).default(0),
      max_select: z.number().int().min(1).default(1),
      required: z.boolean().default(false),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("addon_groups").upsert(data);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('upsertAddonGroup', upsertAddonGroup);

export const deleteAddonGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("addon_groups").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('deleteAddonGroup', deleteAddonGroup);

export const upsertAddon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      id: z.string().uuid().optional(),
      group_id: z.string().uuid(),
      name_ar: z.string().min(1).max(80),
      name_en: z.string().max(80).default(""),
      price_delta: z.number().default(0),
      active: z.boolean().default(true),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("addons").upsert(data);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('upsertAddon', upsertAddon);

export const deleteAddon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin.from("addons").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('deleteAddon', deleteAddon);

/* ─────── Product ↔ addon-group links ─────── */
export const linkAddonGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      product_id: z.string().uuid(),
      group_id: z.string().uuid(),
      sort_order: z.number().int().default(0),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("product_addon_groups")
      .upsert(data, { onConflict: "product_id,group_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('linkAddonGroup', linkAddonGroup);

export const unlinkAddonGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ product_id: z.string().uuid(), group_id: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("product_addon_groups")
      .delete()
      .eq("product_id", data.product_id)
      .eq("group_id", data.group_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
registerFn('unlinkAddonGroup', unlinkAddonGroup);

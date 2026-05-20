// Restaurant settings: read by any signed-in user, write by admin.
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

export const getRestaurantSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data, error } = await supabaseAdmin
      .from("restaurant_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      // self-heal: insert default row if missing
      const { data: inserted, error: iErr } = await supabaseAdmin
        .from("restaurant_settings")
        .insert({ id: true })
        .select("*")
        .single();
      if (iErr) throw new Error(iErr.message);
      return inserted;
    }
    return data;
  });
registerFn('getRestaurantSettings', getRestaurantSettings);

export const updateRestaurantSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        legal_name_ar: z.string().min(1).max(200).optional(),
        legal_name_en: z.string().max(200).optional(),
        brand_name_ar: z.string().min(1).max(120).optional(),
        brand_name_en: z.string().max(120).optional(),
        branch_ar: z.string().max(200).optional(),
        branch_en: z.string().max(200).optional(),
        vat_number: z.string().max(50).optional(),
        commercial_registration: z.string().max(50).optional(),
        national_address: z.string().max(200).optional(),
        vat_rate: z.number().min(0).max(1).optional(),
        prices_include_vat: z.boolean().optional(),
        receipt_width: z.enum(["58mm", "80mm"]).optional(),
        printer_type: z.enum(["USB", "Bluetooth", "Network"]).optional(),
        print_method: z.enum(["browser", "driver"]).optional(),
        print_copies: z.number().int().min(1).max(5).optional(),
        logo_url: z.string().url().nullable().optional(),
        footer_note_ar: z.string().max(200).optional(),
        footer_note_en: z.string().max(200).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.userId);
    const { data: row, error } = await supabaseAdmin
      .from("restaurant_settings")
      .update(data)
      .eq("id", true)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    await logAudit({
      userId: context.userId,
      action: "settings.update",
      entityType: "restaurant_settings",
      entityId: "singleton",
      newValue: data,
    });
    return row;
  });
registerFn('updateRestaurantSettings', updateRestaurantSettings);

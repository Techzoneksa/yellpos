// One-time owner bootstrap. Only works when there are zero profiles in the DB.
import { createServerFn, registerFn } from "@/lib/tanstack-compat";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const bootstrapStatus = createServerFn({ method: "POST" }).handler(async () => {
  const { count, error } = await supabaseAdmin
    .from("profiles")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return { hasUsers: (count ?? 0) > 0 };
});
registerFn('bootstrapStatus', bootstrapStatus);

export const bootstrapOwner = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        fullName: z.string().min(1).max(120),
        username: z
          .string()
          .min(2)
          .max(50)
          .regex(/^[a-zA-Z0-9_.-]+$/),
        email: z.string().email(),
        password: z.string().min(8).max(128),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { count, error: cErr } = await supabaseAdmin
      .from("profiles")
      .select("id", { count: "exact", head: true });
    if (cErr) throw new Error(cErr.message);
    if ((count ?? 0) > 0) throw new Error("Owner already exists");

    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: {
        full_name: data.fullName,
        username: data.username.toLowerCase(),
        role: "owner",
      },
    });
    if (error) throw new Error(error.message);
    const id = created.user!.id;

    await supabaseAdmin
      .from("profiles")
      .update({ full_name: data.fullName, username: data.username.toLowerCase(), active: true })
      .eq("id", id);

    await supabaseAdmin.from("user_roles").delete().eq("user_id", id);
    await supabaseAdmin.from("user_roles").insert({ user_id: id, role: "owner" });

    return { id };
  });
registerFn('bootstrapOwner', bootstrapOwner);

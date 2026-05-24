#!/usr/bin/env node
// Seed script: creates the owner/admin user.
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-owner.cjs
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const email = process.env.SEED_OWNER_EMAIL || "aabanurs@gmail.com";
  const password = process.env.SEED_OWNER_PASSWORD || "Sultan2030@%_Y";
  const username = process.env.SEED_OWNER_USERNAME || "sultan";
  const fullName = process.env.SEED_OWNER_FULLNAME || "Sultan";

  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (existing) {
    console.log("Owner already exists (username: sultan). Skipping.");
    return;
  }

  console.log("Creating auth user...");
  const { data: created, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, username, role: "owner" },
  });
  if (error) {
    if (error.message.includes("already exists")) {
      console.log("Email already registered. Skipping creation.");
      return;
    }
    throw new Error(`createUser failed: ${error.message}`);
  }

  const id = created.user.id;
  console.log(`Auth user created: ${id}`);

  const { error: pErr } = await supabase
    .from("profiles")
    .update({ full_name: fullName, username, active: true })
    .eq("id", id);
  if (pErr) console.warn("Profile update warning:", pErr.message);

  const { error: dErr } = await supabase.from("user_roles").delete().eq("user_id", id);
  if (dErr) console.warn("Role delete warning:", dErr.message);

  const { error: iErr } = await supabase.from("user_roles").insert({ user_id: id, role: "owner" });
  if (iErr) throw new Error(`Role insert failed: ${iErr.message}`);

  console.log("Owner created successfully!");
  console.log(`Email: ${email}`);
  console.log(`Username: ${username}`);
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});

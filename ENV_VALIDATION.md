# Environment Variables Reference

## All Variables

| Variable | Required | Scope | Where to Get | What Breaks if Missing |
|----------|----------|-------|-------------|----------------------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ Always | Public (client) | Supabase Dashboard → Settings → API → Project URL | Supabase client won't initialize; auth, DB, and all data features fail |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ✅ Always | Public (client) | Supabase Dashboard → Settings → API → Anon Key | Same as above |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ Always | Server-only | Supabase Dashboard → Settings → API → service_role key (secret!) | RPC API route crashes; server-side admin operations fail |
| `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET` | ⚠️ If ZATCA used | Server-only | Generate a strong random string (min 16 chars) | ZATCA key encryption/decryption fails; ZATCA onboarding breaks |
| `ZATCA_ENVIRONMENT` | ⚠️ If ZATCA used | Server-only | Set to `simulation` or `production` | ZATCA features won't activate; stays disabled |
| `NODE_ENV` | ✅ Always | Server | Set to `production` | App may run in dev mode; performance issues |
| `PORT` | ❌ Optional | Server | Hostinger provides this automatically | Server falls back to port 3000 |

## Security Rules

- **NEVER** put `SUPABASE_SERVICE_ROLE_KEY`, `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET`, or any secret in a `NEXT_PUBLIC_` variable
- **NEVER** commit `.env` to git
- **NEVER** log secrets in console output
- **ALWAYS** use `.env.example` as a reference (no real values)
- **ALWAYS** add env vars in Hostinger hPanel, not in the codebase

## Where Env Vars Are Used

| File | Variable | Type |
|------|----------|------|
| `src/integrations/supabase/client.ts` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Client-side |
| `src/integrations/supabase/client.server.ts` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Server-only |
| `src/lib/zatca-crypto.server.ts` | `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET` | Server-only |

## Validation

The app handles missing env vars gracefully:
- **Client Supabase**: Logs a warning and returns a stub client. Auth/DB features are disabled but the app doesn't crash.
- **Server SupabaseAdmin**: Logs a warning and returns a stub. RPC calls will fail with a clear error.
- **ZATCA crypto**: Throws a descriptive error if the secret is missing — caught by the caller.

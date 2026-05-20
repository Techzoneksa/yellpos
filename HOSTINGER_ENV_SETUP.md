# Hostinger Environment Setup

## Exact Hostinger Settings

| Setting | Value |
|---------|-------|
| Framework preset | Next.js |
| Node version | 22.x (or 20.x LTS) |
| Root directory | ./ |
| Build command | `npm run build` |
| Package manager | npm |
| Output directory | .next |
| **Start command** | `npm start` (runs `node server.cjs`) |

⚠️ **Do not change the start command.** The current `package.json` uses `"start": "node server.cjs"` which binds to `0.0.0.0` and respects Hostinger's dynamic `PORT` variable.

---

## Step 1 — Hostinger Supabase Wizard

When Hostinger shows a Supabase integration wizard, enter:

| Wizard Field | What to Paste | Maps to Env Var |
|-------------|---------------|-----------------|
| **Project URL** | `https://xxxxx.supabase.co` (from Supabase Settings → API) | `SUPABASE_URL` |
| **Anon key** | `eyJhbGciOi...` (from Supabase Settings → API → Anon Key) | `SUPABASE_ANON_KEY` |

The app supports both `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_ANON_KEY` — you only need one.

---

## Step 2 — Manually Add These Missing Env Vars

After the wizard, go to **hPanel → Websites → your domain → Node.js Apps → Environment Variables** and add:

### Required (add manually — wizard does not create these)

| Variable | What to Enter | Notes |
|----------|--------------|-------|
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase → Settings → API → service_role key | **Server-only secret**. Never expose to browser. |
| `NODE_ENV` | `production` | |

### Optional (only if using ZATCA e-invoicing)

| Variable | What to Enter |
|----------|--------------|
| `ZATCA_ENVIRONMENT` | `simulation` (never `production` until ZATCA onboarding is complete) |
| `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET` | A strong random string (min 16 characters) |

---

## Summary: All Variables Hostinger Should Have

```
SUPABASE_URL=https://xxxxx.supabase.co              ← set by wizard
SUPABASE_ANON_KEY=eyJhbGciOi...                     ← set by wizard
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...              ← add manually (secret!)
NODE_ENV=production                                   ← add manually
ZATCA_ENVIRONMENT=simulation                          ← add manually (optional)
ZATCA_DEVICE_KEY_ENCRYPTION_SECRET=...                ← add manually (optional)
```

**Note:** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are optional. The app falls back to `SUPABASE_URL` / `SUPABASE_ANON_KEY` if the `NEXT_PUBLIC_*` versions are not set.

---

## What to Click After Adding Env Vars

1. Click **Save** in the Environment Variables section
2. Click **Redeploy** (or Restart the Node.js app)
3. Wait for deployment to finish (check Deployment Logs)
4. Clear browser cache: `Ctrl+F5` or `Cmd+Shift+R`
5. Test these URLs:
   - `https://yourdomain.com/` — should show landing page
   - `https://yourdomain.com/pos/login` — POS login page
   - `https://yourdomain.com/dashboard/login` — Dashboard login page

---

## How to Verify Deployment

### If the page loads successfully:
- The landing page appears without "This page couldn't load"
- Navigation works between routes
- API is alive

### If it still fails:
1. Check **Application Logs** in hPanel → Node.js Apps
2. Common errors in logs:
   - `Missing Supabase environment variable` → you missed a variable
   - `ECONNREFUSED` → Supabase URL is wrong
   - `auth/invalid-api-key` → Anon key is wrong
   - `Port 3000 already in use` → Hostinger already assigned PORT; restart the app

---

## Security Rules

- ✅ `NEXT_PUBLIC_*` / `SUPABASE_URL` / `SUPABASE_ANON_KEY` = safe to expose to browser
- ❌ `SUPABASE_SERVICE_ROLE_KEY` = never put in `NEXT_PUBLIC_*`
- ❌ `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET` = never put in `NEXT_PUBLIC_*`
- ❌ Never commit `.env` to git
- ❌ Never paste secrets in chat, docs, or code

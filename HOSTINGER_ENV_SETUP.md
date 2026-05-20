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

## Required Environment Variables

Add these in: **hPanel → Websites → your domain → Node.js Apps → Environment Variables**

### 1. Supabase — Client-side (Public — starts with `NEXT_PUBLIC_`)

| Variable | Where to Get It |
|----------|----------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → **Project Settings → API → Project URL** |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase Dashboard → **Project Settings → API → Anon Key** (this is the anon/public key) |

> ⚠️ The code uses `PUBLISHABLE_KEY` not `ANON_KEY`. Both mean the same thing (Supabase anon key).  
> Use the exact name `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — do not rename it.

### 2. Supabase — Server-side (Private — never expose to browser)

| Variable | Where to Get It |
|----------|----------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → **Project Settings → API → service_role key** (secret!) |

> ⚠️ This key bypasses Row Level Security. Only the server-side RPC route uses it.

### 3. Node.js Runtime

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |

### 4. ZATCA — Optional (Only if ZATCA e-invoicing is active)

| Variable | Where to Get It | Value |
|----------|----------------|-------|
| `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET` | Generate a strong random string (min 16 characters) | `your-encryption-secret` |
| `ZATCA_ENVIRONMENT` | Always `simulation` initially | `simulation` |

> ⚠️ Do not set `ZATCA_ENVIRONMENT=production` until ZATCA onboarding is complete.

---

## Summary: All Variables at a Glance

Add exactly these 5-6 variables in Hostinger hPanel:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...         (secret!)
NODE_ENV=production
ZATCA_ENVIRONMENT=simulation                    (optional)
ZATCA_DEVICE_KEY_ENCRYPTION_SECRET=...          (optional)
```

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

- ✅ `NEXT_PUBLIC_*` = safe to expose to browser
- ❌ `SUPABASE_SERVICE_ROLE_KEY` = never put in `NEXT_PUBLIC_*`
- ❌ `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET` = never put in `NEXT_PUBLIC_*`
- ❌ Never commit `.env` to git
- ❌ Never paste secrets in chat, docs, or code

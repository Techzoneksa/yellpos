# Hostinger Runtime Debug Guide

## Current Hostinger Settings

| Setting | Value |
|---------|-------|
| Framework preset | Next.js |
| Node version | 22.x (or 20.x LTS) |
| Root directory | ./ |
| Build command | `npm run build` |
| Package manager | npm |
| **Start command** | `npm start` (maps to `node server.cjs`) |
| Output directory | .next |

## Required Environment Variables

Add these in Hostinger hPanel → Website → App → Node.js App → Environment Variables:

| Variable | Required | Type | Notes |
|----------|----------|------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ Required | Public (NEXT_PUBLIC) | Supabase project URL from Settings → API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ✅ Required | Public (NEXT_PUBLIC) | Supabase anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ Required | Server-only | Supabase service_role key (secret!) |
| `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET` | ⚠️ If ZATCA used | Server-only | Encryption secret for ZATCA keys |
| `ZATCA_ENVIRONMENT` | ⚠️ If ZATCA used | Server-only | `simulation` or `production` |
| `NODE_ENV` | ✅ Required | Server-only | Set to `production` |
| `PORT` | ❌ Optional | Server-only | Hostinger provides this automatically |

**How to add:**
1. Go to hPanel → Websites → select your domain
2. Open Node.js Apps (or Web Apps)
3. Find your app → Environment Variables
4. Add each variable name and value
5. Click Save → Redeploy

## Where to Check Logs

- **Deployment logs**: hPanel → Websites → your domain → Node.js Apps → Deployment Logs
- **Runtime logs**: hPanel → Websites → your domain → Node.js Apps → Runtime Logs
- **Application logs**: hPanel → Websites → your domain → Node.js Apps → Application Logs

If the app crashes, always check **Application Logs** first — they show Node.js crash stack traces.

## Common Errors & Fixes

### "This page couldn't load"
**Cause:** Missing environment variables (usually `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`).

**Fix:** Add all required env vars in hPanel → Environment Variables, save, and redeploy.

### 502 Bad Gateway
**Cause 1:** App crashed on startup — check Application Logs.
**Cause 2:** Missing env vars.
**Cause 3:** Wrong start command.
**Cause 4:** Wrong Node.js version (use 20.x or 22.x LTS).

**Fix:** Check logs, verify env vars, verify start command is `npm start`.

### API route returns 500
**Cause:** `SUPABASE_SERVICE_ROLE_KEY` is missing or invalid. The /api/rpc route uses it server-side.

**Fix:** Add `SUPABASE_SERVICE_ROLE_KEY` in Environment Variables.

### Static pages load but API fails
**Cause:** Deployed as static hosting instead of Node.js Web App.

**Fix:** Make sure you created a **Node.js App** (not static hosting) in Hostinger.

## After Setting Environment Variables

1. Click **Save** in the Environment Variables section
2. Click **Redeploy** (or restart the Node.js app)
3. Wait for deployment to finish
4. Clear browser cache (Ctrl+F5 or Cmd+Shift+R)
5. Test routes:
   - https://yourdomain.com/
   - https://yourdomain.com/pos/login
   - https://yourdomain.com/dashboard/login
   - https://yourdomain.com/api/rpc (should return 400 "Missing fnName" — this is normal)

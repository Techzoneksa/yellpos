# Hostinger Deployment Guide — Yellow Chicken POS

## Hostinger Plan Requirements

This is a **Next.js app with API routes** (not a static site). It requires **Node.js runtime** hosting.

| Hostinger Plan | Supports Node.js? | Notes |
|----------------|-------------------|-------|
| Business Web Hosting | ✅ | Node.js support available via hPanel |
| Cloud Startup | ✅ | Better performance, dedicated resources |
| Cloud Professional | ✅ | Recommended for production POS |
| Cloud Enterprise | ✅ | For high-volume deployments |
| VPS (manual) | ✅ | Full control, requires manual Node setup |

Do **not** use single-domain shared hosting — it lacks Node.js runtime.

---

## Deployment Options

### OPTION A — GitHub + Auto Deploy (Recommended)

1. Push the project to a **private** GitHub repository.

2. In Hostinger hPanel:
   - Go to **Websites** → select your domain
   - Open **Node.js Apps** (or **Web Apps**)
   - Click **Create Node.js App**

3. Configure the Node.js app:

   | Setting | Value |
   |---------|-------|
   | **App root** | `/` or the subdirectory where the project lives |
   | **Node.js version** | `20` LTS or `22` LTS |
   | **Build command** | `npm install && npm run build` |
   | **Start command** | `npm run start` |
   | **App port** | Leave empty (Hostinger assigns via `PORT` env) |
   | **Deployment method** | Connect GitHub repository |

4. Add **environment variables** (use the **Add Variable** button in hPanel):

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-anon-key
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_PUBLISHABLE_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ZATCA_DEVICE_KEY_ENCRYPTION_SECRET=your-encryption-secret
   ZATCA_ENVIRONMENT=simulation
   NODE_ENV=production
   ```

5. Click **Deploy**.

6. After deployment, enable **SSL** (Let's Encrypt) in hPanel.

7. Wait for the build to complete (~2-5 minutes), then test your domain.

---

### OPTION B — ZIP Upload (Manual)

1. Build locally:
   ```bash
   npm install
   npm run build
   ```

2. Create a ZIP archive **excluding**:
   - `node_modules/` (will be installed on server)
   - `.env` (secrets stay local)
   - `.next/` (will be rebuilt)
   - `.git/`
   - `node_modules/`

3. In Hostinger hPanel:
   - Open **File Manager**
   - Upload and extract the ZIP into the application root

4. Open **Node.js Apps** → create a new app:

   | Setting | Value |
   |---------|-------|
   | **Build command** | `npm install && npm run build` |
   | **Start command** | `npm run start` |

5. Add the same **environment variables** as Option A above.

6. Start / restart the Node.js app.

7. Enable SSL.

---

## Environment Variables (hPanel)

Add these in Hostinger **Node.js Apps** → **Environment Variables** section:

| Variable | Source | Required | Notes |
|----------|--------|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Settings → API | ✅ | Visible to browser code |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase Dashboard → Settings → API | ✅ | Safe for client; this is the anon key |
| `SUPABASE_URL` | Same as above | ✅ | Server-only |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase Dashboard | ✅ | Server-only (same as anon key) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Settings → API → `service_role` | ✅ | **Never expose to client code** |
| `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET` | Generate a random 64-char hex string | ⚠️ Required for ZATCA | Server-only |
| `ZATCA_ENVIRONMENT` | Set to `simulation` | ⚠️ Required for ZATCA | Change to `production` only after ZATCA onboarding |
| `NODE_ENV` | Always `production` | ✅ | |
| `PORT` | Hostinger sets this automatically | ❌ | Only define if Hostinger docs require it |

---

## Start Command Notes

The default start command `npm run start` runs:
```
next start -p ${PORT:-3000}
```

- `${PORT:-3000}` uses the `PORT` env var (set by Hostinger), falling back to `3000`.
- If your Hostinger environment does not support bash variable syntax, use the alternative:

  ```bash
  node server.cjs
  ```

  The `server.cjs` file reads `process.env.PORT` directly.

---

## Common Hostinger Issues

### 502 Bad Gateway

**Causes:**
- App crashed on startup (check **Error Logs** in hPanel)
- Missing environment variables (app throws on missing `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`)
- Wrong Node.js version (use 20 or 22 LTS)
- Wrong start command
- Port mismatch (the app must listen on the port Hostinger assigns)

**Fix:** Check hPanel → Error Logs. Add missing env vars. Restart the app.

### Build Failed

**Causes:**
- Memory limit during `next build` (upgrade plan or use `NODE_OPTIONS="--max-old-space-size=1024"`)
- Missing dependencies in `package.json`
- TypeScript errors

**Fix:** Run `npm run typecheck` locally first. Check build logs in hPanel.

### App Starts but API Routes Fail (500)

**Causes:**
- `SUPABASE_SERVICE_ROLE_KEY` missing (RPC route handler needs it)
- Supabase project paused or URL wrong
- CORS if frontend and API are on different origins (unlikely with Next.js)

**Fix:** Verify all env vars are set correctly in hPanel.

### Static Pages Load but Backend Fails

**Cause:** The app was deployed as **Static Hosting** instead of **Node.js Web App**.

**Fix:** Delete the static site. Re-create as **Node.js App** in hPanel.

### Port Not Working

**Cause:** The app is hardcoded to port 3000 but Hostinger assigns a different port.

**Fix:** Use the standard `npm run start` script which reads `$PORT` from the environment, or use `node server.cjs`.

---

## Security Notes

- **Never** commit `.env` with real secrets to git.
- The `SUPABASE_SERVICE_ROLE_KEY` bypasses Row-Level Security — keep it server-only.
- The `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET` encrypts the ZATCA device private key — keep it server-only.
- Only `NEXT_PUBLIC_*` variables are accessible in browser code.
- Use `.env.example` as a template — copy to `.env` and fill in real values locally.

---

## Post-Deploy Verification

After deployment, verify:

1. Domain resolves (HTTPS)
2. `/` landing page loads
3. `/pos/login` — POS login page loads
4. `/dashboard/login` — Dashboard login page loads
5. `/api/rpc` — returns `{"error": "Missing fnName"}` (expected — confirms RPC route works)
6. Cashier login works
7. Admin login works
8. POS creates orders
9. Invoices render
10. Dashboard reports load

Use `HOSTINGER_SMOKE_TEST.md` for a full checklist.

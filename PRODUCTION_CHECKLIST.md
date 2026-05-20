# Production Checklist — Yellow Chicken POS

## Before Deploy

### Code Readiness
- [ ] `npm run typecheck` passes (0 errors)
- [ ] `npm run lint` passes
- [ ] `npm run build` succeeds
- [ ] `.env.example` is complete with all required variables
- [ ] `.env` is **not** committed to git
- [ ] No fake/demo data visible in production UI
- [ ] No hardcoded passwords in client-side code (`src/lib/accountsStore.ts`)
- [ ] No TanStack / Vite / Lovable / Cloudflare dependencies remain
- [ ] `package.json` scripts use Next.js only

### Database
- [ ] Supabase migrations applied to production database
- [ ] Row-Level Security (RLS) enabled on all tables
- [ ] Service role key is **not** used in client code
- [ ] Database backups configured (Supabase → Database → Backups)
- [ ] Restaurant settings exist in production DB (`restaurant_settings` table)
- [ ] At least one admin/owner user exists in production DB

### Environment Variables (Hostinger hPanel)
- [ ] `NEXT_PUBLIC_SUPABASE_URL` set
- [ ] `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` set
- [ ] `SUPABASE_URL` set
- [ ] `SUPABASE_PUBLISHABLE_KEY` set
- [ ] `SUPABASE_SERVICE_ROLE_KEY` set (server-only)
- [ ] `ZATCA_DEVICE_KEY_ENCRYPTION_SECRET` set (if using ZATCA)
- [ ] `ZATCA_ENVIRONMENT` set to `simulation` (do not set to `production` until onboarded)
- [ ] `NODE_ENV` set to `production`

### Domain & SSL
- [ ] Production domain selected and pointed to Hostinger
- [ ] SSL certificate enabled (Let's Encrypt)
- [ ] Domain resolves over HTTPS

---

## After Deploy

### Smoke Tests (Route Level)
- [ ] `/` — landing page loads
- [ ] `/pos/login` — POS login page renders
- [ ] `/dashboard/login` — Dashboard login page renders
- [ ] `/pos` — POS screen loads (after login)
- [ ] `/pos/open-shift` — Open shift page renders
- [ ] `/pos/recent-orders` — Recent orders page loads
- [ ] `/dashboard` — Dashboard loads
- [ ] `/dashboard/products` — Product management loads
- [ ] `/dashboard/reports` — Reports load
- [ ] `/dashboard/inventory` — Inventory page loads
- [ ] `/dashboard/finance` — Finance page loads
- [ ] `/dashboard/zatca` — ZATCA page loads (shows simulation mode)
- [ ] `/dashboard/settings` — Settings loads
- [ ] `/api/rpc` — Returns `{"error":"Missing fnName"}` (confirms API route works)

### Smoke Tests (Business Logic)
- [ ] Cashier can log in (credentials from Supabase Auth)
- [ ] Admin (owner/manager) can log in
- [ ] Cashier can open a shift with opening cash
- [ ] Cashier can select products and add to cart
- [ ] Cashier can complete a cash order
- [ ] Cashier can complete a card/mada order
- [ ] Invoice renders with QR code
- [ ] Invoice reprint works
- [ ] Recent orders list loads
- [ ] Order search/filter works
- [ ] Hold/resume order flow works
- [ ] Refund (full and partial) works
- [ ] Cashier can close shift
- [ ] Dashboard loads with real data
- [ ] Dashboard reports show data
- [ ] Settings can be viewed (read-only)

### Security Tests
- [ ] Cashier **cannot** access dashboard routes
- [ ] Dashboard user **cannot** access cashier-only actions (unless explicitly allowed)
- [ ] No secrets visible in page source (View Page Source → search for "service_role", "private", "password")
- [ ] ZATCA OTP is **not** logged to console
- [ ] `/api/rpc` returns 400/404 for unknown function names
- [ ] `/api/rpc` returns 401 for unauthenticated requests (if middleware added)

---

## Performance Checks
- [ ] First page load completes in under 5 seconds
- [ ] POS product grid loads quickly
- [ ] Order creation completes in under 3 seconds
- [ ] Dashboard reports render within 5 seconds
- [ ] No console errors on critical pages

## Monitoring
- [ ] Hostinger error logs are accessible
- [ ] Supabase query performance is acceptable
- [ ] Supabase daily API quota is sufficient for expected usage

## Go-Live Final Checks
- [ ] Deploy to production during low-traffic hours
- [ ] Test with real (test) payment if payment gateway is connected
- [ ] Verify invoice numbers are sequential and correct
- [ ] Confirm VAT calculation is correct
- [ ] Confirm all Arabic text renders properly
- [ ] Confirm RTL layout works worldwide
- [ ] Take a full-page screenshot of each critical page for rollback reference

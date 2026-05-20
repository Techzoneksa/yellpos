# Smoke Test — Yellow Chicken POS on Hostinger

## Route Smoke Tests

| # | Route | Expected Result | ✅ / ❌ |
|---|-------|-----------------|---------|
| 1 | `/` | Landing page loads with theme |
| 2 | `/pos/login` | POS login form renders |
| 3 | `/dashboard/login` | Dashboard login form renders |
| 4 | `/pos` | POS screen loads (or redirects to login if unauthenticated) |
| 5 | `/pos/open-shift` | Open shift form loads |
| 6 | `/pos/recent-orders` | Recent orders list loads (may be empty) |
| 7 | `/dashboard` | Dashboard loads with stats |
| 8 | `/dashboard/products` | Product management grid loads |
| 9 | `/dashboard/categories` | Category management loads |
| 10 | `/dashboard/addons` | Addon management loads |
| 11 | `/dashboard/reports` | Reports hub loads |
| 12 | `/dashboard/inventory` | Inventory list loads |
| 13 | `/dashboard/purchases` | Purchase invoices load |
| 14 | `/dashboard/recipes` | Recipe management loads |
| 15 | `/dashboard/finance` | Finance page loads |
| 16 | `/dashboard/expenses` | Expenses list loads |
| 17 | `/dashboard/settings` | Settings page loads |
| 18 | `/dashboard/shifts` | Shift history loads |
| 19 | `/dashboard/users` | User management loads |
| 20 | `/dashboard/customers` | Customer list loads |
| 21 | `/dashboard/zatca` | ZATCA hub loads (simulation mode) |
| 22 | `/dashboard/audit` | Audit log loads |
| 23 | `/dashboard/suppliers` | Suppliers list loads |
| 24 | `/dashboard/payroll` | Payroll page loads |

## API Smoke Tests

| # | Test | Command / Action | Expected Result | ✅ / ❌ |
|---|------|------------------|-----------------|---------|
| 25 | RPC endpoint | `POST /api/rpc` with no body | `{"error":"Missing fnName"}` |
| 26 | RPC unknown fn | `POST /api/rpc` with `{"fnName":"nope"}` | `{"error":"Unknown function: nope"}` |
| 27 | Static page | `GET /pos/login` | HTML page (not JSON) |
| 28 | 404 page | `GET /nonexistent` | Next.js 404 page |

## Business Smoke Tests

### Cashier Flow
| # | Step | Action | Expected | ✅ / ❌ |
|---|------|--------|----------|---------|
| 29 | POS Login | Enter cashier credentials | Logged in, open shift prompt |
| 30 | Open Shift | Enter opening cash, submit | Shift opens, POS screen appears |
| 31 | Add to cart | Tap a product | Product appears in cart |
| 32 | Customize | Modify addons / spice | Cart updates correctly |
| 33 | Cash order | Pay with cash | Order created, invoice shown |
| 34 | Card order | Pay with card/mada | Order created, invoice shown |
| 35 | Invoice | View invoice | Invoice has QR code, correct totals |
| 36 | Hold order | Tap hold | Order held, visible in held list |
| 37 | Resume order | Resume from held list | Cart restored |
| 38 | Recent orders | View recent orders | Orders list loads |
| 39 | Search order | Search by order number | Correct order found |
| 40 | Refund | Select order → full or partial refund | Refund processed |
| 41 | Close shift | Enter closing cash, submit | Shift closed, totals match |

### Dashboard Flow
| # | Step | Action | Expected | ✅ / ❌ |
|---|------|--------|----------|---------|
| 42 | Login | Enter admin credentials | Dashboard loads |
| 43 | Products | Add/edit a product | Product saved |
| 44 | Categories | Add a category | Category saved |
| 45 | Shift report | View shifts | Shift data visible |
| 46 | Settings | View settings | Settings loaded from DB |
| 47 | Reports | View sales report | Data renders |

## Security Smoke Tests

| # | Test | Method | Expected | ✅ / ❌ |
|---|------|--------|----------|---------|
| 48 | No service role key in source | View page source, search `service_role` | Not found |
| 49 | No hardcoded passwords | View page source, search `Sultan2030` | Not found |
| 50 | RPC auth | Unauthenticated RPC call | Returns error or redirects |
| 51 | Cashier isolation | Cashier visits `/dashboard/*` | Access denied or redirect |

## Environment / Config Checks

| # | Check | Expected | ✅ / ❌ |
|---|-------|----------|---------|
| 52 | SSL active | HTTPS padlock in browser |
| 53 | Arabic text renders | All Arabic labels visible |
| 54 | RTL layout | Right-to-left direction correct |
| 55 | Console errors | No 500 errors in browser console |
| 56 | Network errors | No failed API calls |
| 57 | Build version | App matches latest build |
| 58 | No fake data | No demo/test data in UI |

## Instructions

1. Run through each test row.
2. Mark ✅ if the result matches expected.
3. Mark ❌ if it fails, and note the error.
4. For any ❌, check:
   - Browser console for errors
   - Network tab for failed requests
   - Hostinger Error Logs
   - Environment variables in hPanel
5. Fix and re-deploy if needed, then re-run the failing tests.

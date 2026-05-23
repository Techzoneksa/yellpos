#!/bin/bash
# ============================================================
# Yellow Chicken POS — Hostinger deployment script
# Run this in Hostinger Terminal from the app root directory
# (where package.json lives)
# ============================================================
set -e

echo "=== 1. Fix file permissions ==="
chmod -R 755 src
find src -type f -exec chmod 644 {} \;
find src -type d -exec chmod 755 {} \;
chmod -R 755 public 2>/dev/null || true
chmod 644 package.json package-lock.json server.cjs next.config.ts tsconfig.json postcss.config.js eslint.config.js components.json 2>/dev/null || true
chmod 755 deploy.sh

echo "=== 2. Clear stale cache ==="
rm -rf .next

echo "=== 3. Install dependencies ==="
npm ci

echo "=== 4. Build ==="
npm run build

echo "=== 5. Done! Restart the Node.js app from Hostinger panel ==="
echo "=== 6. Test: https://crmprom.com/api/ping ==="
echo "=== 7. Test: https://crmprom.com/api/health ==="

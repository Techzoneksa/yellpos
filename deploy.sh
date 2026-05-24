#!/bin/bash
# ============================================================
# Yellow Chicken POS — Hostinger deployment script
# Run this in Hostinger Terminal from the app root directory
# ============================================================
set -e

echo "=== 1. Fix file permissions ==="
find . -type d -exec chmod 755 {} \;
find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.mjs" -o -name "*.cjs" -o -name "*.json" -o -name "*.css" -o -name "*.svg" -o -name "*.png" -o -name "*.ico" -o -name "*.txt" -o -name "*.md" -o -name "*.yml" -o -name "*.yaml" -o -name "*.example" \) -exec chmod 644 {} \;
chmod 755 deploy.sh 2>/dev/null || true

echo "=== 2. Clear stale cache ==="
rm -rf .next

echo "=== 3. Install dependencies ==="
npm ci

echo "=== 4. Build ==="
npm run build

echo "=== 5. Done ==="
echo "Next: Restart Node.js app from Hostinger panel"
echo "Then test:"
echo "  https://crmprom.com/api/ping"
echo "  https://crmprom.com/api/health"

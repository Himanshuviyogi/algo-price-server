#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-admin.sh — Build admin panel locally and deploy to VPS
#
# Run from your Mac:
#   chmod +x deploy-admin.sh
#   ./deploy-admin.sh
#
# What it does:
#   1. Builds the React admin panel (output → price-server/admin-dist/)
#   2. SCPs the built files to the VPS
#   3. Restarts PM2 on the VPS
#
# Requirements on your Mac:
#   - Node.js 18+ and npm
#   - SSH access to the VPS (key-based preferred)
#
# Config — set these to match your server:
# ─────────────────────────────────────────────────────────────────────────────

VPS_USER="root"                         # SSH username on the VPS
VPS_HOST="31.172.87.141"               # VPS IP address
VPS_APP_DIR="C:/apps/algo-price-server" # App directory on the Windows VPS (use forward slashes for SCP)
VPS_APP_DIR_SCP="/c/apps/algo-price-server" # SCP-compatible path

# ─────────────────────────────────────────────────────────────────────────────

set -e  # exit on any error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_DIR="$(dirname "$SCRIPT_DIR")/admin-panel"
DIST_DIR="$SCRIPT_DIR/admin-dist"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     Algo Trading Admin Panel — Deploy         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Step 1: Install admin panel dependencies ──────────────────────────────────
echo "▶ Step 1/4 — Installing admin panel dependencies..."
cd "$ADMIN_DIR"
npm install --silent
echo "  ✓ Dependencies ready"

# ── Step 2: Build admin panel ─────────────────────────────────────────────────
echo ""
echo "▶ Step 2/4 — Building admin panel..."
npm run build
echo "  ✓ Build complete → admin-dist/ ($(du -sh "$DIST_DIR" | cut -f1))"

# ── Step 3: Copy to VPS ───────────────────────────────────────────────────────
echo ""
echo "▶ Step 3/4 — Copying to VPS ($VPS_HOST)..."
echo "  (You may be prompted for your SSH password if key auth isn't configured)"
scp -r "$DIST_DIR/"* "${VPS_USER}@${VPS_HOST}:${VPS_APP_DIR_SCP}/admin-dist/"
echo "  ✓ Files copied"

# ── Step 4: Restart PM2 on VPS ───────────────────────────────────────────────
echo ""
echo "▶ Step 4/4 — Restarting price server on VPS..."
ssh "${VPS_USER}@${VPS_HOST}" "pm2 restart algo-price-server && pm2 save"
echo "  ✓ Server restarted"

echo ""
echo "✅ Done! Admin panel is live at:"
echo "   http://${VPS_HOST}:3002/admin"
echo ""

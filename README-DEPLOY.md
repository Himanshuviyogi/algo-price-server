# Deployment Guide — Algo Trading Price Server

## Quick Reference

| Task | Script | Where to run |
|---|---|---|
| Update server code only | `update-server.bat` | Windows VPS |
| Build + deploy admin panel (from Mac) | `deploy-admin.sh` | Mac / Linux |
| Build + deploy admin panel (on server) | `deploy-admin-server.bat` | Windows VPS |

---

## First-time server setup

See `DEPLOY.md` for the full fresh-setup guide (Node, Git, PM2, .env, Firebase service account).

---

## Everyday update workflow

### Option A — Update from the VPS (recommended)

SSH or RDP into the VPS, open Command Prompt in `C:\apps\algo-price-server\`:

**Server code only (no admin panel change):**
```bat
update-server.bat
```

**Server code + admin panel:**
```bat
deploy-admin-server.bat
```

### Option B — Deploy admin panel from your Mac

```bash
cd /path/to/price-server
./deploy-admin.sh
```

Edit the top of `deploy-admin.sh` to set your SSH credentials:
```bash
VPS_USER="root"
VPS_HOST="31.172.87.141"
```

---

## Admin panel URL

Once deployed: **http://31.172.87.141:3002/admin**

The admin panel is a React + Vite app built from the `../admin-panel/` directory
(one level up from this repo). The built output goes into `admin-dist/` here,
which is served by Express at the `/admin` route.

### Important: vite.config.ts base path

The admin panel **must** be built with `base: '/admin/'` so asset URLs are correct.
The `vite.config.ts` in `admin-panel/` should contain:

```ts
export default defineConfig({
  base: '/admin/',
  build: {
    outDir: '../price-server/admin-dist',
    emptyOutDir: true,
  },
  // ...
})
```

This is already configured. The deploy scripts handle this automatically.

---

## Health check

```
http://31.172.87.141:3002/health
```

Expected response when healthy:
```json
{
  "status": "ok",
  "broker": "connected",
  "cachedSymbols": 243,
  "uptime": 12345.6
}
```

---

## PM2 commands

```cmd
pm2 status                          # see process status
pm2 logs algo-price-server          # live logs
pm2 logs algo-price-server --lines 200   # last 200 lines
pm2 restart algo-price-server       # restart
pm2 monit                           # CPU/memory dashboard
```

---

## Troubleshooting

**Admin panel shows blank page or 404 assets**
→ Rebuild with `deploy-admin-server.bat` — the vite `base` must be `/admin/`

**Broker shows "disconnected" in /health**
→ Angel One session expired. The server auto-reconnects. Check `pm2 logs` for auth errors.

**`pm2 restart` fails**
→ Run `pm2 start ecosystem.config.js` to re-register the process, then `pm2 save`

**Port 3002 not reachable**
→ Check Windows Firewall: `New-NetFirewallRule -DisplayName "Algo" -Direction Inbound -Protocol TCP -LocalPort 3002 -Action Allow`

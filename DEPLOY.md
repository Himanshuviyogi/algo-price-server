# Deploying Algo Trading Price Server — Windows Server

This guide covers the full setup from a **fresh Windows Server** to a running,
auto-restarting Node.js price server managed by PM2.

---

## Prerequisites (install once)

### 1. Node.js (LTS)
Download and install from https://nodejs.org/en/download  
Recommended: **Node.js 20 LTS**  
During install, tick **"Add to PATH"**.

Verify:
```cmd
node -v
npm -v
```

### 2. Git
Download from https://git-scm.com/download/win  
During install, choose **"Git from the command line and also from 3rd-party software"**.

Verify:
```cmd
git --version
```

### 3. PM2 (process manager)
```cmd
npm install -g pm2
npm install -g pm2-windows-startup
```

---

## First-time setup on the server

### Step 1 — Clone the repository
Open **Command Prompt** or **PowerShell** as Administrator:

```cmd
cd C:\
mkdir apps
cd apps
git clone https://github.com/YOUR_USERNAME/algo-price-server.git
cd algo-price-server
```

### Step 2 — Install dependencies
```cmd
npm install --omit=dev
```

### Step 3 — Create the `.env` file
Copy the example and fill in real values:

```cmd
copy .env.example .env
notepad .env
```

Fill in every value — see the section below for what each means.

### Step 4 — Add Firebase service account
1. Go to Firebase Console → Project Settings → Service Accounts
2. Click **"Generate new private key"** → download the JSON file
3. Rename it to `firebase-service-account.json`
4. Place it in `C:\apps\algo-price-server\firebase-service-account.json`

Make sure `.env` has:
```
FIREBASE_SERVICE_ACCOUNT=./firebase-service-account.json
```

### Step 5 — Create logs directory
```cmd
mkdir logs
```

### Step 6 — Start the server with PM2
```cmd
pm2 start ecosystem.config.js
pm2 save
```

### Step 7 — Configure PM2 to start on Windows boot
```cmd
pm2-startup install
pm2 save
```

This registers PM2 as a Windows Service that starts automatically on reboot.

---

## Environment variables (`.env` reference)

| Variable | Description | Example |
|---|---|---|
| `ANGEL_API_KEY` | Angel One API key | `abc123xyz` |
| `ANGEL_CLIENT_ID` | Angel One client ID | `A12345` |
| `ANGEL_PASSWORD` | Angel One login password | `yourpassword` |
| `ANGEL_TOTP_SECRET` | TOTP secret (base32) for 2FA | `JBSWY3DPEHPK3PXP` |
| `FIREBASE_SERVICE_ACCOUNT` | Path to Firebase service account JSON | `./firebase-service-account.json` |
| `PORT` | Port the server listens on | `3001` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | `https://yourapp.com` |
| `BROADCAST_INTERVAL_MS` | Price broadcast interval in ms | `1000` |
| `MARKET_OPEN_HOUR` | Market open hour (IST, 24h) | `9` |
| `MARKET_OPEN_MINUTE` | Market open minute (IST) | `15` |
| `MARKET_CLOSE_HOUR` | Market close hour (IST, 24h) | `15` |
| `MARKET_CLOSE_MINUTE` | Market close minute (IST) | `30` |
| `PRICE_SERVER_URL` | Public URL of this server (used by Firebase Functions) | `http://31.172.87.141:3001` |

---

## Windows Firewall — open port 3001

Run in PowerShell as Administrator:

```powershell
New-NetFirewallRule -DisplayName "Algo Price Server" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 3001 `
  -Action Allow
```

---

## Updating the server (after pushing new code to GitHub)

```cmd
cd C:\apps\algo-price-server
git pull origin main
npm install --omit=dev
pm2 restart algo-price-server
```

One-liner you can paste into a `.bat` file for convenience:

```bat
@echo off
cd C:\apps\algo-price-server
git pull origin main
npm install --omit=dev
pm2 restart algo-price-server
echo Done.
pause
```

Save as `update.bat` in `C:\apps\algo-price-server\` and double-click to deploy.

---

## Useful PM2 commands

```cmd
pm2 status                        # see all running processes
pm2 logs algo-price-server        # tail live logs
pm2 logs algo-price-server --lines 200   # last 200 log lines
pm2 restart algo-price-server     # restart after code change
pm2 stop    algo-price-server     # stop the server
pm2 delete  algo-price-server     # remove from PM2 list
pm2 monit                         # real-time CPU/memory dashboard
```

---

## Health check

Once running, verify the server is up:

```
http://YOUR_SERVER_IP:3001/health
```

Expected response:
```json
{
  "status": "ok",
  "broker": "disconnected",
  "cachedSymbols": 0,
  "uptime": 12.3
}
```

Broker will show `"connected"` during NSE market hours (Mon–Fri, 9:15 AM–3:30 PM IST).

---

## Connecting the Flutter app

In your Flutter project, set the `PRICE_SERVER_URL` build argument:

```bash
flutter run --dart-define=PRICE_SERVER_URL=http://YOUR_SERVER_IP:3001
```

Or in your Flutter CI/CD build config:
```
--dart-define=PRICE_SERVER_URL=http://31.172.87.141:3001
```

---

## Security notes

- **Never commit `.env` or `firebase-service-account.json`** — both are in `.gitignore`
- Run the server behind a **reverse proxy (nginx/IIS)** with HTTPS in production
- Restrict port 3001 in the firewall to only your app's IP if possible
- Rotate your Angel One TOTP secret and API key if they're ever exposed

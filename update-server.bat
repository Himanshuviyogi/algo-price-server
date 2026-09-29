@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM update-server.bat — One-click price server updater (no admin panel rebuild)
REM
REM Run this ON the VPS whenever you push new server code to GitHub:
REM   cd C:\apps\algo-price-server
REM   update-server.bat
REM
REM What it does:
REM   1. git pull — gets latest server code
REM   2. npm install --omit=dev — updates server dependencies only
REM   3. pm2 restart — zero-downtime restart
REM
REM Use deploy-admin-server.bat instead if you also changed the admin panel.
REM ─────────────────────────────────────────────────────────────────────────────

setlocal

set SCRIPT_DIR=%~dp0

echo.
echo ╔══════════════════════════════════════════════╗
echo ║   Algo Trading Price Server — Quick Update   ║
echo ╚══════════════════════════════════════════════╝
echo.

cd /d "%SCRIPT_DIR%"

REM ── Step 1: Pull ─────────────────────────────────────────────────────────────
echo [1/3] Pulling latest code...
git pull origin main
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: git pull failed.
    pause & exit /b 1
)
echo       Done.

REM ── Step 2: Dependencies ─────────────────────────────────────────────────────
echo.
echo [2/3] Updating server dependencies...
npm install --omit=dev
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: npm install failed.
    pause & exit /b 1
)
echo       Done.

REM ── Step 3: Restart ──────────────────────────────────────────────────────────
echo.
echo [3/3] Restarting server...
pm2 restart algo-price-server
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: pm2 restart failed. Trying pm2 start...
    pm2 start ecosystem.config.js
)
pm2 save

echo.
echo ============================================================
echo   Server updated and restarted.
echo   Health check: http://31.172.87.141:3002/health
echo ============================================================
echo.
pause

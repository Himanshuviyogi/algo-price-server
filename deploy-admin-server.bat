@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM deploy-admin-server.bat — Build admin panel ON the Windows VPS
REM
REM Run this ON the VPS (in PowerShell or Command Prompt as Administrator):
REM   cd C:\apps\algo-price-server
REM   deploy-admin-server.bat
REM
REM What it does:
REM   1. git pull — gets latest code from GitHub
REM   2. npm install — installs/updates price server dependencies
REM   3. Builds the admin panel React app
REM   4. Output lands in admin-dist\ (already the right place)
REM   5. pm2 restart — picks up new admin-dist automatically
REM
REM Requirements on the VPS:
REM   - Node.js 18+ in PATH
REM   - Git in PATH
REM   - PM2 installed globally (npm install -g pm2)
REM ─────────────────────────────────────────────────────────────────────────────

setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set ADMIN_DIR=%SCRIPT_DIR%..\admin-panel

echo.
echo ╔══════════════════════════════════════════════╗
echo ║   Algo Trading Admin Panel — Server Build    ║
echo ╚══════════════════════════════════════════════╝
echo.

REM ── Step 1: Pull latest code ─────────────────────────────────────────────────
echo [1/5] Pulling latest code from GitHub...
cd /d "%SCRIPT_DIR%"
git pull origin main
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: git pull failed. Check your internet connection and git config.
    pause & exit /b 1
)
echo       Done.

REM ── Step 2: Install price server dependencies ─────────────────────────────────
echo.
echo [2/5] Installing price server dependencies...
npm install --omit=dev
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: npm install failed.
    pause & exit /b 1
)
echo       Done.

REM ── Step 3: Install admin panel dependencies ─────────────────────────────────
echo.
echo [3/5] Installing admin panel dependencies...
cd /d "%ADMIN_DIR%"
npm install
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: admin panel npm install failed.
    pause & exit /b 1
)
echo       Done.

REM ── Step 4: Build admin panel ─────────────────────────────────────────────────
echo.
echo [4/5] Building admin panel...
npm run build
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: admin panel build failed.
    pause & exit /b 1
)
echo       Build complete - output in price-server\admin-dist\

REM ── Step 5: Restart price server ─────────────────────────────────────────────
echo.
echo [5/5] Restarting price server (PM2)...
cd /d "%SCRIPT_DIR%"
pm2 restart algo-price-server
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: pm2 restart failed - try: pm2 start ecosystem.config.js
) else (
    pm2 save
    echo       Server restarted.
)

echo.
echo ============================================================
echo   SUCCESS! Admin panel is live at:
echo   http://31.172.87.141:3002/admin
echo ============================================================
echo.
pause

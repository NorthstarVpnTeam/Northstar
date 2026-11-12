@echo off
setlocal EnableExtensions
title Northstar V2Ray - Windows build (Rust/Tauri)

rem ============================================================
rem  Northstar V2Ray - Windows build
rem  Rust/Tauri app: check toolchain -> install -> verify -> build
rem  The window stays open on failure so errors can be read.
rem ============================================================

set "STEP=init"

echo.
echo ============================================================
echo   Northstar V2Ray - Windows build (Rust/Tauri)
echo ============================================================
echo.

rem ---------- 1. Toolchain checks -----------------------------
set "STEP=toolchain check"

where node >nul 2>nul
if errorlevel 1 (
    echo [FAIL] Node.js was not found on PATH.
    echo        Install Node.js 18 or newer from https://nodejs.org/ and re-run.
    goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [FAIL] npm was not found on PATH.
    echo        Reinstall Node.js with npm included.
    goto :fail
)
where cargo >nul 2>nul
if errorlevel 1 (
    echo [FAIL] cargo (Rust) was not found on PATH.
    echo        Install Rust from https://rustup.rs/ and re-open this window.
    goto :fail
)
where rustc >nul 2>nul
if errorlevel 1 (
    echo [FAIL] rustc was not found on PATH.
    echo        Install Rust from https://rustup.rs/ and re-open this window.
    goto :fail
)

for /f "delims=" %%v in ('node --version') do set "NODE_V=%%v"
for /f "delims=" %%v in ('cargo --version') do set "CARGO_V=%%v"
echo [OK]   Node.js %NODE_V%
echo [OK]   %CARGO_V%

rem ---------- 2. Project location -----------------------------
set "STEP=project location"
cd /d "%~dp0"
if not exist "package.json" (
    echo [FAIL] package.json not found next to this script.
    goto :fail
)
if not exist "src-tauri\Cargo.toml" (
    echo [FAIL] src-tauri\Cargo.toml not found. The Rust app is missing.
    goto :fail
)
echo [OK]   Working directory: %CD%

rem ---------- 3. Install dependencies -------------------------
set "STEP=dependency install"
echo.
echo [STEP] Installing the Tauri CLI...
if exist "package-lock.json" (
    call npm ci --no-audit --no-fund
) else (
    call npm install --no-audit --no-fund
)
if errorlevel 1 (
    echo [FAIL] Dependency install failed. See the npm output above.
    goto :fail
)
echo [OK]   Dependencies installed.

rem ---------- 4. Automated checks -----------------------------
set "STEP=automated checks (JS + Rust)"
echo.
echo [STEP] Running interface checks, legacy JS tests and Rust engine tests...
call npm run verify
if errorlevel 1 (
    echo [FAIL] Checks or tests failed. Fix the errors above before building.
    goto :fail
)
echo [OK]   All checks passed.

rem ---------- 5. Fetch the proxy core -------------------------
set "STEP=proxy core download"
echo.
echo [STEP] Downloading the pinned Xray core into core\...
call npm run fetch:core
if errorlevel 1 (
    echo [FAIL] Could not download the proxy core. Check your connection.
    goto :fail
)
echo [OK]   Proxy core ready.

rem ---------- 6. Build ----------------------------------------
set "STEP=Tauri release build"
echo.
echo [STEP] Building the Rust app and installers (this can take a few minutes)...
call npm run build
if errorlevel 1 (
    echo [FAIL] The Tauri build failed. See its output above.
    echo        Common causes: missing MSVC build tools, no internet, or a locked target folder.
    goto :fail
)
echo [OK]   Build complete.

rem ---------- 7. Report ---------------------------------------
echo.
echo ============================================================
echo   BUILD SUCCEEDED
echo ============================================================
echo   Installers:
echo     src-tauri\target\release\bundle\nsis\  (NSIS setup .exe)
echo     src-tauri\target\release\bundle\msi\  (MSI package)
echo   Executable:
echo     src-tauri\target\release\northstar-app.exe
echo.
echo   Notes:
echo     - The UI runs in the Windows WebView2 runtime, so no browser
echo       engine is bundled with the app.
echo     - Xray-core (xray.exe, geoip.dat, geosite.dat) is downloaded
echo       into core\ by scripts\fetch-core.js and shipped as a resource.
echo     - System proxy mode is not ported to the Rust build yet.
echo ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo ============================================================
echo   BUILD FAILED at step: %STEP%
echo   Exit code : %ERRORLEVEL%
echo   Directory : %CD%
echo   Read the messages above for the exact cause, then re-run.
echo ============================================================
echo.
pause
exit /b 1

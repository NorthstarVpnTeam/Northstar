@echo off
setlocal EnableExtensions
title Northstar V2Ray - Windows Build

rem ============================================================
rem  Northstar V2Ray - Windows build script
rem  Steps: check toolchain -> install deps -> verify -> build
rem  The window stays open on failure so errors can be read.
rem ============================================================

set "STEP=init"
set "FAILED=0"

echo.
echo ============================================================
echo   Northstar V2Ray - Windows build
echo ============================================================
echo.

rem ---------- 1. Toolchain checks -----------------------------
set "STEP=toolchain check"

where node >nul 2>nul
if errorlevel 1 (
    echo [FAIL] Node.js was not found on PATH.
    echo        Install Node.js 18 or newer from https://nodejs.org/ and re-run this script.
    goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [FAIL] npm was not found on PATH.
    echo        Reinstall Node.js with npm included.
    goto :fail
)

where makensis >nul 2>nul
if errorlevel 1 (
    echo [FAIL] makensis (NSIS compiler) was not found on PATH.
    echo        Install NSIS from https://nsis.sourceforge.io/ and add it to PATH.
    echo        Or build portable-only: electron-builder --win --portable --publish never
    goto :fail
)

for /f "delims=" %%v in ('node --version') do set "NODE_V=%%v"
for /f "delims=" %%v in ('npm --version') do set "NPM_V=%%v"
echo [OK]   Node.js %NODE_V%
echo [OK]   npm %NPM_V%

rem ---------- 2. Project location -----------------------------
set "STEP=project location"
cd /d "%~dp0"
if not exist "package.json" (
    echo [FAIL] package.json not found next to this script.
    goto :fail
)
echo [OK]   Working directory: %CD%

rem ---------- 3. Install dependencies -------------------------
set "STEP=dependency install"
echo.
echo [STEP] Installing dependencies (npm install)...
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
set "STEP=automated checks (syntax + tests)"
echo.
echo [STEP] Running syntax checks and unit tests...
call npm run verify
if errorlevel 1 (
    echo [FAIL] Checks or tests failed. Fix the errors above before building.
    goto :fail
)
echo [OK]   All checks passed.

rem ---------- 5. Build the Windows application ----------------
set "STEP=Windows package build"
echo.
echo [STEP] Building the Windows distribution (installer + portable)...
echo        This downloads Electron tooling on first run and may take a few minutes.
call npm run dist:win
if errorlevel 1 (
    echo [FAIL] The electron-builder step failed. See its output above.
    echo        Common causes: no internet access, antivirus interference, or a locked dist folder.
    goto :fail
)
echo [OK]   Build complete.

rem ---------- 6. Clean dist folder (keep only the 2 exes) -------
set "STEP=dist cleanup"
echo.
echo [STEP] Cleaning dist folder (keeping only the 2 exes)...
for %%F in ("dist\*") do (
    if "%%~nxF" NEQ "Northstar V2Ray-2.0.0-x64-setup.exe" (
        if "%%~nxF" NEQ "Northstar V2Ray-2.0.0-x64-portable.exe" (
            if exist "%%F" (
                echo        removing %%~nxF
                del /f /q "%%F" >nul 2>nul
            )
            if exist "%%F\" (
                echo        removing %%~nxF\
                rmdir /s /q "%%F" >nul 2>nul
            )
        )
    )
)
echo [OK]   Dist folder cleaned.

rem ---------- 7. Report ---------------------------------------
echo.
echo ============================================================
echo   BUILD SUCCEEDED
echo ============================================================
echo   Output folder: %CD%\dist
echo     - Northstar V2Ray-^<version^>-x64-setup.exe    (NSIS installer with custom UI)
echo     - Northstar V2Ray-^<version^>-x64-portable.exe  (portable)
echo.
echo   Notes:
echo     - The Xray core (xray.exe, geoip.dat, geosite.dat) is downloaded
echo       into core^/ by scripts^/fetch-core.js before packaging, so the
echo       installer ships with a working core. Run ^"npm run fetch:core^"
echo       to fetch it on its own.
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
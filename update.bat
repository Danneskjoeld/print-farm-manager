@echo off
setlocal EnableExtensions
rem Always run from the directory this bat file lives in (the repo root),
rem regardless of where it was launched from.
cd /d "%~dp0"

rem This deployment intentionally follows the feature branch, never main.
set "BRANCH=codex/inventory-maintenance-costs-bambu"

echo ============================================================
echo  Print Farm Manager — Update
echo ============================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo ERROR: Git was not found. Install Git for Windows and run this update again.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm was not found. Install Node.js and run this update again.
    pause
    exit /b 1
)

echo [1/4] Installing latest commit from GitHub branch %BRANCH%...
rem Fetching and resetting explicitly prevents an accidental update from main
rem when the server was previously left on a different branch. This replaces
rem only versioned source files; server/data and server/gcode are ignored by Git.
git fetch origin %BRANCH%
if errorlevel 1 (
    echo.
    echo ERROR: Could not fetch origin/%BRANCH%. Check the internet connection and repository access.
    pause
    exit /b 1
)
git checkout -B %BRANCH% origin/%BRANCH%
if errorlevel 1 (
    echo.
    echo ERROR: Could not switch to branch %BRANCH%.
    pause
    exit /b 1
)
git reset --hard origin/%BRANCH%
if errorlevel 1 (
    echo.
    echo ERROR: Could not reset to origin/%BRANCH%.
    pause
    exit /b 1
)
for /f %%a in ('git rev-parse --short HEAD') do set "COMMIT=%%a"
echo Installed commit %COMMIT% from %BRANCH%.
echo Done.
echo.

echo [2/4] Installing server dependencies...
call npm ci --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo ERROR: server dependency installation failed.
    pause
    exit /b 1
)
echo Done.
echo.

echo [3/4] Building client...
cd client
call npm ci --legacy-peer-deps --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo ERROR: client dependency installation failed.
    cd ..
    pause
    exit /b 1
)
call npm run build
if errorlevel 1 (
    echo.
    echo ERROR: client build failed. See output above.
    cd ..
    pause
    exit /b 1
)
cd ..
echo Done.
echo.

echo [4/4] Restarting server...
rem Kill only the process on port 3000 — avoids accidentally killing this bat's own process tree.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /R ":3000 "') do (
    taskkill /F /PID %%a 2>nul
)
timeout /t 2 /nobreak >nul
echo.
echo ============================================================
echo  Update complete! Server starting below.
echo  Close this window to stop the server.
echo ============================================================
echo.
node server\index.js


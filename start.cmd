@echo off
setlocal
title StemPlay

pushd "%~dp0app" || (
    echo [StemPlay] Cannot find the app directory next to this script.
    pause
    exit /b 1
)

where.exe node.exe >nul 2>&1
if errorlevel 1 goto :missing_node
where.exe npm.cmd >nul 2>&1
if errorlevel 1 goto :missing_node

if not exist "node_modules\.bin\vite.cmd" (
    echo [StemPlay] Installing frontend dependencies from package-lock.json...
    call npm.cmd ci
    if errorlevel 1 goto :failed
)

if not exist "..\build\test_song\current.json" (
    echo [StemPlay] No default demo yet. Use Import in the app, or see pipeline\README.md.
)

echo [StemPlay] Starting the local player. Press Ctrl+C to stop.
call npm.cmd run dev -- --host 127.0.0.1 --open
if errorlevel 1 goto :failed
popd
exit /b 0

:missing_node
echo [StemPlay] Node.js and npm must be available on PATH.

:failed
popd
echo [StemPlay] Startup failed. See the message above.
pause
exit /b 1

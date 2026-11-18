@echo off
title MyChat Server
cd /d "%~dp0"

echo ==========================================
echo   MyChat Server (Single Terminal Mode)
echo ==========================================
echo Press Ctrl+C to stop both server and Cloudflare Tunnel.
echo.

:loop
node server.js
if errorlevel 1 (
    echo.
    echo [WARN] Server exited with error. Restarting in 3 seconds...
    timeout /t 3 /nobreak >nul
    goto loop
)

pause

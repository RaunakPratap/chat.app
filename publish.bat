@echo off
title Push Frontend to GitHub (Vercel Auto-Deploy)
cd /d "%~dp0"

echo ========================================================
echo   Pushing latest frontend files to GitHub (chat.app)...
echo ========================================================
echo.

git pull --rebase origin main
git add public/ vercel.json package.json package-lock.json server.js start.bat publish.bat .gitignore backend-url.txt app/
git commit -m "Update frontend files for Vercel deployment"
git push origin main

echo.
echo ========================================================
echo   Done! GitHub updated.
echo   Vercel will auto-deploy the changes in 1-2 minutes!
echo ========================================================
echo.
pause

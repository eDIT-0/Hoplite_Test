@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install Node.js 24 LTS.
  pause
  exit /b 1
)
if not exist .env copy /y .env.example .env >nul
echo Hoplite Local - keep this window open while using the app.
echo Open the local URL printed below in your browser.
node server.mjs
pause

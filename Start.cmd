@echo off
setlocal
cd /d "%~dp0" || exit /b 1
node scripts/dev-start.mjs
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%

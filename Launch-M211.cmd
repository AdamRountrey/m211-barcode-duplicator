@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. See README.md for setup.
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
start "M211 Connect" "node_modules\electron\dist\electron.exe" .

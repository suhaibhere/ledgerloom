@echo off
cd /d "%~dp0"
if not exist "node_modules\read-excel-file\package.json" call npm install
start "LedgerLoom server" /min cmd /c "cd /d ""%~dp0"" && npm start"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:4173"

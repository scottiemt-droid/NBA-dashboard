@echo off
rem Starts the local board server (if not already running) and opens the board.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://localhost:8077/ -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 start "NBA Board server" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
timeout /t 2 /nobreak >nul
start "" http://localhost:8077/

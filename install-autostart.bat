@echo off
rem One-time setup: LifeMentor server auto-starts at Windows logon (hidden).
cd /d %~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
echo.
pause

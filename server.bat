@echo off
rem LifeMentor server — one-click launcher for a local machine.
rem Double-click to start; close the window to stop.
cd /d %~dp0
call npm run dev:server
pause

# LifeMentor — one-time setup: the server starts automatically at Windows logon (hidden).
#
# What it does:
#   1) writes .env once (stable JWT secret + VAPID pair) so sessions and push survive restarts
#   2) builds the production server bundle (apps/server/dist/main.mjs)
#   3) writes a hidden launcher (server-run.vbs) that logs to server.log
#   4) registers a scheduled task "LifeMentor Server" (runs at logon, no window)
#
# Remove later:  schtasks /Delete /TN "LifeMentor Server" /F
# After a git pull that touches the server:  npm run build:server
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host '1/4 Writing .env (stable server identity — safe to run again)...'
npm run init:env
if ($LASTEXITCODE -ne 0) { throw 'npm run init:env failed' }

Write-Host '2/4 Building the production server bundle...'
npm run build:server
if ($LASTEXITCODE -ne 0) { throw 'npm run build:server failed' }

Write-Host '3/4 Writing the hidden launcher...'
$vbs = @"
Set sh = CreateObject("Wscript.Shell")
sh.Run "cmd /c cd /d ""$root"" && node apps\server\dist\main.mjs >> ""$root\server.log"" 2>&1", 0, False
"@
Set-Content -Path (Join-Path $root 'server-run.vbs') -Value $vbs -Encoding ASCII

Write-Host '4/4 Registering the scheduled task "LifeMentor Server" (at logon)...'
$tr = 'wscript.exe "' + (Join-Path $root 'server-run.vbs') + '"'
schtasks /Create /F /TN 'LifeMentor Server' /SC ONLOGON /TR $tr | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'schtasks failed' }

Write-Host ''
Write-Host 'Done. The server starts automatically when you log into Windows (no window).'
Write-Host '  status : http://localhost:8787/v1/health     (log: server.log)'
Write-Host '  stop   : schtasks /End /TN "LifeMentor Server"'
Write-Host '  remove : schtasks /Delete /TN "LifeMentor Server" /F'
Write-Host '  update : after git pull run  npm run build:server'

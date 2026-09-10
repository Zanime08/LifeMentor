import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Assemble the user-facing server archive (req. 17, 65, 67).
 *
 *   node scripts/package-server.mjs [--out release/server]
 *
 * The bundle is self-contained — Fastify, zod and the whole engine are compiled into a single
 * `lifementor-server.mjs`, so the archive can be extracted anywhere and started with Node alone:
 * no npm install, no node_modules, no database setup. On its first run the server writes its own
 * `.env` (stable JWT secret + VAPID pair) next to itself, so sessions and push subscriptions
 * survive restarts without the user generating keys by hand.
 *
 * Runs in CI (the `server` job) and locally; `apps/server/build.mjs` must have produced the bundle.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = join(root, 'apps/server/dist/main.mjs');

const outIndex = process.argv.indexOf('--out');
const outDir = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : join(root, 'release/server'));

if (!existsSync(source)) {
  console.error(`No bundle at ${source} — run "npm run build:server" first.`);
  process.exit(1);
}

const readme = `LifeMentor server (self-hosted)
==============================

This archive contains the whole server: accounts, sync, news, the AI gateway and Web Push.
Nothing else is required except Node.js 22 or newer (https://nodejs.org).

Start it
--------
  Windows         : double-click server.bat  (a window stays open; close it to stop)
  Any OS          : node lifementor-server.mjs
  Start at logon  : run install-autostart.ps1 once (PowerShell), it starts hidden and logs
                    to server.log in this folder

Check that it is alive: http://localhost:8787/v1/health  →  {"ok":true,...}

Configuration
-------------
The first start writes .env in this folder with a stable server identity:
  JWT_SECRET        keeps sessions valid across restarts
  VAPID_PUBLIC_KEY  keeps Web Push subscriptions valid across restarts
  VAPID_PRIVATE_KEY
Do not delete that file: it is this server's identity. Copy it with your backups.

Optional, in the same .env:
  PORT=8787                            listening port
  DATABASE_PATH=data/server.sqlite     where the data lives (back it up!)
  OPENAI_API_KEY=... | ANTHROPIC_API_KEY=... | GOOGLE_API_KEY=...
                                       enable cloud AI (without them the server uses the local
                                       heuristic provider and says so)

Clients
-------
In the app: Settings → «Аккаунт и синхронизация» → «Сервер LifeMentor» → http://<this machine>:8787
Keep the server reachable from your devices (same Wi-Fi, or a VPN such as Tailscale).
`;

const bat = `@echo off
rem LifeMentor server — double-click to start, close the window to stop.
cd /d %~dp0
node lifementor-server.mjs
pause
`;

const ps1 = `# LifeMentor server — start it automatically at Windows logon (hidden, logging to server.log).
# Run once:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# Stop now :  schtasks /End /TN "LifeMentor Server"
# Remove   :  schtasks /Delete /TN "LifeMentor Server" /F
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# The first start creates .env (stable JWT secret + VAPID pair) in this folder — keep it.

$vbs = @"
Set sh = CreateObject("Wscript.Shell")
sh.Run "cmd /c cd /d ""$root"" && node lifementor-server.mjs >> ""$root\server.log"" 2>&1", 0, False
"@
Set-Content -Path (Join-Path $root 'server-run.vbs') -Value $vbs -Encoding ASCII

$tr = 'wscript.exe "' + (Join-Path $root 'server-run.vbs') + '"'
schtasks /Create /F /TN 'LifeMentor Server' /SC ONLOGON /TR $tr | Out-Null
Write-Host 'Done. The server starts when you log in (no window). Status: http://localhost:8787/v1/health'
`;

mkdirSync(outDir, { recursive: true });
copyFileSync(source, join(outDir, 'lifementor-server.mjs'));
writeFileSync(join(outDir, 'README.txt'), readme);
writeFileSync(join(outDir, 'server.bat'), bat.replace(/\n/g, '\r\n'));
writeFileSync(join(outDir, 'install-autostart.ps1'), ps1.replace(/\n/g, '\r\n'));
try { chmodSync(join(outDir, 'lifementor-server.mjs'), 0o755); } catch { /* Windows */ }

const size = statSync(join(outDir, 'lifementor-server.mjs')).size;
console.log(`Packaged server → ${outDir}`);
console.log(`  lifementor-server.mjs  ${(size / 1024 / 1024).toFixed(2)} MB (self-contained)`);
console.log('  README.txt, server.bat, install-autostart.ps1');

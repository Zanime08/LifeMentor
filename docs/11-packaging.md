# Packaging — Windows (.exe) and Android (.apk) (req. 17, 65, 67)

LifeMentor ships as two installable apps. **The user never sees the backend**: no Docker, no
Node.js, no manual database, no terminal (req. 17/67). The server (auth, sync, news, AI
gateway, Web Push) is a separate deployment; the client stores its URL in Settings →
«Аккаунт и синхронизация» → «Сервер LifeMentor».

## One shared bundle, three runtimes

`apps/web` is the single UI source. The runtime-aware bootstrap
(`apps/web/src/core/app.ts`) detects the environment and picks the bindings:

| | Browser preview | Windows (Tauri 2) | Android (Capacitor 8) |
|---|---|---|---|
| SQL engine | WASM SQLite in IndexedDB/OPFS | **rusqlite** (Rust side, real connection) | **platform SQLite** (`@capacitor-community/sqlite` v8, WAL) |
| Secure storage | localStorage | `tauri-plugin-store` (JSON in app data dir) | `@capacitor/preferences` (SharedPreferences) |
| Notifications | Web Notification + in-app timers | `tauri-plugin-notification` — **native scheduling** | `@capacitor/local-notifications` — OS scheduling, fires in background |
| Files (export/import) | download / file input | dialog + `tauri-plugin-fs` | `@capacitor/filesystem` + share sheet / file input |
| Network state | navigator events | navigator events (WebView2) | `@capacitor/network` |
| Vite chunks | index + wasm chunks | + `tauri-*.js` (never loaded in browser) | + `capacitor-*.js` (never loaded in browser) |

The shell code is a separate, code-split chunk: the browser preview never downloads it.
The `sql_*` invoke contract (Tauri) and the v8 plugin API (Capacitor) are pinned by
automated tests: `packages/core/test/tauri-driver.test.ts` and
`packages/core/test/capacitor-driver.test.ts` (a Rust/Android emulator in CI asserts
argument names, result shapes, pragmas, backup/restore byte flow, data surviving re-open).

**AI provider keys never reach the device** (req. 20/58): both shells use the same server
gateway; the Rust/Android sides only execute controlled SQL for the local DB (req. 24) and
OS services.

## Where user data lives

* **Windows**: `%APPDATA%\ai.lifementor.app\data\lifementor.sqlite` (WAL) +
  `%APPDATA%\ai.lifementor.app\secure-store.json` (device id, cloud-backup key, …).
* **Android**: app-private directory (`files/lifementor.sqlite`), SharedPreferences.
  Exports are handed to the Android share sheet so the user keeps them in their own storage.

Backups: local images + JSON export/import + cloud backup (client-side AES-GCM) work
identically in all three runtimes — the restore flow (`sql_restore_bytes` / plugin copy)
is covered by the driver contract tests.

## Building — one command per platform (release machine)

Prereq everywhere: Node ≥ 20.11 and `npm ci` at the repo root.

### Windows — `LifeMentorSetup.exe` (NSIS)

Release machine: **Windows** with Rust stable (MSVC toolchain) and the VS Build Tools
(Windows 11 SDK) — the standard Tauri prerequisites.

```bash
npm ci
npm run shell:windows        # = apps/desktop: npx tauri build
# → apps/desktop/src-tauri/target/release/bundle/nsis/LifeMentor Setup X.Y.Z.exe
```

`tauri build` runs `beforeBuildCommand` (web build) automatically, so the command above is
the whole job. Development: `cd apps/desktop && npx tauri dev` (Vite dev server + hot reload).

Code signing (optional, recommended): configure
`bundle.windows.signingCert` / `DigiCert` in `tauri.conf.json` or pass the certificate
environment variables on the build machine — Tauri signs the NSIS installer and the binary.

### Android — `LifeMentor.apk`

Release machine: **JDK 21** (Capacitor 8 compiles with `sourceCompatibility 21`) + **Android SDK** (compileSdk 36; `ANDROID_HOME` set or
Android Studio installed).

```bash
npm ci
npm run shell:android        # web build + cap sync android (one command)
cd apps/mobile/android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

`assembleDebug` produces an installable APK without a keystore (internal testing).
Release signing: create a keystore (`keytool -genkeypair -v -keystore lifementor-release.keystore
-alias lifementor -keyalg RSA -keysize 2048 -validity 10000`) and build with:

```bash
./gradlew assembleRelease \
  -PRELEASE_KEY_STORE=lifementor-release.keystore \
  -PRELEASE_KEY_ALIAS=lifementor \
  -PRELEASE_KEY_PASSWORD=... -PRELEASE_STORE_PASSWORD=...
```

Development: `cd apps/mobile && npx cap run android` (build + install + run on a connected
device) or Android Studio → open `apps/mobile/android`.

### FCM (remote push to a closed Android app)

FCM is **opt-in and degrades honestly**: without a Firebase project the app builds and works
exactly as before — the device just never gets an FCM token, and notifications arrive via the
polling fallback (`GET /v1/notifications/pending`), as always.

To enable it:

1. **Firebase** (one time, free tier): console → create a project → *Project settings → Your
   apps → Add app → Android*, package name `ai.lifementor.app` → download
   `google-services.json` → place it at `apps/mobile/android/app/google-services.json`
   (template: `google-services.example.json`). The Android build picks it up automatically —
   the google-services gradle plugin is applied only when the file exists.
2. **Server** (so it can send): set one of in the environment —
   * `FIREBASE_SERVICE_ACCOUNT_FILE=/path/to/service-account.json` (recommended), or
   * `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`
   (the private key is the `private_key` field of the service-account JSON; unescaped newlines
   or literal `\n` both work). Create the key under *IAM & admin → Service accounts →
   Firebase AdminSDK* (any project role that includes Cloud Messaging).
3. Rebuild the APK and restart the server. That's all — the Android shell registers its FCM
   token on start (`POST /v1/notifications/push-token`, `kind: 'fcm'`) and the server delivers
   through the FCM v1 API (`services/fcm.ts`: RS256 service-account JWT → OAuth2 token →
   `messages:send`).

Delivery semantics (docs/08 §5): **urgent** notifications carry a visible notification
payload, so the OS shows them even with the app closed (and the server marks them delivered —
no double show); everything else is data-only and is shown by the app's local gate (budget /
quiet hours, req. 86) on the next foreground, same path as polling. Dead tokens (FCM 404 /
UNREGISTERED) are removed server-side automatically; the device re-registers on next start.

### CI

`.github/workflows/release.yml` (on tag `v*` or manually): runs the test suite, builds the
NSIS installer on `windows-latest` (Rust cached) and the APK on `ubuntu-latest`
(JDK 21), uploads both as artifacts. Release APK signing is enabled when the repository has
the `ANDROID_KEYSTORE_B64`/`ANDROID_KEY_ALIAS` variables and the matching secrets. FCM is
enabled in the CI-built APK when the repository has the `GOOGLE_SERVICES_JSON_B64` secret
(base64 of `google-services.json`) — otherwise the APK ships with the polling fallback, as
above.

## Running the server on your own machine (Windows)

The clients only need a server URL; one machine on the same network can host it. The build output
is a **single self-contained file** (`release/server/lifementor-server.mjs`, ~2 MB) — no Docker, no
database install, no `node_modules`, no key generation:

```bat
npm run package:server      :: → release/server/{lifementor-server.mjs, README.txt, server.bat, install-autostart.ps1}
npm run init:env            :: optional for the repo itself: writes a root .env (see below)
install-autostart.ps1       :: from the archive: starts the server at logon, hidden, logging to server.log
:: or: server.bat          :: foreground window, close it to stop
```

On its **first start the server configures itself**: if nothing is configured it writes `.env` next
to itself with a random `JWT_SECRET` and a VAPID key pair. That is what makes the server *stable* —
without it the secrets are regenerated on every launch, so every session and every Web Push
subscription dies on restart. The file is an identity: keep it, back it up, copy it with the data.
An existing `.env` (or the same variables in the OS environment) is never overwritten, and the
repository's own workflow keeps its `.env` in the repo root via `npm run init:env`.

Provider API keys are **not** invented by any of this; add `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
`GOOGLE_API_KEY` to the `.env` (or configure them in the app's Settings → AI) to enable cloud models
— the local heuristics work without any keys and the health endpoint says which are present.

Check it with `http://localhost:8787/v1/health` (`ok: true`, `integrity.ok: true`).

## Icons

`assets/app-icon-1024.png` is the master icon. `scripts/generate-icons.mjs` renders it
(no image tooling required) and writes the Android mipmaps; `npx tauri icon
assets/app-icon-1024.png` (from `apps/desktop/src-tauri`) regenerates the full Windows set
(`icon.ico` + PNGs). Both were run and are committed.

## Known limitations (honest list)

* **Remote push**: Web Push works in the browser preview. In the shells, scheduled reminders
  are OS-level (fire even with the app closed). *Server-initiated* push to a closed Android
  app uses FCM (server FCM v1 transport + the `@capacitor/push-notifications` plugin and a
  native `LifeMentorFcmService`) — see "FCM" above. Without a Firebase project configured it
  degrades to the polling fallback, which still delivers every notification.
* **FCM requires a Firebase project** (free) for package `ai.lifementor.app`, plus a server
  service account — both are external credentials we cannot generate in this repo; the code
  path is complete and tested with mocks, and the app is honest about the unconfigured state.
* **Secure store** is a JSON file in the OS app-data area (outside the webview, scoped to the
  user profile). Hardening to the OS keychain/keyring is a documented follow-up.
* The Windows shell uses `currentUser` NSIS install mode (no admin elevation required).

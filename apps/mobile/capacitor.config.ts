import type { CapacitorConfig } from '@capacitor/cli';

/**
 * LifeMentor Android shell (Capacitor).
 *
 * `webDir` points at the SHARED web bundle (apps/web/dist) — the same React app
 * that powers the browser preview; inside this webview the runtime-aware bootstrap
 * switches to the native SQLite driver (platform SQLite, WAL) and the Android
 * platform adapter (SharedPreferences, local notifications, filesystem).
 *
 * Build: `npm run android` (from repo root) → web build + cap sync, then Android
 * Studio / `gradlew assembleRelease` on a machine with the Android SDK.
 */
const config: CapacitorConfig = {
  appId: 'ai.lifementor.app',
  appName: 'LifeMentor',
  webDir: '../web/dist',
  backgroundColor: '#f4f5f2',
  server: {
    // https scheme so the webview treats local storage as secure context
    // (WebCrypto, secure storage, etc.)
    androidScheme: 'https',
  },
  android: {
    // The app talks to the user-configured LifeMentor server (Settings → Sync);
    // mixed content is not needed and stays disabled.
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: '#1e5f4e',
      androidSplashResourceName: 'splash',
      splashImmersive: false,
    },
  },
};

export default config;

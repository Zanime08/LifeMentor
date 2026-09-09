import { defineConfig } from '@playwright/test';

/**
 * UI smoke tests (phase 20). Runs in CI only — the sandbox has no browser.
 * Boots the real dev stack (Vite + server) and verifies the app renders.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  webServer: {
    // `-k` makes concurrently kill the other process if one dies, so
    // Playwright tearing the process down leaves no orphans behind.
    command: 'npx concurrently -k "npm run dev:server" "npm run dev:web"',
    // /v1/health is served through the Vite proxy — ready only when BOTH
    // the dev server and the backend are up.
    url: 'http://127.0.0.1:5173/v1/health',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the SAME dist works in the dev preview, the Tauri
  // shell (tauri://localhost) and the Capacitor webview (capacitor://localhost).
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Allow the sandbox preview host (and local hosts) to load the dev server.
    allowedHosts: true,
    // The API runs on the LifeMentor server in the same deployment. In the dev
    // preview the browser is same-origin with Vite, so /v1 is proxied to it —
    // this is what makes CORS, tokens and sync work without any client config.
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
});

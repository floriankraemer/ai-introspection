import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In the dev container the server (`pnpm dev`) runs next to Vite; override to target another.
const API = process.env.INTROSPECT_API ?? 'http://localhost:7317';
const VITE_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The CodeMirror editor chunk is loaded on demand by the Rubrics screen only.
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: API,
        // The server accepts only its own Host and Origin (ADR-0008). Present Vite's own requests
        // as same-origin to the server; any other Origin passes through unchanged and is refused.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            const origin = req.getHeader('origin');
            if (typeof origin === 'string' && VITE_ORIGINS.has(origin))
              req.setHeader('origin', API);
          });
        },
      },
    },
  },
});

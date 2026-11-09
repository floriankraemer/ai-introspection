import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The CodeMirror editor chunk is loaded on demand by the Rubrics screen only.
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    // In the dev container the server (`pnpm dev`) runs next to Vite; override to target another.
    proxy: { '/v1': process.env.INTROSPECT_API ?? 'http://localhost:7317' },
  },
});

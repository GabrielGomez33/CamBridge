import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served under /cambridge/ (like /Mirror, /admin). React Router uses the same
// basename, and Apache history-fallbacks to index.html.
export default defineConfig({
  plugins: [react()],
  base: '/cambridge/',
  build: { outDir: 'dist' },
  server: {
    // `npm run dev` proxies API + WS to the local Node server for development.
    proxy: {
      '/cambridge/api': 'http://localhost:8447',
      '/cambridge/ws': { target: 'ws://localhost:8447', ws: true },
    },
  },
});

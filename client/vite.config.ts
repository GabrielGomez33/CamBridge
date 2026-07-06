import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Served under /cambridge/ (like /Mirror, /admin). React Router uses the same
// basename, and Apache history-fallbacks to index.html.
export default defineConfig({
  base: '/cambridge/',
  // Build stamp so we can confirm which bundle a device is actually running
  // (surfaced by the ?debug=1 overlay). Helps distinguish "bug" from "stale
  // service-worker cache".
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z'),
  },
  plugins: [
    react(),
    // Installable PWA. We use the generated-service-worker strategy (Workbox) —
    // CamBridge has no push/offline-app-logic, it just needs an installable
    // shell + a precache so the camera UI opens instantly. No custom SW file.
    VitePWA({
      // autoUpdate: a new build's service worker self-activates
      // (skipWaiting + clientsClaim) and the page reloads to it. This is
      // essential for an INSTALLED PWA — `prompt` mode leaves a new build
      // waiting behind the old cached one indefinitely, which traps the
      // standalone app on stale code (works in Safari, "broken" in the PWA).
      registerType: 'autoUpdate',
      // Only precache the app shell. The /viewer route is an OBS Browser Source
      // that must always hit the live signaling server, so we never want a stale
      // SW intercepting API/WS — those are same-origin under /cambridge/api|ws.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/cambridge/index.html',
        // Never let the SW answer API or WebSocket upgrade requests from cache.
        navigateFallbackDenylist: [/^\/cambridge\/api/, /^\/cambridge\/ws/],
        cleanupOutdatedCaches: true,
      },
      includeAssets: [
        'favicon.svg',
        'favicon-16x16.png',
        'favicon-32x32.png',
        'apple-touch-icon.png',
        'splash/*.png',
      ],
      manifest: {
        id: '/cambridge/',
        name: 'CamBridge — P2P Camera',
        short_name: 'CamBridge',
        description:
          'Turn any phone or webcam into a peer-to-peer OBS camera source. No app, no login — a passcode-protected link streams device→OBS over WebRTC. By The Anima Project.',
        start_url: '/cambridge/',
        scope: '/cambridge/',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'any',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        lang: 'en',
        dir: 'ltr',
        categories: ['photo', 'video', 'utilities'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'pwa-maskable-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Start a camera',
            short_name: 'Go Live',
            description: 'Create a new passcode-protected camera link',
            url: '/cambridge/broadcaster',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: { outDir: 'dist' },
  server: {
    // `npm run dev` proxies API + WS to the local Node server for development.
    proxy: {
      '/cambridge/api': 'http://localhost:8447',
      '/cambridge/ws': { target: 'ws://localhost:8447', ws: true },
    },
  },
});

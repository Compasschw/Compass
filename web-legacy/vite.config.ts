import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ command }) => {
  const isProd = command === 'build'

  return {
    plugins: [
      react(),
      tailwindcss(),
      // PWA is only active on production builds to keep dev server unaffected.
      ...(isProd
        ? [
            VitePWA({
              registerType: 'autoUpdate',
              injectRegister: 'auto',

              // skipWaiting + clientsClaim ensures the new SW activates immediately
              // on the next page load, so users always get the latest non-PHI assets.
              workbox: {
                skipWaiting: true,
                clientsClaim: true,

                // ── Static asset precaching ──────────────────────────────────────
                // Only precache bundled JS/CSS/fonts — never API responses.
                globPatterns: ['**/*.{js,css,html,ico,svg,ttf,woff,woff2,webp,avif,png}'],

                // ── Runtime caching ──────────────────────────────────────────────
                runtimeCaching: [
                  // PHI-bearing API routes — NEVER cache, always network-only.
                  // These must be registered BEFORE the general /api/ rule so that
                  // the more-specific NetworkOnly handler wins.
                  //
                  // HIPAA-excluded paths (contain Protected Health Information):
                  //   /api/v1/sessions/* — session records with clinical notes
                  //   /api/v1/requests/* — member care request data
                  //   /api/v1/admin/*    — admin aggregate member/CHW data
                  //
                  // HIPAA Security Rule §164.312(a)(2)(iv): ePHI must not be
                  // stored at rest without appropriate access controls. Browser
                  // caches are not access-controlled, so PHI must never be cached.
                  // Add any new PHI-bearing route prefix here before shipping.
                  {
                    urlPattern: ({ url }) =>
                      url.pathname.startsWith('/api/v1/sessions/') ||
                      url.pathname.startsWith('/api/v1/requests/') ||
                      url.pathname.startsWith('/api/v1/admin/'),
                    handler: 'NetworkOnly',
                    options: {
                      // cacheName is required by the type but this cache is never written to.
                      cacheName: 'phi-network-only-do-not-cache',
                    },
                  },

                  // Non-PHI API calls (auth, public CHW listings, profile metadata):
                  // NetworkFirst keeps data fresh when online; falls back to cache
                  // when offline so unauthenticated/light pages still load.
                  {
                    urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
                    handler: 'NetworkFirst',
                    options: {
                      cacheName: 'api-non-phi-cache',
                      networkTimeoutSeconds: 10,
                      expiration: {
                        maxEntries: 50,
                        maxAgeSeconds: 60 * 60, // 1 hour
                      },
                      cacheableResponse: { statuses: [0, 200] },
                    },
                  },

                  // Static assets already bundled by Vite get StaleWhileRevalidate
                  // so the UI stays snappy while the SW refreshes in the background.
                  {
                    urlPattern: ({ request }) =>
                      request.destination === 'image' ||
                      request.destination === 'font' ||
                      request.destination === 'style' ||
                      request.destination === 'script',
                    handler: 'StaleWhileRevalidate',
                    options: {
                      cacheName: 'static-assets-cache',
                      expiration: {
                        maxEntries: 100,
                        maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
                      },
                      cacheableResponse: { statuses: [0, 200] },
                    },
                  },
                ],
              },

              // Manifest is provided as a static file in /public; tell the plugin
              // not to auto-generate one so we control it explicitly.
              manifest: false,
              manifestFilename: 'manifest.webmanifest',
            }),
          ]
        : []),
    ],
  }
})

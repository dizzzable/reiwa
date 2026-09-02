import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false, // We use our own manifest.webmanifest in public/
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // ── No `<link rel="modulepreload">` ───────────────────────────────────────
    //
    // Vite emits one per static import of the entry chunk — a dozen vendor
    // chunks. With this service worker every one of them is DISCARDED, and
    // Chrome says so out loud: "a preload is found, but is not used because it
    // is a cross-world service worker resource mismatch", once per chunk, plus
    // "preloaded ... but not used within a few seconds" for each again.
    //
    // The cause is ours and deliberate elsewhere: `sw.ts` calls `skipWaiting()`
    // on install and `clients.claim()` on activate, so a new worker takes over
    // a page that is already loading. The preloads went out before the claim
    // and the module requests after it, and a preload fetched in one "world"
    // cannot be matched to a request made in the other. That happens on every
    // first visit and after every deploy — exactly the loads a preload was
    // meant to help.
    //
    // The bytes barely matter: `/assets/*` is immutable for a year, so the
    // second fetch is a cache read. What it cost was the optimisation itself,
    // which never applied, and ~130 warnings per load that buried real console
    // errors. Turning the hints off leaves the vendor chunks to the service
    // worker's own cache-first route, which serves them from Cache Storage for
    // everyone except a first-ever visitor — who now pays one extra round trip
    // of waterfall instead of a preload that was going to be thrown away.
    //
    // Keeping the claim and dropping the hints, rather than the reverse: an
    // update that lands on the next navigation is worth more than a marginally
    // faster first paint.
    modulePreload: false,
    // The largest chunk is the three.js / react-three-fiber bundle used by a
    // handful of WebGL card effects. Every effect is `React.lazy`, so that
    // bundle is ONLY fetched when a card actually mounts such an effect — it
    // never blocks first paint. Keep the warning ceiling a touch above it so
    // the intentional lazy payload is quiet while real regressions still warn.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        // Pull stable third-party libraries out of the main entry into their
        // own long-lived, cacheable vendor chunks. This shrinks the app
        // `index` chunk and lets browsers reuse vendors across deploys (app
        // code changes far more often than these libraries).
        //
        // NOTE: three.js / @react-three / postprocessing / ogl are deliberately
        // NOT grouped here — they are reachable only through `React.lazy`
        // effect modules, so leaving them to split naturally keeps each
        // lazily-loaded effect payload small instead of forcing one giant
        // vendor chunk.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          // three / @react-three / postprocessing / ogl intentionally left to
          // split naturally (see note above) so they stay lazily loaded.
          if (/[\\/]node_modules[\\/](three|@react-three|postprocessing|ogl)[\\/]/.test(id))
            return
          if (/[\\/]node_modules[\\/]lottie-web[\\/]/.test(id)) return 'lottie-vendor'
          if (/[\\/]node_modules[\\/](react-router|react-router-dom|@remix-run)[\\/]/.test(id))
            return 'router-vendor'
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return 'query-vendor'
          if (/[\\/]node_modules[\\/](i18next|react-i18next)[\\/]/.test(id)) return 'i18n-vendor'
          if (/[\\/]node_modules[\\/](motion|framer-motion)[\\/]/.test(id)) return 'motion-vendor'
          if (/[\\/]node_modules[\\/](radix-ui|@radix-ui)[\\/]/.test(id)) return 'radix-vendor'
          if (/[\\/]node_modules[\\/]qrcode[\\/]/.test(id)) return 'qrcode-vendor'
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id))
            return 'react-vendor'
          return 'vendor'
        },
      },
    },
  },
})

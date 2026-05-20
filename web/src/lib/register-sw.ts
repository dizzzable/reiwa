/**
 * Service Worker Registration
 *
 * Registers the service worker and handles strategy violation detection.
 * If the SW reports a strategy violation, it prevents the app from loading
 * until the configuration is corrected.
 */

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return
  }

  // Listen for strategy violation messages from the service worker
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'STRATEGY_VIOLATION') {
      // Strategy violation detected — fail fast
      // Show a blocking error to prevent the app from loading with corrupted caching
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#020202;color:#fff;font-family:system-ui;padding:2rem;text-align:center;">
          <div>
            <h1 style="font-size:1.5rem;margin-bottom:1rem;">Configuration Error</h1>
            <p style="color:#a1a1aa;max-width:400px;">${event.data.message}</p>
            <button onclick="location.reload()" style="margin-top:1.5rem;padding:0.75rem 1.5rem;background:#3b82f6;color:#fff;border:none;border-radius:0.5rem;cursor:pointer;">
              Retry
            </button>
          </div>
        </div>
      `
    }
  })

  try {
    const { registerSW } = await import('virtual:pwa-register')

    registerSW({
      immediate: true,
      onRegisteredSW(swUrl, registration) {
        // Check for updates periodically (every hour)
        if (registration) {
          setInterval(
            () => {
              registration.update()
            },
            60 * 60 * 1000,
          )
        }
      },
      onOfflineReady() {
        console.log('[SW] App ready to work offline')
      },
    })
  } catch (error) {
    console.warn('[SW] Failed to register service worker:', error)
  }
}

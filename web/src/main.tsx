import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'
import { queryClient } from '@/lib/query-client'
import { registerServiceWorker } from '@/lib/register-sw'
import { BrandingProvider } from '@/lib/branding-provider'
import App from './App'
import '@/index.css'
import '@/i18n/i18n'

// Register service worker for PWA support
registerServiceWorker()

const root = document.getElementById('root')!

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <BrandingProvider>
          <TooltipProvider delayDuration={300}>
            <App />
            <Toaster
              position="top-center"
              offset={16}
              toastOptions={{
                // Glass surface matching the cabinet's dialogs/sheets
                // (near-black translucent, heavy blur, hairline border,
                // rounded corners) so toasts read as one design system.
                style: {
                  background: 'rgba(9,9,11,0.92)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  color: '#fafafa',
                  backdropFilter: 'blur(40px)',
                  WebkitBackdropFilter: 'blur(40px)',
                  borderRadius: '16px',
                  boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
                  fontSize: '13px',
                },
              }}
            />
          </TooltipProvider>
        </BrandingProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)

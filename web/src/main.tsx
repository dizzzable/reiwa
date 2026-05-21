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
              toastOptions={{
                style: {
                  background: 'rgba(39,39,42,0.95)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#fff',
                  backdropFilter: 'blur(12px)',
                },
              }}
            />
          </TooltipProvider>
        </BrandingProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)

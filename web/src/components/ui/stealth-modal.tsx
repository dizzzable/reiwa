import { ReactNode, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StealthModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  className?: string
}

export function StealthModal({ open, onClose, title, children, className }: StealthModalProps) {
  // Lock body scroll while open
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  // Close on Escape
  useEffect(() => {
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [onClose])

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          {/* Sheet */}
          <motion.div
            key="sheet"
            className={cn(
              'fixed bottom-0 left-0 right-0 z-50',
              'rounded-t-3xl border-t border-[var(--color-border-soft)] bg-[var(--color-surface-high)]/96 backdrop-blur-2xl',
              'max-h-[90vh] overflow-y-auto scroll-area',
              className,
            )}
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          >
            {/* Handle bar */}
            <div className="sticky top-0 z-10 flex items-center justify-center bg-[var(--color-surface-high)]/98 pt-3 pb-2 backdrop-blur-2xl">
              <div className="h-1 w-10 rounded-full bg-[var(--color-border-strong)]" />
            </div>

            {title && (
              <div className="flex items-center justify-between px-6 pb-4">
                <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
                <button
                  onClick={onClose}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface)] text-[var(--brand-muted-foreground)] transition-colors hover:text-[var(--brand-foreground)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            <div className="px-4 pb-4">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

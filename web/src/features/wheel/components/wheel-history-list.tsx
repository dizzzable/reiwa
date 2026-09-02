import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Loader2 } from 'lucide-react'

import type { WheelHistoryItem } from '@/lib/api-client'

/**
 * Everything this person has spun, and what came of it.
 *
 * The key a person won lives HERE and only here — the result screen shows it
 * once, in the moment, and this is where they come back for it. A prize that
 * can only be read in a toast is a prize somebody loses by looking away.
 */
export function WheelHistoryList({
  open,
  items,
  loading,
  onClose,
}: {
  readonly open: boolean
  readonly items: readonly WheelHistoryItem[]
  readonly loading: boolean
  readonly onClose: () => void
}) {
  const { t } = useTranslation()
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('wheel.history.title')}
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-background p-4 sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-3 text-lg font-semibold">{t('wheel.history.title')}</h2>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('wheel.history.empty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.spinId} className="rounded-lg border p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">
                    {item.title?.ru || item.title?.en || t('wheel.prizeFallback')}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                </div>

                {item.prize?.key ? (
                  <p className="mt-2 break-all font-mono text-sm">{item.prize.key}</p>
                ) : null}
                {item.prize?.promoCode ? (
                  <p className="mt-2 font-mono text-sm">{item.prize.promoCode}</p>
                ) : null}

                {item.status === 'PENDING' ? (
                  <p className="mt-1 text-xs text-amber-500">
                    {t('wheel.history.pending')}
                    {item.ticketId ? (
                      <>
                        {' '}
                        <Link
                          className="underline underline-offset-2"
                          to={`/support?ticket=${encodeURIComponent(item.ticketId)}`}
                        >
                          {t('wheel.history.openChat')}
                        </Link>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {item.status === 'REFUSED' ? (
                  // Said plainly rather than hidden: somebody who wonders what
                  // happened to their jackpot deserves to find the answer here.
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('wheel.history.refused')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

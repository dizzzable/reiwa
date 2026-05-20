import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Bell, CreditCard, CheckCheck } from 'lucide-react'
import { getTransactions, getNotifications, markAllNotificationsRead, markNotificationRead } from '@/lib/api-client'
import { StadiumButton } from '@/components/ui/stadium-button'
import { formatDateTime } from '@/lib/utils'
import { cn } from '@/lib/utils'

const TX_STATUS: Record<string, { label: string; color: string }> = {
  COMPLETED: { label: 'Оплачено',   color: 'text-emerald-400' },
  PENDING:   { label: 'Ожидание',   color: 'text-amber-400' },
  FAILED:    { label: 'Ошибка',     color: 'text-red-400' },
  CANCELED:  { label: 'Отменено',   color: 'text-zinc-500' },
  REFUNDED:  { label: 'Возврат',    color: 'text-blue-400' },
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', RUB: '₽', USDT: '$' }

export default function ActivityPage() {
  const [tab, setTab] = useState<'notifications' | 'transactions'>('notifications')
  const queryClient = useQueryClient()

  const { data: txData, isLoading: txLoading } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => getTransactions(),
    enabled: tab === 'transactions',
  })

  const { data: notifData, isLoading: notifLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => getNotifications(),
    enabled: tab === 'notifications',
  })

  const markAllMutation = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
      queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] })
    },
  })

  const markOneMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
      queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] })
    },
  })

  const unreadCount = notifData?.notifications.filter(n => !n.isRead).length ?? 0

  return (
    <div className="pb-6">
      <div className="px-5 pt-6 pb-4">
        <h1 className="text-xl font-semibold">Активность</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 px-5 mb-4">
        {(['notifications', 'transactions'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all',
              tab === t ? 'bg-rose-500 text-white' : 'bg-zinc-800/80 text-zinc-400 hover:text-white',
            )}
          >
            {t === 'notifications' ? <Bell className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
            {t === 'notifications' ? 'Уведомления' : 'Транзакции'}
          </button>
        ))}
      </div>

      {/* Notifications tab */}
      {tab === 'notifications' && (
        <div>
          {unreadCount > 0 && (
            <div className="flex justify-end px-5 mb-3">
              <StadiumButton
                size="sm" variant="ghost"
                onClick={() => markAllMutation.mutate()}
                loading={markAllMutation.isPending}
                icon={<CheckCheck className="h-4 w-4" />}
              >
                Прочитать все
              </StadiumButton>
            </div>
          )}

          <div className="px-5 space-y-2">
            {notifLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-2xl bg-zinc-800/50" />
              ))
            ) : !notifData?.notifications.length ? (
              <div className="flex flex-col items-center gap-3 py-16 text-zinc-500">
                <Bell className="h-10 w-10 opacity-30" />
                <p className="text-sm">Уведомлений пока нет</p>
              </div>
            ) : (
              notifData.notifications.map((n, i) => (
                <motion.div
                  key={n.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  onClick={() => { if (!n.isRead) markOneMutation.mutate(n.id) }}
                  className={cn(
                    'glass-card p-4 cursor-pointer transition-all',
                    !n.isRead && 'border-rose-500/20 bg-rose-500/[0.03]',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {!n.isRead && <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" />}
                        <p className="text-sm font-medium text-white truncate">{n.title}</p>
                      </div>
                      <p className="mt-1 text-xs text-zinc-400 line-clamp-2">{n.body}</p>
                    </div>
                    <p className="shrink-0 text-xs text-zinc-600">{formatDateTime(n.createdAt)}</p>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Transactions tab */}
      {tab === 'transactions' && (
        <div className="px-5 space-y-2">
          {txLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-2xl bg-zinc-800/50" />
            ))
          ) : !txData?.transactions?.length ? (
            <div className="flex flex-col items-center gap-3 py-16 text-zinc-500">
              <CreditCard className="h-10 w-10 opacity-30" />
              <p className="text-sm">Транзакций пока нет</p>
            </div>
          ) : (
            txData.transactions.map((tx: any, i: number) => {
              const status = TX_STATUS[tx.status] ?? { label: tx.status, color: 'text-zinc-400' }
              return (
                <motion.div
                  key={tx.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="glass-card p-4"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-white">{tx.plan?.name ?? tx.gatewayType}</p>
                      <p className="text-xs text-zinc-500 mt-0.5">{formatDateTime(tx.createdAt)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold">
                        {CURRENCY_SYMBOLS[(tx.pricing as any)?.currency ?? tx.currency] ?? ''}{((tx.pricing as any)?.finalPrice ?? tx.amount ?? 0).toFixed(2)}
                      </p>
                      <p className={cn('text-xs', status.color)}>{status.label}</p>
                    </div>
                  </div>
                </motion.div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

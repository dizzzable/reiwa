/**
 * Devices page — shows HWID devices linked to the user's current subscription.
 * Users can revoke devices to free up slots.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Smartphone, Trash2, Monitor, Apple, Globe } from 'lucide-react'
import { toast } from 'sonner'
import { getUserDevices, deleteUserDevice } from '@/lib/api-client'
import { StadiumButton } from '@/components/ui/stadium-button'
import { BackButton } from '@/components/ui/back-button'
import { TipCard } from '@/components/ui/tip-card'
import { useSession } from '@/hooks/use-session'

function platformIcon(platform: string | null) {
  if (!platform) return <Smartphone className="h-5 w-5" />
  const p = platform.toLowerCase()
  if (p.includes('android')) return <Smartphone className="h-5 w-5 text-emerald-400" />
  if (p.includes('ios') || p.includes('iphone') || p.includes('mac')) return <Apple className="h-5 w-5 text-zinc-300" />
  if (p.includes('windows')) return <Monitor className="h-5 w-5 text-blue-400" />
  return <Globe className="h-5 w-5 text-zinc-400" />
}

export default function DevicesPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { session } = useSession()

  const { data, isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: getUserDevices,
    retry: false,
  })

  const revokeMutation = useMutation({
    mutationFn: (hwid: string) => deleteUserDevice(hwid),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      toast.success(t('devices.deleted'))
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success')
    },
    onError: () => toast.error(t('devices.deleteError')),
  })

  const devices = (data as any)?.devices ?? []
  const deviceCount = (data as any)?.deviceCount ?? 0

  return (
    <div className="pb-8">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-5">
        <BackButton fallback="/dashboard" label={t('common.back')} />
        <div>
          <h1 className="text-lg font-semibold">{t('devices.pageTitle')}</h1>
          <p className="text-xs text-zinc-500">{t('devices.connectedCount', { count: deviceCount })}</p>
        </div>
      </div>

      <div className="px-5 space-y-4">
        <TipCard tone="info" icon={<Smartphone className="h-4 w-4" />}>
          {t('devices.tip')}
        </TipCard>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-2xl bg-zinc-800/50" />
            ))}
          </div>
        ) : !devices.length ? (
          <div className="glass-card p-8 text-center">
            <Smartphone className="h-10 w-10 mx-auto mb-3 text-zinc-600" />
            <p className="text-sm text-zinc-400">{t('devices.emptyTitle')}</p>
            <p className="text-xs text-zinc-600 mt-1">{t('devices.emptyHint')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {devices.map((device: any, i: number) => (
              <motion.div
                key={device.hwid}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="glass-card p-4 flex items-center gap-4"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80">
                  {platformIcon(device.platform)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">
                    {device.deviceName ?? device.platform ?? t('devices.deviceFallback')}
                  </p>
                  <p className="text-xs text-zinc-500 truncate">
                    {device.osVersion ?? ''} {device.hwid.slice(0, 12)}…
                  </p>
                  {device.lastSeenAt && (
                    <p className="text-xs text-zinc-600 mt-0.5">
                      {t('devices.lastSeenLabel', { date: new Date(device.lastSeenAt).toLocaleDateString('ru-RU') })}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => {
                    if (confirm(t('devices.deleteConfirm'))) {
                      revokeMutation.mutate(device.hwid)
                    }
                  }}
                  disabled={revokeMutation.isPending}
                  className="shrink-0 flex h-9 w-9 items-center justify-center rounded-full text-zinc-600 hover:text-(--brand-primary) hover:bg-(--brand-primary)/10 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { NetworkBg } from '@/components/ui/network-bg'
import { ReiwaLogo } from '@/components/ui/reiwa-logo'
import { bootstrapTelegram, getSession } from '@/lib/api-client'
import { SESSION_QUERY_KEY } from '@/hooks/use-session'
import { useTelegramWebApp } from '@/hooks/use-telegram-webapp'

type BootstrapPhase = 'detecting' | 'authenticating' | 'ready' | 'error'

export default function BootstrapPage() {
  const navigate    = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const { initData, isReady, telegram } = useTelegramWebApp()
  const [phase, setPhase]     = useState<BootstrapPhase>('detecting')
  const [errorMsg, setErrorMsg] = useState('')
  const calledRef = useRef(false)

  useEffect(() => {
    if (!isReady || calledRef.current) return
    calledRef.current = true

    async function run() {
      try {
        // 1. Try existing session first
        setPhase('authenticating')
        try {
          const session = await getSession()
          if (session) {
            queryClient.setQueryData(SESSION_QUERY_KEY, session)
            setPhase('ready')
            navigate('/dashboard', { replace: true })
            return
          }
        } catch {
          // No existing session — need to bootstrap
        }

        // 2. Bootstrap with Telegram initData
        if (!initData) {
          // No TMA context — show sign-in alternative or error
          setErrorMsg(t('bootstrap.openInTelegram'))
          setPhase('error')
          return
        }

        const result = await bootstrapTelegram(initData)
        // The WebSession cookie is set server-side. Drop any cached session
        // so guards refetch `/session` and see the fresh authenticated state.
        await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })

        telegram?.HapticFeedback?.notificationOccurred('success')
        setPhase('ready')
        navigate(result.redirectUrl ?? '/dashboard', { replace: true })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : t('bootstrap.loginErrorFallback')
        setErrorMsg(msg)
        setPhase('error')
        telegram?.HapticFeedback?.notificationOccurred('error')
      }
    }

    void run()
  }, [isReady, initData, navigate, queryClient, telegram, t])

  return (
    <div className="relative flex h-dvh flex-col items-center justify-center bg-(--brand-bg-primary) overflow-hidden">
      <NetworkBg intensity="medium" />

      <div className="relative z-10 flex flex-col items-center gap-8 px-8 text-center">
        {/* Logo/brand */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', damping: 20, stiffness: 200 }}
        >
          <div
            className="flex h-24 w-24 items-center justify-center rounded-[28px] bg-white/5 ring-1 ring-white/10 backdrop-blur-xl"
            style={{ boxShadow: '0 0 60px var(--color-brand-glow)' }}
          >
            <ReiwaLogo className="h-14 w-14 text-(--brand-primary)" title="Reiwa" />
          </div>
        </motion.div>

        {/* Brand name */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <h1 className="text-3xl font-bold tracking-[0.15em] text-white uppercase">
            Reiwa
          </h1>
          <p className="mt-1 text-sm text-zinc-500 tracking-widest uppercase">
            VPN Service
          </p>
        </motion.div>

        {/* Status */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="flex flex-col items-center gap-3"
        >
          {phase === 'error' ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-6 py-4 text-sm text-red-400">
              <p className="font-medium">{t('bootstrap.loginError')}</p>
              <p className="mt-1 text-xs text-red-500/80">{errorMsg}</p>
              <button
                onClick={() => {
                  calledRef.current = false
                  setPhase('detecting')
                  window.location.reload()
                }}
                className="mt-3 rounded-full bg-red-500/20 px-4 py-1.5 text-xs text-red-400 hover:bg-red-500/30 transition-colors"
              >
                {t('bootstrap.retry')}
              </button>
            </div>
          ) : phase === 'ready' ? (
            <p className="text-sm text-emerald-400">✓ {t('bootstrap.loginSuccess')}</p>
          ) : (
            <div className="flex items-center gap-3 text-sm text-zinc-500">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
              {phase === 'detecting' ? t('bootstrap.initializing') : t('bootstrap.signingIn')}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}

import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'

import { NetworkBg } from '@/components/ui/network-bg'
import { getSession } from '@/lib/api-client'
import { SESSION_QUERY_KEY } from '@/hooks/use-session'

/**
 * WebHomePage — entry point for browser users (`/`).
 *
 * The flow is intentionally minimal:
 *   1. Try to resolve the existing session cookie via `GET /api/v1/session`.
 *      • Success → put the session in react-query cache, push to `/dashboard`.
 *      • 401 / network error → push to `/sign-in`.
 *   2. While the request is in flight we render a quiet logo splash
 *      identical to the TMA bootstrap so the brand experience stays
 *      consistent across both contexts.
 *
 * No Telegram WebApp probing happens here — that path lives at `/tma`.
 * Browser users that arrive on the bare domain don't need to wait for
 * the Telegram SDK promise to (never) resolve.
 */
export default function WebHomePage() {
  const navigate    = useNavigate()
  const queryClient = useQueryClient()
  const calledRef   = useRef(false)

  useEffect(() => {
    if (calledRef.current) return
    calledRef.current = true

    void (async () => {
      try {
        const session = await getSession()
        if (session) {
          queryClient.setQueryData(SESSION_QUERY_KEY, session)
          navigate('/dashboard', { replace: true })
          return
        }
        navigate('/sign-in', { replace: true })
      } catch {
        navigate('/sign-in', { replace: true })
      }
    })()
  }, [navigate, queryClient])

  return (
    <div className="relative flex h-screen flex-col items-center justify-center bg-[#020202] overflow-hidden">
      <NetworkBg intensity="medium" />

      <div className="relative z-10 flex flex-col items-center gap-8 px-8 text-center">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', damping: 20, stiffness: 200 }}
        >
          <div
            className="flex h-24 w-24 items-center justify-center rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(244,63,94,0.3) 0%, transparent 70%)',
              boxShadow: '0 0 60px rgba(244,63,94,0.4)',
            }}
          >
            <span className="text-5xl">🔐</span>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <h1 className="text-3xl font-bold tracking-[0.15em] text-white uppercase">
            Rezeis
          </h1>
          <p className="mt-1 text-sm text-zinc-500 tracking-widest uppercase">
            VPN Service
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="flex items-center gap-3 text-sm text-zinc-500"
        >
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-rose-500 border-t-transparent" />
          Подключение…
        </motion.div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { ArrowLeft, Tag, CheckCircle2 } from 'lucide-react'
import { activatePromocode } from '@/lib/api-client'
import { StadiumButton } from '@/components/ui/stadium-button'
import { TipCard } from '@/components/ui/tip-card'
import { toast } from 'sonner'

export default function PromoPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [success, setSuccess] = useState(false)
  const [resultMsg, setResultMsg] = useState('')

  // Deep-link prefill: a promo-tagged broadcast button opens this page at
  // `/promo?code=<code>`. Read it once on mount, prefill the input, then strip
  // the param via history.replaceState so a refresh / back doesn't leave the
  // code lingering in the address bar (and the user can still edit it).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const prefill = params.get('code')?.trim()
    if (!prefill) return
    setCode(prefill.toUpperCase())
    params.delete('code')
    const query = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    )
  }, [])

  const mutation = useMutation({
    mutationFn: () => activatePromocode(code.trim().toUpperCase()),
    onSuccess: (data: { success?: boolean; message?: string }) => {
      if (data?.success) {
        setSuccess(true)
        setResultMsg(data.message ?? t('promo.successDefault'))
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success')
      } else {
        toast.error(data?.message ?? t('promo.invalid'))
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error')
      }
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : t('promo.activationError')
      toast.error(msg)
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error')
    },
  })

  if (success) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-8 px-8 text-center pb-20">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="flex h-24 w-24 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10"
          style={{ boxShadow: '0 0 40px rgba(16,185,129,0.3)' }}
        >
          <CheckCircle2 className="h-12 w-12 text-emerald-400" />
        </motion.div>
        <div>
          <h2 className="text-xl font-semibold text-emerald-400">{t('promo.done')}</h2>
          <p className="mt-2 text-sm text-zinc-400">{resultMsg}</p>
        </div>
        <StadiumButton onClick={() => navigate('/dashboard', { replace: true })} glow>
          {t('promo.toHome')}
        </StadiumButton>
      </div>
    )
  }

  return (
    <div className="pb-8">
      <div className="flex items-center gap-3 px-5 py-5">
        <button onClick={() => navigate(-1)} className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400 hover:text-white transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">{t('promo.title')}</h1>
      </div>

      <div className="px-5 space-y-5">
        <TipCard tone="info" icon={<Tag className="h-4 w-4" />}>
          {t('promo.tip')}
        </TipCard>

        <div className="space-y-3">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('promo.inputPlaceholder')}
            maxLength={32}
            className="w-full rounded-2xl border border-white/[0.08] bg-zinc-800/50 px-5 py-4 text-center text-lg font-mono font-bold uppercase tracking-[0.3em] text-white placeholder:text-zinc-600 focus:border-(--brand-primary)/50 focus:outline-none transition-colors"
            onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) mutation.mutate() }}
          />

          <StadiumButton
            fullWidth size="lg"
            onClick={() => mutation.mutate()}
            disabled={!code.trim() || mutation.isPending}
            loading={mutation.isPending}
            glow={!!code.trim()}
          >
            {t('promo.activate')}
          </StadiumButton>
        </div>
      </div>
    </div>
  )
}

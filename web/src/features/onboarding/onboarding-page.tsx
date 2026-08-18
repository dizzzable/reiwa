import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { Shield, Zap, Users, Gift, ArrowRight, Check } from 'lucide-react'
import { useSession } from '@/hooks/use-session'

const STEPS = [
  {
    icon: Shield,
    titleKey: 'intro.step1.title',
    descriptionKey: 'intro.step1.description',
    color: 'text-(--brand-primary)',
    bg: 'bg-(--brand-primary)/10',
  },
  {
    icon: Zap,
    titleKey: 'intro.step2.title',
    descriptionKey: 'intro.step2.description',
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
  },
  {
    icon: Users,
    titleKey: 'intro.step3.title',
    descriptionKey: 'intro.step3.description',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
  },
  {
    icon: Gift,
    titleKey: 'intro.step4.title',
    descriptionKey: 'intro.step4.description',
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
  },
]

export default function OnboardingPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { session } = useSession()
  const [step, setStep] = useState(0)

  const isLast = step === STEPS.length - 1
  const current = STEPS[step]

  function next() {
    if (isLast) {
      navigate('/dashboard', { replace: true })
    } else {
      setStep((s) => s + 1)
    }
  }

  function skip() {
    navigate('/dashboard', { replace: true })
  }

  return (
    // Outside `StealthLayout`, so this page has to be its own scroller —
    // same reason as `/legal` and `/support/guest`, see the note there.
    // `#root` clips at 100dvh and this root carried no `overflow-y` at all,
    // so on a short viewport the dots and the CTA sat past the cut with
    // nothing to reach them: measured in Chrome at 375x360 the three bands
    // come to 420px, the clip is 360px, the CTA ended 12px below the fold
    // and the user scroll range was 0.
    //
    // `h-full min-h-dvh` was a redundant pair, not a scroller. `#root` is a
    // column flex container with a definite `height: 100dvh`, so `h-full`
    // resolved against it to exactly 100dvh — and `min-h-dvh` clamped the
    // same flex item to the same 100dvh by itself. At 375x360 each of the
    // two ALONE still computed `height: 360px`; only dropping both let the
    // box grow (419.5px), and that growth merely ran past `#root`'s clip.
    // Neither half was load-bearing, so both give way to the `h-dvh` every
    // other out-of-shell page uses: a scroll container that sizes to its
    // content never scrolls, it just grows past the clip.
    //
    // The scroller may be this element itself, unlike the two centred
    // splashes (`/payment-return`, `/tma`) which needed an inner
    // `min-h-full justify-center` column. This root is a three-band column
    // whose middle band already absorbs the slack through `flex-1`, so its
    // `justify-content` is `flex-start` and no content is ever stranded
    // ABOVE the scroll origin, where nothing can reach it.
    //
    // `overflow-x-hidden` is not decoration. `overflow-y: auto` promotes a
    // `visible` cross axis to `auto`, and the step transition slides the
    // card +/-40px on x — that is a horizontal scrollbar on every step
    // change. `#root`'s own `overflow: hidden` used to swallow it.
    <div className="scroll-area flex h-dvh flex-col overflow-x-hidden bg-(--brand-bg-primary) text-[color:var(--brand-foreground)]">
      {/* Skip button */}
      <div className="flex justify-end px-5 pt-6">
        <button onClick={skip} className="text-xs text-[color:var(--brand-muted-foreground)] transition-colors hover:text-[color:var(--brand-foreground)]">
          {t('intro.skip')}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.3 }}
            className="flex flex-col items-center text-center"
          >
            {/* Icon */}
            <div className={`flex h-24 w-24 items-center justify-center rounded-3xl ${current.bg} mb-8`}>
              <current.icon className={`h-12 w-12 ${current.color}`} />
            </div>

            {/* Text */}
            <h1 className="text-2xl font-bold mb-3">{t(current.titleKey)}</h1>
            <p className="max-w-xs text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">{t(current.descriptionKey)}</p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Progress + Button */}
      <div className="px-8 pb-12 space-y-6">
        {/* Dots */}
        <div className="flex justify-center gap-2">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === step ? 'w-6 bg-(--brand-primary)' : 'w-1.5 bg-[color:var(--color-border-strong)]'
              }`}
            />
          ))}
        </div>

        {/* Button */}
        <button
          onClick={next}
          className="w-full flex items-center justify-center gap-2 rounded-full bg-(--brand-primary) py-4 text-sm font-semibold text-(--brand-primary-fg) active:scale-[0.98] transition-transform"
        >
          {isLast ? (
            <>
              <Check className="h-5 w-5" />
              {t('intro.start')}
            </>
          ) : (
            <>
              {t('intro.next')}
              <ArrowRight className="h-5 w-5" />
            </>
          )}
        </button>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
    <div className="flex flex-col h-full min-h-dvh bg-(--brand-bg-primary) text-white">
      {/* Skip button */}
      <div className="flex justify-end px-5 pt-6">
        <button onClick={skip} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
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
            <p className="text-sm text-zinc-400 max-w-xs leading-relaxed">{t(current.descriptionKey)}</p>
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
                i === step ? 'w-6 bg-(--brand-primary)' : 'w-1.5 bg-zinc-700'
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

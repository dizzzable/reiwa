import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import { Shield, Zap, Users, Gift, ArrowRight, Check } from 'lucide-react'
import { useSession } from '@/hooks/use-session'

const STEPS = [
  {
    icon: Shield,
    title: 'Добро пожаловать в Rezeis VPN',
    description: 'Быстрый и надёжный VPN для вашей безопасности в интернете.',
    color: 'text-rose-400',
    bg: 'bg-rose-500/10',
  },
  {
    icon: Zap,
    title: 'Мгновенное подключение',
    description: 'Выберите тариф, оплатите и получите ссылку подключения за секунды.',
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
  },
  {
    icon: Users,
    title: 'Реферальная программа',
    description: 'Приглашайте друзей и получайте бонусные дни или баллы за каждого.',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
  },
  {
    icon: Gift,
    title: 'Промокоды и акции',
    description: 'Активируйте промокоды для получения скидок и бонусов.',
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
  },
]

export default function OnboardingPage() {
  const navigate = useNavigate()
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
    <div className="flex flex-col h-full min-h-screen bg-[#020202] text-white">
      {/* Skip button */}
      <div className="flex justify-end px-5 pt-6">
        <button onClick={skip} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
          Пропустить
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
            <h1 className="text-2xl font-bold mb-3">{current.title}</h1>
            <p className="text-sm text-zinc-400 max-w-xs leading-relaxed">{current.description}</p>
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
                i === step ? 'w-6 bg-rose-500' : 'w-1.5 bg-zinc-700'
              }`}
            />
          ))}
        </div>

        {/* Button */}
        <button
          onClick={next}
          className="w-full flex items-center justify-center gap-2 rounded-full bg-rose-500 py-4 text-sm font-semibold text-white active:scale-[0.98] transition-transform"
        >
          {isLast ? (
            <>
              <Check className="h-5 w-5" />
              Начать
            </>
          ) : (
            <>
              Далее
              <ArrowRight className="h-5 w-5" />
            </>
          )}
        </button>
      </div>
    </div>
  )
}

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bot, Loader2 } from 'lucide-react'
import { getAiChatConfig } from '@/lib/api-client/ai-chat'
import { BackButton } from '@/components/ui/back-button'
import { AiChat } from './ai-chat'

/**
 * Full-screen AI assistant at `/support/ai`.
 *
 * Fail-closed: when the operator disables AI (or config fails), redirect to
 * `/support` so there is no orphaned chat surface. Loading holds a spinner
 * instead of flashing the empty chat.
 */
export default function AiSupportPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const { data: aiConfig, isLoading, isError } = useQuery({
    queryKey: ['ai-chat', 'config'],
    queryFn: getAiChatConfig,
    staleTime: 60_000,
  })
  const aiEnabled = aiConfig?.enabled === true

  useEffect(() => {
    if (isLoading) return
    if (isError || !aiEnabled) {
      navigate('/support', { replace: true })
    }
  }, [isLoading, isError, aiEnabled, navigate])

  if (isLoading || isError || !aiEnabled) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-(--brand-primary)" />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-5 py-4">
        <BackButton fallback="/support" label={t('common.back')} />
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-5 w-5 shrink-0 text-(--brand-primary)" />
          <h1 className="truncate text-lg font-semibold">{t('support.aiTitle')}</h1>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <AiChat />
      </div>
    </div>
  )
}

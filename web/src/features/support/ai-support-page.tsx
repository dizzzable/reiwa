import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Bot, Loader2 } from 'lucide-react'
import { getAiChatConfig } from '@/lib/api-client/ai-chat'
import { AiChat } from './ai-chat'

/**
 * Full-screen AI support chat.
 * Opened from "Быстрая помощь" or the create-ticket suggestion banner.
 * If the operator has disabled the assistant, redirects back to /support.
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
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
        <button
          type="button"
          onClick={() => navigate('/support')}
          aria-label={t('common.back')}
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:text-white glass-icon-btn"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-(--brand-primary)" />
          <h1 className="text-lg font-semibold">{t('support.aiTitle')}</h1>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <AiChat />
      </div>
    </div>
  )
}

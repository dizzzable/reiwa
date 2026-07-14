import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Bot } from 'lucide-react'
import { AiChat } from './ai-chat'

/**
 * Full-screen AI support chat page.
 * Reached from the "Быстрая помощь" button or the AI suggestion banner.
 */
export default function AiSupportPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]">
        <button
          onClick={() => navigate('/support')}
          aria-label={t('common.back')}
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:text-white glass-icon-btn"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-(--brand-primary)" />
          <h1 className="text-lg font-semibold">{t('support.aiTitle', 'AI-помощник')}</h1>
        </div>
      </div>

      {/* Chat */}
      <div className="flex-1 min-h-0">
        <AiChat />
      </div>
    </div>
  )
}

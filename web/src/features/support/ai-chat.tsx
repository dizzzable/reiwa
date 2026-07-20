import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Bot, Loader2 } from 'lucide-react'
import { motion } from 'motion/react'
import { sendAiMessage } from '@/lib/api-client/ai-chat'
import type { AiChatMessage } from '@/lib/api-client/ai-chat'
import { cn } from '@/lib/utils'

/**
 * Full-screen AI assistant for basic support questions (plans, VPN setup, apps).
 * Never mutates account state — recommendations only; live tariffs/FAQ via tools.
 */
export function AiChat() {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [conversationId, setConversationId] = useState<string | undefined>()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!loading) inputRef.current?.focus()
  }, [loading])

  async function handleSend() {
    const text = input.trim()
    if (!text || loading) return

    const userMessage: AiChatMessage = { role: 'user', content: text }
    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setLoading(true)

    try {
      const res = await sendAiMessage(text, conversationId)
      setConversationId(res.conversationId)
      // Guard: API/proxy can return undefined content; never .split on it.
      const content = (res.response ?? '').trim() || t('support.aiError')
      setMessages((prev) => [...prev, { role: 'assistant', content }])
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: t('support.aiError') },
      ])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        role="log"
        aria-live="polite"
      >
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-zinc-500">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-(--brand-primary)/25 bg-(--brand-primary)/10">
              <Bot className="h-7 w-7 text-(--brand-primary)" />
            </div>
            <p className="text-base font-medium text-zinc-200">{t('support.aiEmptyTitle')}</p>
            <p className="max-w-sm text-sm leading-relaxed text-zinc-500">
              {t('support.aiEmptyHint')}
            </p>
          </div>
        )}
        {messages.map((msg, i) => {
          const content = msg.content ?? ''
          const lines = content.split('\n')
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                  msg.role === 'user'
                    ? 'rounded-br-sm bg-(--brand-primary)/90 text-white'
                    : 'rounded-bl-sm bg-zinc-800 text-zinc-100',
                )}
              >
                {lines.map((line, j) => (
                  <span key={j}>
                    {line}
                    {j < lines.length - 1 && <br />}
                  </span>
                ))}
              </div>
            </motion.div>
          )
        })}
        {loading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex justify-start"
          >
            <div
              className="rounded-2xl rounded-bl-sm bg-zinc-800 px-4 py-2.5"
              role="status"
              aria-label={t('support.aiThinking')}
            >
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            </div>
          </motion.div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="shrink-0 border-t border-white/[0.06] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('support.aiPlaceholder')}
            aria-label={t('support.aiInputLabel')}
            rows={1}
            className="glass-input max-h-[120px] min-h-[42px] flex-1 resize-none rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-(--brand-primary)/40"
            disabled={loading}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!input.trim() || loading}
            aria-label={t('support.aiSend')}
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-(--brand-primary) text-(--brand-primary-fg) transition-opacity disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

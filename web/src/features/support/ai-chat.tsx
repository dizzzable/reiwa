import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Bot, Loader2 } from 'lucide-react'
import { motion } from 'motion/react'
import { sendAiMessage } from '@/lib/api-client/ai-chat'
import type { AiChatMessage } from '@/lib/api-client/ai-chat'
import { cn } from '@/lib/utils'

/**
 * AI Chat component — full-screen assistant for basic support questions.
 * Sends messages to /api/v1/ai-chat/message with function calling support.
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
      // Guard: API/proxy can return undefined content; never call .split on it.
      const content = (res.response ?? '').trim() || t('support.aiError')
      setMessages((prev) => [...prev, { role: 'assistant', content }])
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `😔 ${t('support.aiError')}` },
      ])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3" role="log" aria-live="polite">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-3">
            <Bot className="h-12 w-12 opacity-30" />
            <p className="text-lg font-medium">🤖 {t('support.aiEmptyTitle')}</p>
            <p className="text-sm max-w-xs">
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
                  'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-md'
                    : 'bg-muted rounded-bl-md'
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
            <div className="bg-muted rounded-2xl rounded-bl-md px-4 py-2.5" role="status" aria-label={t('support.aiThinking')}>
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          </motion.div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t p-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('support.aiPlaceholder')}
            aria-label={t('support.aiInputLabel')}
            rows={1}
            className="flex-1 resize-none rounded-xl border bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 min-h-[42px] max-h-[120px]"
            disabled={loading}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || loading}
            aria-label={t('support.aiSend')}
            className="h-[42px] w-[42px] rounded-xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-40 transition-opacity"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

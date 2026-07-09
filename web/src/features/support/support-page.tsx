import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import { ArrowLeft, Send, Plus, MessageSquare, Loader2, Paperclip } from 'lucide-react'
import { getTickets, getTicket, createTicket, replyToTicket, supportAttachmentUrl } from '@/lib/api-client'
import type { SupportTicket, SupportAttachmentMeta } from '@/lib/api-client'
import { BackButton } from '@/components/ui/back-button'
import { useBranding } from '@/lib/branding-provider'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

function formatTime(dateStr: string) {
  const d = new Date(dateStr)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Renders one support-message attachment: an inline image preview (tap to open
 * full-size) for image types, or a download chip with filename + size for
 * everything else. The binary streams from the same-origin permissioned
 * endpoint (session cookie sent automatically).
 */
function SupportAttachmentView({
  ticketId,
  attachment,
  isUser,
}: {
  ticketId: string
  attachment: SupportAttachmentMeta
  isUser: boolean
}) {
  const url = supportAttachmentUrl(ticketId, attachment.id)
  const isImage = attachment.mimeType.startsWith('image/')
  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl">
        <img
          src={url}
          alt={attachment.filename}
          loading="lazy"
          className="max-h-64 w-auto max-w-full rounded-xl object-cover"
        />
      </a>
    )
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex items-center gap-2 rounded-xl px-3 py-2 text-xs',
        isUser ? 'bg-white/15 text-white' : 'bg-white/5 text-zinc-200',
      )}
    >
      <Paperclip className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
      <span className="shrink-0 opacity-60">{formatBytes(attachment.sizeBytes)}</span>
    </a>
  )
}

function TicketList({ tickets, onSelect, onCreate }: { tickets: SupportTicket[]; onSelect: (id: string) => void; onCreate: () => void }) {
  const { t } = useTranslation()
  const { supportUsername } = useBranding()

  function openTelegramSupport() {
    if (!supportUsername) return
    const url = `https://t.me/${supportUsername}?text=${encodeURIComponent(t('support.contactPrefill'))}`
    const tg = (window as unknown as { Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void } } }).Telegram
    if (tg?.WebApp?.openTelegramLink) tg.WebApp.openTelegramLink(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="pb-8">
      <div className="flex items-center justify-between px-5 py-5">
        <div className="flex items-center gap-3">
          <BackButton fallback="/settings" label={t('support.title')} />
          <h1 className="text-lg font-semibold">{t('support.title')}</h1>
        </div>
        <div className="flex items-center gap-2">
          {supportUsername && (
            <button
              type="button"
              onClick={openTelegramSupport}
              aria-label={t('support.contactTelegram')}
              title={t('support.contactTelegram')}
              className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:text-white glass-icon-btn"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onCreate}
            className="flex items-center gap-1.5 rounded-full bg-(--brand-primary) px-4 py-2 text-sm font-medium text-(--brand-primary-fg) active:scale-95 transition-transform"
          >
            <Plus className="h-4 w-4" />
            {t('support.newTicket')}
          </button>
        </div>
      </div>

      {tickets.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-5 py-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-800/50">
            <MessageSquare className="h-8 w-8 text-zinc-600" />
          </div>
          <p className="text-sm text-zinc-500">{t('support.emptyTitle')}</p>
          <p className="text-xs text-zinc-600">{t('support.emptyHint')}</p>
        </div>
      ) : (
        <div className="px-5 space-y-2">
          {tickets.map((ticket) => (
            <button
              key={ticket.id}
              onClick={() => onSelect(ticket.id)}
              className="w-full glass-card p-4 text-left active:scale-[0.98] transition-transform"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium text-sm truncate flex-1">{ticket.subject}</p>
                <span className={cn(
                  'shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase',
                  ticket.status === 'open' ? 'bg-emerald-500/20 text-emerald-400' :
                  ticket.status === 'waiting_reply' ? 'bg-(--brand-primary) text-(--brand-primary-fg)' :
                  'bg-zinc-700 text-zinc-400'
                )}>
                  {ticket.status === 'waiting_reply' && (
                    <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                  )}
                  {ticket.status === 'open' ? t('support.statusOpen') : ticket.status === 'waiting_reply' ? t('support.statusWaitingShort') : t('support.statusClosed')}
                </span>
              </div>
              {ticket.messages?.[0] && (
                <p className="text-xs text-zinc-500 mt-1.5 truncate">{ticket.messages[0].content}</p>
              )}
              <p className="text-[10px] text-zinc-600 mt-1">{formatTime(ticket.updatedAt)}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TicketChat({ ticketId, onBack }: { ticketId: string; onBack: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data: ticket, isLoading } = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: () => getTicket(ticketId),
    refetchInterval: 5000,
  })

  const replyMutation = useMutation({
    mutationFn: (content: string) => replyToTicket(ticketId, content),
    onSuccess: () => {
      setText('')
      queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] })
    },
    onError: () => toast.error(t('support.sendError')),
  })

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [ticket?.messages])

  // Opening a ticket marks its `support_reply` notification read server-side
  // (rezeis getOne). Once the ticket payload is back, refresh the bell /
  // settings badge so the unread indicator clears immediately instead of
  // waiting for the 60s poll. Keyed on ticket.id → runs once per opened ticket.
  useEffect(() => {
    if (!ticket?.id) return
    queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] })
    queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }, [ticket?.id, queryClient])

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-(--brand-primary)" />
      </div>
    )
  }

  if (!ticket) return null

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]">
        <button onClick={onBack} aria-label={t('common.back')} className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:text-white glass-icon-btn">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{ticket.subject}</p>
          <p className="text-[10px] text-zinc-500 uppercase">
            {ticket.status === 'open' ? `🟢 ${t('support.statusOpen')}` : ticket.status === 'waiting_reply' ? `💬 ${t('support.chatStatusWaiting')}` : `⚫ ${t('support.statusClosed')}`}
          </p>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {ticket.messages.map((msg) => {
          const isUser = msg.authorType === 'user'
          return (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
            >
              <div className={cn(
                'max-w-[80%] rounded-2xl px-4 py-2.5',
                isUser ? 'bg-(--brand-primary)/90 text-white rounded-br-sm' : 'bg-zinc-800 text-zinc-200 rounded-bl-sm'
              )}>
                {msg.content && (
                  <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                )}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className={cn('space-y-2', msg.content ? 'mt-2' : '')}>
                    {msg.attachments.map((att) => (
                      <SupportAttachmentView key={att.id} ticketId={ticketId} attachment={att} isUser={isUser} />
                    ))}
                  </div>
                )}
                <p className={cn('text-[10px] mt-1', isUser ? 'text-white/50' : 'text-zinc-500')}>
                  {formatTime(msg.createdAt)}
                </p>
              </div>
            </motion.div>
          )
        })}
      </div>

      {/* Input */}
      {ticket.status !== 'closed' && (
        <div className="px-5 py-4 border-t border-white/[0.06]">
          <div className="flex gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('support.messagePlaceholder')}
              className="glass-input flex-1 rounded-full px-4 py-3 text-sm text-white"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                  e.preventDefault()
                  replyMutation.mutate(text.trim())
                }
              }}
            />
            <button
              onClick={() => text.trim() && replyMutation.mutate(text.trim())}
              disabled={!text.trim() || replyMutation.isPending}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-(--brand-primary) text-(--brand-primary-fg) disabled:opacity-50 active:scale-95 transition-transform"
            >
              {replyMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CreateTicketForm({ onBack, onCreated }: { onBack: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation()
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')

  const mutation = useMutation({
    mutationFn: () => createTicket(subject.trim(), message.trim()),
    onSuccess: (ticket) => {
      toast.success(t('support.ticketCreated'))
      onCreated(ticket.id)
    },
    onError: () => toast.error(t('support.createError')),
  })

  return (
    <div className="pb-8">
      <div className="flex items-center gap-3 px-5 py-5">
        <button onClick={onBack} aria-label={t('common.back')} className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:text-white glass-icon-btn">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">{t('support.newTicketTitle')}</h1>
      </div>

      <div className="px-5 space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-500 uppercase tracking-wide">{t('support.subjectLabel')}</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={t('support.subjectPlaceholder')}
            className="glass-input w-full rounded-xl px-4 py-3 text-sm text-white"
            maxLength={200}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-500 uppercase tracking-wide">{t('support.messageLabel')}</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('support.messagePlaceholderLong')}
            rows={5}
            className="glass-input w-full rounded-xl px-4 py-3 text-sm text-white resize-none"
          />
        </div>
        <button
          onClick={() => mutation.mutate()}
          disabled={!subject.trim() || !message.trim() || mutation.isPending}
          className="w-full rounded-full bg-(--brand-primary) py-3.5 text-sm font-semibold text-(--brand-primary-fg) disabled:opacity-50 active:scale-[0.98] transition-transform"
        >
          {mutation.isPending ? t('support.sending') : t('support.send')}
        </button>
      </div>
    </div>
  )
}

export default function SupportPage() {
  const [view, setView] = useState<'list' | 'chat' | 'create'>('list')
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ['tickets'],
    queryFn: getTickets,
    refetchInterval: 10000,
  })

  // Deep-link: the bot "Открыть обращение" notification button opens
  // `/support?ticket=<id>` (mini-app or web). Jump straight into that ticket so
  // the user sees the reply that prompted the notification, then strip the
  // param so a refresh / back doesn't re-trigger it.
  useEffect(() => {
    const ticketId = searchParams.get('ticket')
    if (!ticketId) return
    setSelectedTicketId(ticketId)
    setView('chat')
    searchParams.delete('ticket')
    setSearchParams(searchParams, { replace: true })
  }, [searchParams, setSearchParams])

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-(--brand-primary)" />
      </div>
    )
  }

  if (view === 'create') {
    return (
      <CreateTicketForm
        onBack={() => setView('list')}
        onCreated={(id) => { setSelectedTicketId(id); setView('chat') }}
      />
    )
  }

  if (view === 'chat' && selectedTicketId) {
    return (
      <TicketChat
        ticketId={selectedTicketId}
        onBack={() => { setSelectedTicketId(null); setView('list') }}
      />
    )
  }

  return (
    <TicketList
      tickets={tickets}
      onSelect={(id) => { setSelectedTicketId(id); setView('chat') }}
      onCreate={() => setView('create')}
    />
  )
}


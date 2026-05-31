import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import { ArrowLeft, Send, Plus, MessageSquare, Loader2 } from 'lucide-react'
import { getTickets, getTicket, createTicket, replyToTicket } from '@/lib/api-client'
import type { SupportTicket } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

function formatTime(dateStr: string) {
  const d = new Date(dateStr)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function TicketList({ tickets, onSelect, onCreate }: { tickets: SupportTicket[]; onSelect: (id: string) => void; onCreate: () => void }) {
  return (
    <div className="pb-8">
      <div className="flex items-center justify-between px-5 py-5">
        <h1 className="text-lg font-semibold">Поддержка</h1>
        <button
          onClick={onCreate}
          className="flex items-center gap-1.5 rounded-full bg-(--brand-primary) px-4 py-2 text-sm font-medium text-(--brand-primary-fg) active:scale-95 transition-transform"
        >
          <Plus className="h-4 w-4" />
          Новый тикет
        </button>
      </div>

      {tickets.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-5 py-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-800/50">
            <MessageSquare className="h-8 w-8 text-zinc-600" />
          </div>
          <p className="text-sm text-zinc-500">У вас нет обращений</p>
          <p className="text-xs text-zinc-600">Создайте тикет, если нужна помощь</p>
        </div>
      ) : (
        <div className="px-5 space-y-2">
          {tickets.map((t) => (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              className="w-full glass-card p-4 text-left active:scale-[0.98] transition-transform"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium text-sm truncate flex-1">{t.subject}</p>
                <span className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase',
                  t.status === 'open' ? 'bg-emerald-500/20 text-emerald-400' :
                  t.status === 'waiting_reply' ? 'bg-violet-500/20 text-violet-400' :
                  'bg-zinc-700 text-zinc-400'
                )}>
                  {t.status === 'open' ? 'Открыт' : t.status === 'waiting_reply' ? 'Ответ' : 'Закрыт'}
                </span>
              </div>
              {t.messages?.[0] && (
                <p className="text-xs text-zinc-500 mt-1.5 truncate">{t.messages[0].content}</p>
              )}
              <p className="text-[10px] text-zinc-600 mt-1">{formatTime(t.updatedAt)}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TicketChat({ ticketId, onBack }: { ticketId: string; onBack: () => void }) {
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
    onError: () => toast.error('Не удалось отправить'),
  })

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [ticket?.messages])

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
        <button onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{ticket.subject}</p>
          <p className="text-[10px] text-zinc-500 uppercase">
            {ticket.status === 'open' ? '🟢 Открыт' : ticket.status === 'waiting_reply' ? '💬 Ожидает ответа' : '⚫ Закрыт'}
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
                <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
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
              placeholder="Сообщение..."
              className="flex-1 rounded-full bg-zinc-800/80 px-4 py-3 text-sm text-white placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-(--brand-primary)/50"
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
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')

  const mutation = useMutation({
    mutationFn: () => createTicket(subject.trim(), message.trim()),
    onSuccess: (ticket) => {
      toast.success('Тикет создан')
      onCreated(ticket.id)
    },
    onError: () => toast.error('Не удалось создать тикет'),
  })

  return (
    <div className="pb-8">
      <div className="flex items-center gap-3 px-5 py-5">
        <button onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">Новое обращение</h1>
      </div>

      <div className="px-5 space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-500 uppercase tracking-wide">Тема</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="О чём пойдёт речь?"
            className="w-full rounded-xl bg-zinc-800/80 px-4 py-3 text-sm text-white placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-(--brand-primary)/50"
            maxLength={200}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-500 uppercase tracking-wide">Сообщение</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Опишите проблему..."
            rows={5}
            className="w-full rounded-xl bg-zinc-800/80 px-4 py-3 text-sm text-white placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-(--brand-primary)/50 resize-none"
          />
        </div>
        <button
          onClick={() => mutation.mutate()}
          disabled={!subject.trim() || !message.trim() || mutation.isPending}
          className="w-full rounded-full bg-(--brand-primary) py-3.5 text-sm font-semibold text-(--brand-primary-fg) disabled:opacity-50 active:scale-[0.98] transition-transform"
        >
          {mutation.isPending ? 'Отправка...' : 'Отправить'}
        </button>
      </div>
    </div>
  )
}

export default function SupportPage() {
  const [view, setView] = useState<'list' | 'chat' | 'create'>('list')
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ['tickets'],
    queryFn: getTickets,
    refetchInterval: 10000,
  })

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

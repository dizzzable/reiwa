import { useEffect, useRef, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Send, X, Copy, Check, Paperclip } from 'lucide-react'
import { toast } from 'sonner'

import {
  createGuestTicket,
  getGuestConversation,
  replyGuestConversation,
  closeGuestConversation,
  getGuestSupportConfig,
  supportGuestAttachmentUrl,
  type GuestTicket,
  type SupportAttachmentMeta,
} from '@/lib/api-client'

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string
          callback: (token: string) => void
          'error-callback'?: () => void
          'expired-callback'?: () => void
        },
      ) => string
      reset: (id?: string) => void
    }
  }
}

const QUERY_KEY = ['guest-support'] as const

function statusOf(err: unknown): number | null {
  const e = err as { response?: { status?: number } }
  return typeof e?.response?.status === 'number' ? e.response.status : null
}

export default function GuestSupportPage(): JSX.Element {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [resumeCode, setResumeCode] = useState<string | null>(null)
  const [closedLocally, setClosedLocally] = useState(false)

  // A resume token may arrive via an emailed link (`?resume=…`). Capture it
  // once, then strip it from the visible URL/history so the token doesn't
  // linger in the address bar. The first fetch relays it; the server then
  // sets the httpOnly cookie and subsequent polls use that.
  const [urlResume] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const code = new URLSearchParams(window.location.search).get('resume')
    if (code) window.history.replaceState({}, '', window.location.pathname)
    return code
  })

  const configQuery = useQuery({
    queryKey: ['guest-support-config'],
    queryFn: getGuestSupportConfig,
    staleTime: Infinity,
  })

  const conversationQuery = useQuery<GuestTicket | null>({
    queryKey: QUERY_KEY,
    queryFn: () =>
      getGuestConversation(urlResume ?? undefined).catch((err: unknown) => {
        if (statusOf(err) === 404) return null
        throw err
      }),
    refetchInterval: (q) => {
      const data = q.state.data
      return data && data.status !== 'closed' ? 5000 : false
    },
  })

  const ticket = conversationQuery.data ?? null

  function describeError(err: unknown): string {
    const status = statusOf(err)
    if (status === 429) return t('guestSupport.errors.rateLimited')
    if (status === 413) return t('guestSupport.errors.tooLong')
    if (status === 404) return t('guestSupport.errors.notFound')
    if (status === 400) {
      const code = (err as { response?: { data?: { error?: string } } }).response?.data?.error
      if (code === 'captcha_failed') return t('guestSupport.errors.captcha')
    }
    return t('guestSupport.errors.generic')
  }

  const createMutation = useMutation({
    mutationFn: createGuestTicket,
    onSuccess: (res) => {
      setResumeCode(res.resumeCode)
      setClosedLocally(false)
      qc.setQueryData(QUERY_KEY, res.ticket)
    },
    onError: (err) => toast.error(describeError(err)),
  })

  const replyMutation = useMutation({
    mutationFn: (content: string) => replyGuestConversation(content),
    onSuccess: (updated) => qc.setQueryData(QUERY_KEY, updated),
    onError: (err) => toast.error(describeError(err)),
  })

  const closeMutation = useMutation({
    mutationFn: () => closeGuestConversation(),
    onSuccess: () => {
      setClosedLocally(true)
      qc.setQueryData(QUERY_KEY, null)
    },
    onError: (err) => toast.error(describeError(err)),
  })

  return (
    <div className="min-h-dvh bg-(--brand-bg-primary) px-4 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-white">{t('guestSupport.title')}</h1>
          <p className="mt-1 text-sm text-white/60">{t('guestSupport.subtitle')}</p>
        </header>

        {conversationQuery.isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-(--brand-primary)" />
          </div>
        ) : ticket && ticket.status !== 'closed' ? (
          <ChatView
            ticket={ticket}
            onReply={(content) => replyMutation.mutate(content)}
            replying={replyMutation.isPending}
            onClose={() => closeMutation.mutate()}
            closing={closeMutation.isPending}
            resumeCode={resumeCode}
          />
        ) : configQuery.data && configQuery.data.enabled === false ? (
          <div className="space-y-2 rounded-2xl border border-white/10 bg-white/3 p-6 text-center">
            <div className="text-sm font-medium text-white">{t('guestSupport.disabled.title')}</div>
            <p className="text-xs text-white/60">{t('guestSupport.disabled.body')}</p>
          </div>
        ) : closedLocally ? (
          <ClosedNote onNew={() => setClosedLocally(false)} />
        ) : (
          <StartForm
            siteKey={configQuery.data?.turnstileSiteKey ?? null}
            submitting={createMutation.isPending}
            onSubmit={(input) => createMutation.mutate(input)}
            onRestore={() => void conversationQuery.refetch()}
          />
        )}
      </div>
    </div>
  )
}

// ── Start form ───────────────────────────────────────────────────────────────

function StartForm(props: {
  siteKey: string | null
  submitting: boolean
  onSubmit: (input: { subject: string; message: string; email?: string; captchaToken?: string }) => void
  onRestore: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [resume, setResume] = useState('')

  const canSubmit =
    subject.trim().length > 0 &&
    message.trim().length > 0 &&
    (props.siteKey === null || captchaToken !== null) &&
    !props.submitting

  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-white/3 p-5">
      <Field label={t('guestSupport.form.subject')}>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={200}
          placeholder={t('guestSupport.form.subjectPlaceholder')}
          className={INPUT_CLASS}
        />
      </Field>
      <Field label={t('guestSupport.form.message')}>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={10_000}
          rows={5}
          placeholder={t('guestSupport.form.messagePlaceholder')}
          className={`${INPUT_CLASS} resize-y`}
        />
      </Field>
      <Field label={t('guestSupport.form.email')} hint={t('guestSupport.form.emailHint')}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('guestSupport.form.emailPlaceholder')}
          className={INPUT_CLASS}
        />
      </Field>

      {props.siteKey !== null && <TurnstileWidget siteKey={props.siteKey} onToken={setCaptchaToken} />}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() =>
          props.onSubmit({
            subject: subject.trim(),
            message: message.trim(),
            email: email.trim() || undefined,
            captchaToken: captchaToken ?? undefined,
          })
        }
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-(--brand-primary) px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {props.submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {props.submitting ? t('guestSupport.form.sending') : t('guestSupport.form.submit')}
      </button>

      <div className="border-t border-white/10 pt-4">
        <label className="block text-xs text-white/60">{t('guestSupport.resume.restoreLabel')}</label>
        <div className="mt-2 flex gap-2">
          <input
            value={resume}
            onChange={(e) => setResume(e.target.value)}
            placeholder={t('guestSupport.resume.restorePlaceholder')}
            className={INPUT_CLASS}
          />
          <button
            type="button"
            disabled={resume.trim().length === 0}
            onClick={() => {
              // The resume code is the guest token; setting it as the cookie is
              // server-side, so we hand it to the query via a one-off fetch.
              void getGuestConversation(resume.trim())
                .then(() => props.onRestore())
                .catch(() => toast.error(t('guestSupport.errors.notFound')))
            }}
            className="shrink-0 rounded-xl border border-white/15 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {t('guestSupport.resume.restoreButton')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Chat view ────────────────────────────────────────────────────────────────

function ChatView(props: {
  ticket: GuestTicket
  resumeCode: string | null
  onReply: (content: string) => void
  replying: boolean
  onClose: () => void
  closing: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [props.ticket.messages])

  const statusLabel =
    props.ticket.status === 'waiting_reply'
      ? t('guestSupport.status.waiting_reply')
      : t('guestSupport.status.open')

  return (
    <div className="space-y-4">
      {props.resumeCode && <ResumeBanner code={props.resumeCode} />}

      <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/3 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-white">{props.ticket.subject}</div>
          <div className="text-xs text-white/50">{statusLabel}</div>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          disabled={props.closing}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          {t('guestSupport.chat.close')}
        </button>
      </div>

      <div
        ref={scrollRef}
        className="max-h-[50vh] space-y-3 overflow-y-auto rounded-xl border border-white/10 bg-white/2 p-4"
      >
        {props.ticket.messages.length === 0 ? (
          <p className="py-6 text-center text-sm text-white/50">{t('guestSupport.chat.empty')}</p>
        ) : (
          props.ticket.messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          maxLength={10_000}
          placeholder={t('guestSupport.chat.replyPlaceholder')}
          className={`${INPUT_CLASS} resize-none`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (text.trim()) {
                props.onReply(text.trim())
                setText('')
              }
            }
          }}
        />
        <button
          type="button"
          disabled={text.trim().length === 0 || props.replying}
          onClick={() => {
            props.onReply(text.trim())
            setText('')
          }}
          className="flex shrink-0 items-center justify-center rounded-xl bg-(--brand-primary) px-4 text-white disabled:opacity-50"
        >
          {props.replying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

function MessageBubble({
  message,
}: {
  message: GuestTicket['messages'][number]
}): JSX.Element {
  const { t } = useTranslation()
  const mine = message.authorType === 'user'
  const isSystem = message.authorType === 'system'
  const author = mine
    ? t('guestSupport.chat.you')
    : isSystem
      ? t('guestSupport.chat.system')
      : t('guestSupport.chat.operator')
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
          mine
            ? 'bg-(--brand-primary) text-white'
            : isSystem
              ? 'bg-amber-500/15 text-amber-100'
              : 'bg-white/10 text-white'
        }`}
      >
        <div className="mb-0.5 text-[10px] opacity-60">{author}</div>
        {message.content && (
          <div className="whitespace-pre-wrap wrap-break-word">{message.content}</div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className={message.content ? 'mt-1.5 space-y-1.5' : 'space-y-1.5'}>
            {message.attachments.map((attachment) => (
              <GuestAttachmentView key={attachment.id} attachment={attachment} mine={mine} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Renders one guest-message attachment: an inline image preview for image
 * types, or a download chip with filename + size otherwise. The binary streams
 * from the same-origin guest endpoint (httpOnly guest token sent automatically).
 */
function GuestAttachmentView({
  attachment,
  mine,
}: {
  attachment: SupportAttachmentMeta
  mine: boolean
}): JSX.Element {
  const url = supportGuestAttachmentUrl(attachment.id)
  if (attachment.mimeType.startsWith('image/')) {
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
      className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${
        mine ? 'bg-white/15 text-white' : 'bg-white/5 text-zinc-200'
      }`}
    >
      <Paperclip className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
      <span className="shrink-0 opacity-60">{formatGuestBytes(attachment.sizeBytes)}</span>
    </a>
  )
}

function formatGuestBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

// ── Resume code banner ─────────────────────────────────────────────────────────

function ResumeBanner({ code }: { code: string }): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-xl border border-(--brand-primary)/30 bg-(--brand-primary)/10 p-4">
      <div className="text-sm font-medium text-white">{t('guestSupport.resume.title')}</div>
      <p className="mt-1 text-xs text-white/70">{t('guestSupport.resume.body')}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 truncate rounded-lg bg-black/30 px-3 py-2 text-xs text-white">{code}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-white/15 px-3 py-2 text-xs text-white"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t('guestSupport.resume.copied') : t('guestSupport.resume.copy')}
        </button>
      </div>
    </div>
  )
}

// ── Closed note ──────────────────────────────────────────────────────────────

function ClosedNote({ onNew }: { onNew: () => void }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/3 p-6 text-center">
      <div className="text-sm font-medium text-white">{t('guestSupport.chat.closed')}</div>
      <p className="text-xs text-white/60">{t('guestSupport.chat.closedNote')}</p>
      <button
        type="button"
        onClick={onNew}
        className="rounded-xl bg-(--brand-primary) px-5 py-2.5 text-sm font-medium text-white"
      >
        {t('guestSupport.chat.newTicket')}
      </button>
    </div>
  )
}

// ── Turnstile widget ─────────────────────────────────────────────────────────

function TurnstileWidget({
  siteKey,
  onToken,
}: {
  siteKey: string
  onToken: (token: string | null) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderedRef = useRef(false)

  useEffect(() => {
    const SCRIPT_ID = 'cf-turnstile-script'
    function tryRender(): void {
      if (renderedRef.current || !containerRef.current || !window.turnstile) return
      renderedRef.current = true
      window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token) => onToken(token),
        'error-callback': () => onToken(null),
        'expired-callback': () => onToken(null),
      })
    }
    if (window.turnstile) {
      tryRender()
      return
    }
    let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null
    if (script === null) {
      script = document.createElement('script')
      script.id = SCRIPT_ID
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
      script.async = true
      document.head.appendChild(script)
    }
    const timer = window.setInterval(() => {
      if (window.turnstile) {
        window.clearInterval(timer)
        tryRender()
      }
    }, 200)
    return () => window.clearInterval(timer)
  }, [siteKey, onToken])

  return <div ref={containerRef} className="flex justify-center" />
}

// ── shared bits ──────────────────────────────────────────────────────────────

const INPUT_CLASS =
  'w-full rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-(--brand-primary) focus:outline-none'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: JSX.Element
}): JSX.Element {
  return (
    <div>
      <label className="mb-1 block text-xs text-white/70">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-white/40">{hint}</p>}
    </div>
  )
}

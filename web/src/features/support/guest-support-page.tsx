import { useEffect, useRef, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Send, X, Copy, Check, Paperclip, FileX } from 'lucide-react'
import { toast } from 'sonner'

import { useMediaViewer } from '@/features/media-viewer/use-media-viewer'
import {
  collectViewableAttachments,
  indexOfAttachment,
  type ViewableAttachment,
} from '@/features/media-viewer/support-attachments'

import {
  createGuestTicket,
  getGuestConversation,
  resumeGuestConversation,
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

  // A reply letter's «Открыть переписку» arrives as `?resume=…`. Captured
  // once and taken off the address bar — it is a credential for the thread —
  // then followed through `POST /support/guest/resume`, which decides what
  // this device keeps (see that route for its four answers). The link is a
  // way in, never the cookie itself: letters rotate their tokens.
  const [urlResume] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const code = new URLSearchParams(window.location.search).get('resume')
    if (code) window.history.replaceState({}, '', window.location.pathname)
    return code
  })
  // The visitor's "stay" to «Открыть другое обращение?» — for THAT question.
  const [stayed, setStayed] = useState(false)

  const followMutation = useMutation({
    mutationFn: (input: FollowInput) => resumeGuestConversation(input.token, input.confirm),
    // Every follow gets its own question. A "stay" that outlived its question
    // silenced the code field under the conversation — the very way back the
    // question names: the server asked, and the page showed nothing.
    onMutate: () => setStayed(false),
    onSuccess: (result, input) => {
      if (result.status === 'confirm') return
      if (result.status === 'stale' && input.from === 'code') {
        toast.error(t('guestSupport.errors.notFound'))
      }
      if (result.ticket) qc.setQueryData(QUERY_KEY, result.ticket)
      void qc.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
  const follow = followMutation.mutate
  useEffect(() => {
    if (urlResume !== null) follow({ token: urlResume, confirm: false, from: 'link' })
  }, [follow, urlResume])
  // Until the link has been answered for, the page shows neither the device's
  // own thread nor the start form: either could be the wrong one.
  const openingLink = followMutation.isPending || (urlResume !== null && followMutation.isIdle)

  const configQuery = useQuery({
    queryKey: ['guest-support-config'],
    queryFn: getGuestSupportConfig,
    staleTime: Infinity,
  })

  // Every poll rides on the device cookie alone.
  const conversationQuery = useQuery<GuestTicket | null>({
    queryKey: QUERY_KEY,
    queryFn: () =>
      getGuestConversation().catch((err: unknown) => {
        if (statusOf(err) === 404) return null
        throw err
      }),
    enabled: !openingLink,
    refetchInterval: (q) => {
      const data = q.state.data
      return data && data.status !== 'closed' ? 5000 : false
    },
  })

  const linkInput = followMutation.variables
  const linkResult = followMutation.data
  const confirming =
    linkResult?.status === 'confirm' && linkInput !== undefined && !stayed ? linkResult : null
  const staleLink = linkResult?.status === 'stale' && linkInput?.from === 'link' ? linkResult : null
  const linkFailed = followMutation.isError && linkInput !== undefined ? linkInput : null

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
    // Outside `StealthLayout`, so this page has to be its own scroller —
    // same reason as `/legal`, see the note there. `#root` clips at 100dvh,
    // and `min-h-dvh` only grew the box past the cut instead of letting
    // anyone reach it: the submit button under the captcha, and the foot of
    // an open ticket thread, were both below the fold with no way down.
    <div className="scroll-area h-dvh bg-(--brand-bg-primary) px-4 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-foreground">{t('guestSupport.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('guestSupport.subtitle')}</p>
        </header>

        {linkFailed !== null && (
          <div role="alert" className="glass-card mb-4 flex items-center justify-between gap-3 p-4 text-sm">
            <span className="text-foreground">
              {linkFailed.from === 'code' ? t('guestSupport.link.failedCode') : t('guestSupport.link.failed')}
            </span>
            <button
              type="button"
              onClick={() => follow(linkFailed)}
              className="shrink-0 rounded-xl border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              {t('guestSupport.link.retry')}
            </button>
          </div>
        )}
        {staleLink !== null && (
          <p role="status" className="glass-card mb-4 p-4 text-sm text-foreground">
            {staleLink.ticket ? t('guestSupport.link.staleContinue') : t('guestSupport.link.staleNone')}
          </p>
        )}

        {openingLink ? (
          <div className="flex h-48 flex-col items-center justify-center gap-3">
            <Loader2 className="h-7 w-7 animate-spin text-(--brand-primary)" />
            <span className="text-sm text-muted-foreground">{t('guestSupport.link.opening')}</span>
          </div>
        ) : confirming !== null && linkInput !== undefined ? (
          <div className="glass-card space-y-3 p-6">
            <div className="text-sm font-medium text-foreground">{t('guestSupport.link.confirmTitle')}</div>
            <p className="text-sm text-muted-foreground">
              {t('guestSupport.link.confirmBody', {
                current: confirming.current.subject,
                opening: confirming.opening.subject,
              })}
            </p>
            {/* This question is what stands between a crafted link and the
                visitor's own thread, so it names only ways back that exist:
                the code field under every open conversation, and a letter
                about it — which not every guest gets. */}
            <p className="text-sm text-muted-foreground">
              {t('guestSupport.link.confirmWayBack', { current: confirming.current.subject })}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => follow({ ...linkInput, confirm: true })}
                className="rounded-xl bg-(--brand-primary) px-4 py-2 text-sm font-medium text-(--brand-primary-fg)"
              >
                {t('guestSupport.link.confirmOpen')}
              </button>
              <button
                type="button"
                onClick={() => setStayed(true)}
                className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-accent"
              >
                {t('guestSupport.link.confirmStay')}
              </button>
            </div>
          </div>
        ) : conversationQuery.isLoading ? (
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
            onRestore={(code) => follow({ token: code, confirm: false, from: 'code' })}
          />
        ) : configQuery.data && configQuery.data.enabled === false ? (
          <div className="glass-card space-y-2 p-6 text-center">
            <div className="text-sm font-medium text-foreground">{t('guestSupport.disabled.title')}</div>
            <p className="text-xs text-muted-foreground">{t('guestSupport.disabled.body')}</p>
          </div>
        ) : closedLocally ? (
          <ClosedNote onNew={() => setClosedLocally(false)} />
        ) : (
          <StartForm
            siteKey={configQuery.data?.turnstileSiteKey ?? null}
            submitting={createMutation.isPending}
            onSubmit={(input) => createMutation.mutate(input)}
            onRestore={(code) => follow({ token: code, confirm: false, from: 'code' })}
          />
        )}
      </div>
    </div>
  )
}

/** A way in to follow: the letter's link, or a code typed into «Есть код возврата?». */
interface FollowInput {
  readonly token: string
  readonly confirm: boolean
  readonly from: 'link' | 'code'
}

// ── Start form ───────────────────────────────────────────────────────────────

function StartForm(props: {
  siteKey: string | null
  submitting: boolean
  onSubmit: (input: { subject: string; message: string; email?: string; captchaToken?: string }) => void
  onRestore: (code: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)

  const canSubmit =
    subject.trim().length > 0 &&
    message.trim().length > 0 &&
    (props.siteKey === null || captchaToken !== null) &&
    !props.submitting

  return (
    <div className="glass-card space-y-4 p-5">
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
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-(--brand-primary) px-5 py-2.5 text-sm font-medium text-(--brand-primary-fg) disabled:opacity-50"
      >
        {props.submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {props.submitting ? t('guestSupport.form.sending') : t('guestSupport.form.submit')}
      </button>

      <div className="border-t border-border pt-4">
        <label className="block text-xs text-muted-foreground">{t('guestSupport.resume.restoreLabel')}</label>
        <RestoreByCode onRestore={props.onRestore} />
      </div>
    </div>
  )
}

/**
 * The code field of «Есть код возврата?». Followed like a letter's link: the
 * server decides what the device keeps and writes the cookie; an unknown code
 * says «не найдено», and a code for another conversation than the one open
 * here asks first («Открыть другое обращение?»).
 */
function RestoreByCode({ onRestore }: { onRestore: (code: string) => void }): JSX.Element {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  return (
    <div className="mt-2 flex gap-2">
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={t('guestSupport.resume.restorePlaceholder')}
        aria-label={t('guestSupport.resume.restoreLabel')}
        className={INPUT_CLASS}
      />
      <button
        type="button"
        disabled={code.trim().length === 0}
        onClick={() => onRestore(code.trim())}
        className="shrink-0 rounded-xl border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50"
      >
        {t('guestSupport.resume.restoreButton')}
      </button>
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
  /** A code typed under the conversation: the way back «Открыть другое обращение?» names. */
  onRestore: (code: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Thread-wide, so paging reaches a screenshot from a later reply.
  const viewable = collectViewableAttachments(props.ticket.messages, (att) =>
    supportGuestAttachmentUrl(att.id),
  )
  const viewer = useMediaViewer(viewable)

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

      <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{props.ticket.subject}</div>
          <div className="text-xs text-muted-foreground">{statusLabel}</div>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          disabled={props.closing}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          {t('guestSupport.chat.close')}
        </button>
      </div>

      <div
        ref={scrollRef}
        className="max-h-[50vh] space-y-3 overflow-y-auto rounded-xl border border-border bg-card p-4"
      >
        {props.ticket.messages.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('guestSupport.chat.empty')}</p>
        ) : (
          props.ticket.messages.map((m) => (
            <MessageBubble key={m.id} message={m} viewable={viewable} onOpen={viewer.open} />
          ))
        )}
      </div>
      {viewer.element}

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
          className="flex shrink-0 items-center justify-center rounded-xl bg-(--brand-primary) px-4 text-(--brand-primary-fg) disabled:opacity-50"
        >
          {props.replying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>

      {/* The start form's code field lived only on that form, which a device
          holding an open conversation never shows — so after «Открыть другое
          обращение» the previous one could not be got back by its code.
          Folded away: it is for coming back, not for the conversation here. */}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">{t('guestSupport.resume.restoreLabel')}</summary>
        <RestoreByCode onRestore={props.onRestore} />
      </details>
    </div>
  )
}

function MessageBubble({
  message,
  viewable,
  onOpen,
}: {
  message: GuestTicket['messages'][number]
  viewable: readonly ViewableAttachment[]
  onOpen: (index: number) => void
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
            ? 'bg-(--brand-primary) text-(--brand-primary-fg)'
            : isSystem
              ? 'bg-amber-500/15 text-amber-100'
              : 'bg-[color:var(--color-surface-high)] text-foreground'
        }`}
      >
        <div className="mb-0.5 text-[10px] opacity-60">{author}</div>
        {message.content && (
          <div className="whitespace-pre-wrap wrap-break-word">{message.content}</div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className={message.content ? 'mt-1.5 space-y-1.5' : 'space-y-1.5'}>
            {message.attachments.map((attachment) => {
              const at = indexOfAttachment(viewable, attachment.id)
              return (
                <GuestAttachmentView
                  key={attachment.id}
                  attachment={attachment}
                  mine={mine}
                  onOpen={at >= 0 ? () => onOpen(at) : null}
                />
              )
            })}
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
  onOpen,
}: {
  attachment: SupportAttachmentMeta
  mine: boolean
  onOpen: (() => void) | null
}): JSX.Element {
  const { t } = useTranslation()
  const url = supportGuestAttachmentUrl(attachment.id)

  // A purge is scoped to a ticket id and does not care whether the thread is
  // a guest one — anonymous threads are in fact where files pile up, since
  // that upload has existed the longest. Without this branch the operator's
  // cleanup leaves the guest looking at a broken image box with no
  // explanation, and the same page after upgrading, not just an old one.
  if (attachment.purgedAt) {
    return (
      <div
        className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${
          mine
            ? 'bg-black/15 text-inherit opacity-70'
            : 'bg-[color:var(--color-surface)] text-foreground opacity-70'
        }`}
      >
        <FileX className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
        <span className="shrink-0 opacity-70">{t('support.attachmentRemoved')}</span>
      </div>
    )
  }

  if (onOpen) {
    return (
      // `h-64` on the button — see the signed-in page for why the strip
      // reserves its height instead of growing into it when the bytes land.
      <button type="button" onClick={onOpen} className="block h-64 overflow-hidden rounded-xl">
        <img
          src={url}
          alt={attachment.filename}
          loading="lazy"
          // `contain`, not `cover` — see the signed-in page for why cropping a
          // screenshot preview is the wrong default in a support thread.
          className="h-full w-auto max-w-full cursor-zoom-in rounded-xl object-contain"
        />
      </button>
    )
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${
        mine ? 'bg-black/15 text-inherit' : 'bg-[color:var(--color-surface)] text-foreground'
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
      <div className="text-sm font-medium text-foreground">{t('guestSupport.resume.title')}</div>
      <p className="mt-1 text-xs text-muted-foreground">{t('guestSupport.resume.body')}</p>
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
          className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs text-foreground transition-colors hover:bg-accent"
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
    <div className="glass-card space-y-3 p-6 text-center">
      <div className="text-sm font-medium text-foreground">{t('guestSupport.chat.closed')}</div>
      <p className="text-xs text-muted-foreground">{t('guestSupport.chat.closedNote')}</p>
      <button
        type="button"
        onClick={onNew}
        className="rounded-xl bg-(--brand-primary) px-5 py-2.5 text-sm font-medium text-(--brand-primary-fg)"
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
      // Turnstile supports anonymous CORS; retain actionable diagnostics if
      // its third-party script fails inside an embedded browser.
      script.crossOrigin = 'anonymous'
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
  'glass-input w-full rounded-xl px-3 py-2 text-sm text-foreground focus:border-(--brand-primary) focus:outline-none'

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
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground opacity-70">{hint}</p>}
    </div>
  )
}

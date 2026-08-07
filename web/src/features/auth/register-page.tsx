import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { UserPlus, Eye, EyeOff, Loader2, Mail } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NetworkBg } from '@/components/ui/network-bg'
import { SESSION_QUERY_KEY } from '@/hooks/use-session'
import { registerUser, checkUsername, login } from '@/lib/api-client'
import { useAccessMode } from '@/lib/use-access-mode'
import { useLegalDocuments } from '@/lib/use-legal-documents'
import { LegalDocumentDialog } from '@/components/legal-document-dialog'
import type { LegalDocument } from '@/lib/api-client'
import { ExternalAuthButtons } from './external-auth-buttons'
import { GuestSupportLink } from '@/features/support/guest-support-link'
import { AccessModeBanner } from '@/components/access-mode-banner'

// ── Validation ────────────────────────────────────────────────────────────────

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,32}$/

function validateUsername(value: string): string | null {
  if (!value) return 'required'
  if (value.length < 3) return 'tooShort'
  if (value.length > 32) return 'tooLong'
  if (!USERNAME_REGEX.test(value)) return 'invalidChars'
  return null
}

function validatePassword(value: string): string | null {
  if (!value) return 'required'
  if (value.length < 8) return 'tooShort'
  if (value.length > 128) return 'tooLong'
  return null
}

// ── SHA-256 Hashing ───────────────────────────────────────────────────────────

async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(message)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RegisterPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const { registrationBlocked, restricted, inviteOnly, isLoading: accessModeLoading } = useAccessMode()

  // Form state
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  // Validation state
  const [usernameError, setUsernameError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  // INVITED mode: when the user did not arrive via an invite link they must
  // paste an invite code before the form is revealed.
  const [manualInviteCode, setManualInviteCode] = useState('')
  const [inviteAccepted, setInviteAccepted] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  // Referral code captured from the invite link (`/register?ref=<code>`).
  // Read once on mount so it survives input changes; passed to registration so
  // the new user is attributed to the inviter.
  const referralCodeRef = useRef<string | null>(null)
  // Classic UTM from the register landing URL — write-once registration snapshot.
  const utmRef = useRef<{
    source?: string
    medium?: string
    campaign?: string
    content?: string
    term?: string
    raw?: string
  } | null>(null)
  if (referralCodeRef.current === null) {
    try {
      const params = new URLSearchParams(window.location.search)
      const ref = params.get('ref')
      referralCodeRef.current = ref && ref.trim().length > 0 ? ref.trim().slice(0, 64) : ''
      const pick = (k: string) => {
        const v = params.get(k)
        return v && v.trim() ? v.trim().slice(0, 128) : undefined
      }
      const utm = {
        source: pick('utm_source'),
        medium: pick('utm_medium'),
        campaign: pick('utm_campaign'),
        content: pick('utm_content'),
        term: pick('utm_term'),
        raw: window.location.search ? window.location.search.slice(0, 512) : undefined,
      }
      utmRef.current =
        utm.source || utm.medium || utm.campaign || utm.content || utm.term ? utm : null
    } catch {
      referralCodeRef.current = ''
      utmRef.current = null
    }
  }

  // Username availability state
  const [usernameUnavailable, setUsernameUnavailable] = useState(false)
  const [checkingUsername, setCheckingUsername] = useState(false)
  // Track usernames that were ever reported as unavailable during this session
  const unavailableUsernamesRef = useRef<Set<string>>(new Set())

  // Registration availability is driven by the platform access mode
  // (`useAccessMode`) — the single source of truth. The server still enforces
  // the gate on submit via `requireMode('register')`, so the client only needs
  // the access-mode branches below (blocked banner / invite gate / form).

  // Submission state
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  // Legal consent. `failed` is NOT the same as "no documents": an outage
  // leaves the list empty, and treating that as "nothing to accept" would let
  // the form submit a registration the panel then refuses for missing consent
  // — a rejection with no visible cause. So a failure blocks the button and
  // says why, rather than quietly dropping the requirement.
  const legalDocuments = useLegalDocuments()
  const [acceptedDocuments, setAcceptedDocuments] = useState<Array<LegalDocument['key']>>([])
  const [openDocument, setOpenDocument] = useState<LegalDocument | null>(null)
  const allDocumentsAccepted =
    !legalDocuments.failed &&
    !legalDocuments.isLoading &&
    legalDocuments.documents.every((document) => acceptedDocuments.includes(document.key))

  // Debounce timer for username check
  const usernameCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Check registration toggle status ──────────────────────────────────────

  // ── Username availability check ───────────────────────────────────────────

  const checkUsernameAvailability = useCallback(async (name: string) => {
    // Only check if username passes format validation
    if (validateUsername(name) !== null) return

    // If this username was ever reported unavailable, keep it marked
    if (unavailableUsernamesRef.current.has(name)) {
      setUsernameUnavailable(true)
      return
    }

    setCheckingUsername(true)
    try {
      const response = await checkUsername(name)
      if (response.available) {
        setUsernameUnavailable(false)
      } else {
        setUsernameUnavailable(true)
        unavailableUsernamesRef.current.add(name)
      }
    } catch {
      // Probe failed — don't block the user; the real submit is the
      // source of truth and will surface a 409 if the name is taken.
      setUsernameUnavailable(false)
    } finally {
      setCheckingUsername(false)
    }
  }, [])

  useEffect(() => {
    if (usernameCheckTimerRef.current) {
      clearTimeout(usernameCheckTimerRef.current)
    }

    if (!username || validateUsername(username) !== null) {
      setUsernameUnavailable(false)
      setCheckingUsername(false)
      return
    }

    // Check if already known unavailable
    if (unavailableUsernamesRef.current.has(username)) {
      setUsernameUnavailable(true)
      return
    }

    // Debounce the availability check
    usernameCheckTimerRef.current = setTimeout(() => {
      void checkUsernameAvailability(username)
    }, 500)

    return () => {
      if (usernameCheckTimerRef.current) {
        clearTimeout(usernameCheckTimerRef.current)
      }
    }
  }, [username, checkUsernameAvailability])

  // ── Form handlers ─────────────────────────────────────────────────────────

  function handleUsernameChange(value: string) {
    setUsername(value)
    setServerError(null)
    const error = validateUsername(value)
    setUsernameError(value ? error : null)
  }

  function handlePasswordChange(value: string) {
    setPassword(value)
    setServerError(null)
    const error = validatePassword(value)
    setPasswordError(value ? error : null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    // Validate all fields
    const uError = validateUsername(username)
    const pError = validatePassword(password)
    setUsernameError(uError)
    setPasswordError(pError)

    if (uError || pError) return

    // Block if username was ever reported as unavailable
    if (unavailableUsernamesRef.current.has(username)) {
      setUsernameUnavailable(true)
      return
    }

    setSubmitting(true)
    setServerError(null)

    try {
      // SHA-256 hash the password before sending
      const passwordHash = await sha256(password)

      // Submit registration
      const effectiveReferral =
        (referralCodeRef.current || manualInviteCode.trim()) || undefined
      const result = await registerUser(
        username,
        passwordHash,
        false,
        effectiveReferral,
        utmRef.current ?? undefined,
        acceptedDocuments,
      )

      // Registration succeeded — backend confirmed both Web_Account and User creation
      // Now attempt automatic sign-in
      try {
        const loginResult = await login({ username, passwordHash })
        // Sign-in succeeded — update session and redirect
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
        navigate(loginResult.redirectUrl || '/dashboard', { replace: true })
      } catch {
        // Auto sign-in failed after successful registration
        // Still display success and redirect since registration itself succeeded
        navigate('/dashboard', { replace: true })
      }
    } catch (err: unknown) {
      // Registration failed — prevent redirection, show error, remain on form
      setSubmitting(false)

      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { status?: number; data?: { code?: string; message?: string; retryAfter?: number } } }
        const status = axiosErr.response?.status
        const code = axiosErr.response?.data?.code

        if (status === 409 || code === 'USERNAME_TAKEN') {
          setUsernameUnavailable(true)
          unavailableUsernamesRef.current.add(username)
          setServerError(t('register.errorUsernameTaken'))
        } else if (code === 'LEGAL_CONSENT_REQUIRED') {
          // The operator switched a document on while this form was open. The
          // hook does not poll, so the checkbox for it was never rendered and
          // the visitor could not have ticked it. Refetch so it appears, and
          // say what to do — "registration is disabled" would be a lie here.
          void queryClient.invalidateQueries({ queryKey: ['legal-documents'] })
          setServerError(t('register.legal.required'))
        } else if (status === 403) {
          setServerError(t('register.errorDisabled'))
        } else if (status === 429) {
          const retryAfter = axiosErr.response?.data?.retryAfter
          const seconds = typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter : 60
          setServerError(t('register.errorRateLimit', { seconds }))
        } else if (status === 502 || status === 503) {
          setServerError(t('register.errorServiceUnavailable'))
        } else {
          setServerError(axiosErr.response?.data?.message || t('common.errorGeneric'))
        }
      } else {
        setServerError(t('common.errorGeneric'))
      }
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // INVITED: a referral link (`?ref=`) satisfies the gate; otherwise the user
  // must paste a code first. REG_BLOCKED / RESTRICTED block registration
  // entirely regardless of the legacy global toggle.
  const hasInviteLink = !!referralCodeRef.current
  const blockedByMode = registrationBlocked || restricted
  const needsInviteCode = inviteOnly && !hasInviteLink && !inviteAccepted

  function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!manualInviteCode.trim()) {
      setInviteError(t('accessMode.invite.codeRequired'))
      return
    }
    setInviteError(null)
    setInviteAccepted(true)
  }

  // Loading state
  if (accessModeLoading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-(--brand-bg-primary)">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-(--brand-bg-primary) overflow-hidden px-4">
      <NetworkBg intensity="low" />

      <div className="relative z-10 w-full max-w-sm">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center mb-8"
        >
          <div
            className="flex h-16 w-16 items-center justify-center rounded-2xl mb-4"
            style={{
              background: 'radial-gradient(circle, rgba(244,63,94,0.2) 0%, transparent 70%)',
              boxShadow: '0 0 40px rgba(244,63,94,0.3)',
            }}
          >
            <UserPlus className="h-8 w-8 text-(--brand-primary)" />
          </div>
          <h1 className="text-2xl font-bold text-[color:var(--brand-foreground)]">{t('register.title')}</h1>
          <p className="mt-1 text-sm text-[color:var(--brand-muted-foreground)]">{t('register.subtitle')}</p>
        </motion.div>

        {/* Mode-aware body: blocked banner / invite gate / registration form */}
        {blockedByMode ? (
          <AccessModeBanner modes={['REG_BLOCKED', 'RESTRICTED']} />
        ) : needsInviteCode ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            <AccessModeBanner modes={['INVITED']} />
            <form onSubmit={handleInviteSubmit} className="space-y-3" noValidate>
              <div>
                <label
                  htmlFor="invite-code"
                  className="mb-1.5 block text-xs font-medium text-[color:var(--brand-muted-foreground)]"
                >
                  {t('accessMode.invite.codeLabel')}
                </label>
                <input
                  id="invite-code"
                  type="text"
                  value={manualInviteCode}
                  onChange={(e) => {
                    setManualInviteCode(e.target.value)
                    setInviteError(null)
                  }}
                  placeholder={t('accessMode.invite.codePlaceholder')}
                  className={`glass-input w-full rounded-xl px-4 py-3 text-sm ${
                    inviteError
                      ? 'border-red-500/50 focus:border-red-500'
                      : 'border-[color:var(--color-border-soft)] focus:border-(--brand-primary)/50'
                  }`}
                  aria-invalid={!!inviteError}
                  aria-describedby="invite-error"
                />
                <div id="invite-error" className="mt-1 min-h-[1.25rem]" aria-live="polite">
                  {inviteError && <span className="text-xs text-red-400">{inviteError}</span>}
                </div>
              </div>
              <button
                type="submit"
                disabled={!manualInviteCode.trim()}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-(--brand-primary) py-3.5 text-sm font-semibold text-(--brand-primary-fg) transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
              >
                <Mail className="h-4 w-4" />
                {t('common.confirm')}
              </button>
            </form>
          </motion.div>
        ) : (
          <motion.form
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            onSubmit={handleSubmit}
            className="space-y-4"
            noValidate
          >
            {/* INVITED with a satisfied gate — remind which code is in use. */}
            {inviteOnly && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200/90">
                {t('accessMode.banner.INVITED.body')}
              </div>
            )}
            {/* Username field */}
            <div>
              <label htmlFor="register-username" className="mb-1.5 block text-xs font-medium text-[color:var(--brand-muted-foreground)]">
                {t('register.usernameLabel')}
              </label>
              <input
                id="register-username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => handleUsernameChange(e.target.value)}
                placeholder={t('register.usernamePlaceholder')}
                disabled={submitting}
                className={`glass-input w-full rounded-xl px-4 py-3 text-sm ${
                  usernameError || usernameUnavailable
                    ? 'border-red-500/50 focus:border-red-500'
                    : 'border-[color:var(--color-border-soft)] focus:border-(--brand-primary)/50'
                }`}
                aria-invalid={!!(usernameError || usernameUnavailable)}
                aria-describedby="username-error"
              />
              <div id="username-error" className="mt-1 min-h-[1.25rem]" aria-live="polite">
                {checkingUsername && (
                  <span className="text-xs text-[color:var(--brand-muted-foreground)]">{t('register.checkingUsername')}</span>
                )}
                {!checkingUsername && usernameUnavailable && (
                  <span className="text-xs text-red-400">{t('register.errorUsernameTaken')}</span>
                )}
                {!checkingUsername && !usernameUnavailable && usernameError && (
                  <span className="text-xs text-red-400">
                    {t(`register.usernameError.${usernameError}`)}
                  </span>
                )}
              </div>
            </div>

            {/* Password field */}
            <div>
              <label htmlFor="register-password" className="mb-1.5 block text-xs font-medium text-[color:var(--brand-muted-foreground)]">
                {t('register.passwordLabel')}
              </label>
              <div className="relative">
                <input
                  id="register-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => handlePasswordChange(e.target.value)}
                  placeholder={t('register.passwordPlaceholder')}
                  disabled={submitting}
                  className={`glass-input w-full rounded-xl px-4 py-3 pr-12 text-sm ${
                    passwordError
                      ? 'border-red-500/50 focus:border-red-500'
                      : 'border-[color:var(--color-border-soft)] focus:border-(--brand-primary)/50'
                  }`}
                  aria-invalid={!!passwordError}
                  aria-describedby="password-error"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--brand-muted-foreground)] transition-colors hover:text-[color:var(--brand-foreground)]"
                  aria-label={showPassword ? t('register.hidePassword') : t('register.showPassword')}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <div id="password-error" className="mt-1 min-h-[1.25rem]" aria-live="polite">
                {passwordError && (
                  <span className="text-xs text-red-400">
                    {t(`register.passwordError.${passwordError}`)}
                  </span>
                )}
              </div>
            </div>


            {/* Legal consent.
                Rendered only for documents the operator switched on, and the
                submit button below stays disabled until every one is ticked.
                The panel repeats this check — the form can be bypassed by
                posting to the endpoint directly — so this is the courteous
                layer, not the enforcing one. */}
            {legalDocuments.failed ? (
              <div
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-400"
                role="alert"
              >
                <p>{t('register.legal.unavailable')}</p>
                <button
                  type="button"
                  className="mt-2 underline underline-offset-2"
                  onClick={() => legalDocuments.retry()}
                >
                  {t('register.legal.retry')}
                </button>
              </div>
            ) : (
              legalDocuments.documents.length > 0 && (
                <div className="space-y-2">
                  {legalDocuments.documents.map((document) => (
                    <label
                      key={document.key}
                      className="flex cursor-pointer items-start gap-2.5 text-xs text-(--tg-hint)"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0 accent-(--brand-primary)"
                        checked={acceptedDocuments.includes(document.key)}
                        onChange={(event) =>
                          setAcceptedDocuments((prev) =>
                            event.target.checked
                              ? [...prev, document.key]
                              : prev.filter((key) => key !== document.key),
                          )
                        }
                      />
                      <span>
                        {t('register.legal.accept')}{' '}
                        <button
                          type="button"
                          className="underline underline-offset-2 hover:text-(--brand-primary)"
                          onClick={() => setOpenDocument(document)}
                        >
                          {document.title}
                        </button>
                      </span>
                    </label>
                  ))}
                </div>
              )
            )}

            {/* Server error */}
            {serverError && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400"
                role="alert"
              >
                {serverError}
              </motion.div>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={
                submitting ||
                !!usernameError ||
                !!passwordError ||
                usernameUnavailable ||
                !username ||
                !password ||
                !allDocumentsAccepted
              }
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-(--brand-primary) py-3.5 text-sm font-semibold text-(--brand-primary-fg) transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('register.submitting')}
                </>
              ) : (
                t('register.submit')
              )}
            </button>
          </motion.form>
        )}

        {/* Reader for the document behind a consent checkbox. Mounted outside the
            form so opening it never submits anything. */}
        <LegalDocumentDialog document={openDocument} onClose={() => setOpenDocument(null)} />

        {/* External sign-in / registration (renders nothing when disabled) */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.15 }}
          className="mt-6 w-full"
        >
          <ExternalAuthButtons />
        </motion.div>

        {/* Sign-in link — always visible */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mt-6 text-center"
        >
          <p className="text-sm text-[color:var(--brand-muted-foreground)]">
            {t('register.hasAccount')}{' '}
            <Link to="/login" className="text-(--brand-primary) hover:text-(--brand-primary) transition-colors">
              {t('register.signIn')}
            </Link>
          </p>
          <div className="mt-4 flex justify-center">
            <GuestSupportLink />
          </div>
        </motion.div>
      </div>
    </div>
  )
}

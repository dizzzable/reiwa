import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Copy, Eye, EyeOff, KeyRound, Mail, Send, Share2 } from 'lucide-react'

import { NetworkBg } from '@/components/ui/network-bg'
import { StadiumButton } from '@/components/ui/stadium-button'
import { detectCurrentPlatform } from '@/features/connect/platform-detect'
import { useSession } from '@/hooks/use-session'
import { useBranding } from '@/lib/branding-provider'
import { sanitizeNextDestination } from '@/lib/next-destination'

/**
 * What the customer just typed. Lives in the calling page's memory for as long
 * as this screen is up — never in storage, the address, a log line or the
 * query cache — and is gone when they press «Продолжить».
 */
export interface SavedCredentials {
  readonly login: string
  readonly password: string
}

/** `PasswordCredential` is Chromium-only and absent from the DOM typings. */
type PasswordCredentialConstructor = new (data: {
  readonly id: string
  readonly password: string
  readonly name?: string
}) => Credential

export function passwordCredentialConstructor(): PasswordCredentialConstructor | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as Window & { PasswordCredential?: unknown }).PasswordCredential
  if (typeof candidate !== 'function') return null
  if (typeof navigator === 'undefined' || typeof navigator.credentials?.store !== 'function') return null
  return candidate as PasswordCredentialConstructor
}

/**
 * Copy text and say honestly whether it worked. The async Clipboard API first;
 * where it is missing or refused (some in-app browsers, an unfocused document)
 * the selection-based fallback, whose own answer is trusted as well.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the selection-based copy
  }
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string }

/**
 * The privacy page's linking form, still carrying where the customer was
 * going: the flows that show this screen are often a gate in front of a deep
 * link (`/renew` from an expiry notice), and a detour to link Telegram must not
 * lose it. The privacy page offers «Продолжить» there when `next` is present.
 */
export function privacyLinkPath(kind: 'telegram' | 'email', continueTo: string): string {
  const params = new URLSearchParams({ link: kind })
  const next = sanitizeNextDestination(continueTo)
  if (next !== null) params.set('next', next)
  return `/settings/privacy?${params.toString()}`
}

/**
 * «Сохраните данные для входа» — shown right after the customer set a password
 * (registration, the Telegram-first claim, finishing a social sign-up, a reset,
 * a forced change), before anything else. A password nobody wrote down is the
 * main reason people end up on the recovery screen, and linking Telegram or an
 * e-mail is the only thing that makes that screen able to help them.
 *
 * `continueTo` is where the customer was going: «Продолжить» goes there, and
 * the linking buttons carry it along.
 */
export function SaveCredentialsScreen({
  login,
  password,
  continueTo,
}: SavedCredentials & { readonly continueTo: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { session, isLoading: sessionLoading } = useSession()
  const { emailEnabled } = useBranding()
  const [shown, setShown] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const platform = useMemo(() => detectCurrentPlatform(), [])
  const credentialConstructor = useMemo(() => passwordCredentialConstructor(), [])

  const address = typeof window === 'undefined' ? '' : window.location.origin
  const text = t('auth.saveCredentials.shareText', { login, password, address })
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const hint =
    platform === 'ios'
      ? t('auth.saveCredentials.hintIos')
      : platform === 'android'
        ? t('auth.saveCredentials.hintAndroid')
        : t('auth.saveCredentials.hintDesktop')

  const offerTelegram = !sessionLoading && !session?.telegramId
  const offerEmail = !sessionLoading && emailEnabled && !session?.webAccount?.emailVerifiedAt
  const recoveryBody =
    offerTelegram && offerEmail
      ? t('auth.saveCredentials.recoveryBody')
      : offerTelegram
        ? t('auth.saveCredentials.recoveryBodyTelegram')
        : t('auth.saveCredentials.recoveryBodyEmail')

  async function handleCopy() {
    const copied = await copyText(text)
    setNotice(
      copied
        ? { kind: 'ok', text: t('auth.saveCredentials.copied') }
        : { kind: 'error', text: t('auth.saveCredentials.copyFailed') },
    )
  }

  async function handleShare() {
    try {
      await navigator.share({ title: t('auth.saveCredentials.shareTitle'), text })
      setNotice(null)
    } catch (err: unknown) {
      // Closing the share sheet is a choice, not a failure.
      if (err instanceof DOMException && err.name === 'AbortError') return
      setNotice({ kind: 'error', text: t('auth.saveCredentials.shareFailed') })
    }
  }

  async function handleSaveInBrowser() {
    if (credentialConstructor === null) return
    try {
      await navigator.credentials.store(new credentialConstructor({ id: login, password, name: login }))
      setNotice({ kind: 'ok', text: t('auth.saveCredentials.savedInBrowser') })
    } catch {
      setNotice({ kind: 'error', text: t('auth.saveCredentials.saveInBrowserFailed') })
    }
  }

  return (
    <div className="scroll-area entry-scroller relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-4">
      <NetworkBg intensity="low" />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="relative z-10 mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-5 py-8"
        data-testid="save-credentials"
      >
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-(--brand-primary)/10">
            <KeyRound className="h-7 w-7 text-(--brand-primary)" />
          </div>
          <h1 className="text-2xl font-bold text-[color:var(--brand-foreground)]">
            {t('auth.saveCredentials.title')}
          </h1>
          <p className="mt-2 text-sm text-[color:var(--brand-muted-foreground)]">
            {t('auth.saveCredentials.subtitle')}
          </p>
        </div>

        <dl className="space-y-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[var(--color-surface)] p-4 text-sm">
          <div>
            <dt className="text-xs text-[color:var(--brand-muted-foreground)]">{t('auth.saveCredentials.loginLabel')}</dt>
            <dd className="mt-0.5 break-all font-mono text-[color:var(--brand-foreground)]" data-testid="saved-login">
              {login}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[color:var(--brand-muted-foreground)]">{t('auth.saveCredentials.passwordLabel')}</dt>
            <dd className="mt-0.5 flex items-center justify-between gap-3">
              <span className="break-all font-mono text-[color:var(--brand-foreground)]" data-testid="saved-password">
                {shown ? password : '•'.repeat(Math.min(Math.max(password.length, 8), 16))}
              </span>
              <button
                type="button"
                onClick={() => setShown((value) => !value)}
                className="inline-flex shrink-0 items-center gap-1 text-xs text-(--brand-primary) hover:brightness-110"
              >
                {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {shown ? t('auth.saveCredentials.hide') : t('auth.saveCredentials.show')}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[color:var(--brand-muted-foreground)]">{t('auth.saveCredentials.addressLabel')}</dt>
            <dd className="mt-0.5 break-all font-mono text-[color:var(--brand-foreground)]">{address}</dd>
          </div>
        </dl>

        <div className="flex flex-col gap-2">
          <StadiumButton type="button" variant="secondary" fullWidth icon={<Copy className="h-4 w-4" />} onClick={() => void handleCopy()}>
            {t('auth.saveCredentials.copy')}
          </StadiumButton>
          {canShare && (
            <StadiumButton type="button" variant="secondary" fullWidth icon={<Share2 className="h-4 w-4" />} onClick={() => void handleShare()}>
              {t('auth.saveCredentials.share')}
            </StadiumButton>
          )}
          {credentialConstructor !== null && (
            <StadiumButton
              type="button"
              variant="secondary"
              fullWidth
              icon={<KeyRound className="h-4 w-4" />}
              onClick={() => void handleSaveInBrowser()}
            >
              {t('auth.saveCredentials.saveInBrowser')}
            </StadiumButton>
          )}
        </div>

        <div aria-live="polite" className="min-h-5 text-center text-xs" data-testid="save-credentials-notice">
          {notice !== null && (
            <span className={notice.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}>{notice.text}</span>
          )}
        </div>

        <p className="text-center text-xs text-[color:var(--brand-muted-foreground)]">{hint}</p>

        {(offerTelegram || offerEmail) && (
          <div className="space-y-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[var(--color-surface)] p-4">
            <p className="text-sm font-medium text-[color:var(--brand-foreground)]">{t('auth.saveCredentials.recoveryTitle')}</p>
            <p className="text-xs text-[color:var(--brand-muted-foreground)]">{recoveryBody}</p>
            <div className="flex flex-col gap-2">
              {offerTelegram && (
                <StadiumButton
                  type="button"
                  variant="outline"
                  fullWidth
                  icon={<Send className="h-4 w-4" />}
                  onClick={() => navigate(privacyLinkPath('telegram', continueTo))}
                >
                  {t('auth.saveCredentials.linkTelegram')}
                </StadiumButton>
              )}
              {offerEmail && (
                <StadiumButton
                  type="button"
                  variant="outline"
                  fullWidth
                  icon={<Mail className="h-4 w-4" />}
                  onClick={() => navigate(privacyLinkPath('email', continueTo))}
                >
                  {t('auth.saveCredentials.linkEmail')}
                </StadiumButton>
              )}
            </div>
          </div>
        )}

        <StadiumButton
          type="button"
          variant="primary"
          size="lg"
          fullWidth
          onClick={() => navigate(sanitizeNextDestination(continueTo) ?? '/dashboard', { replace: true })}
        >
          {t('auth.saveCredentials.continue')}
        </StadiumButton>
      </motion.div>
    </div>
  )
}

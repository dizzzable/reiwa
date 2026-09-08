/**
 * connect-link-dialog
 * ───────────────────
 * Handing the subscription over to an app that is not on this device.
 *
 * ── Why a QR and not just the copy button ────────────────────────────────────
 *
 * The link is on a phone; the client is on a desktop, a TV box or a router.
 * Copy puts it on the wrong clipboard, and every VPN client already has a
 * camera scanner in its "add subscription" screen — so the code IS the transfer
 * for that whole class of device. The page this screen replaces does exactly
 * this behind the same header control, and it was missing here.
 *
 * The copy button lives inside the sheet rather than beside it: on the device
 * the app is already installed on, copying is the right answer, and offering
 * both in one place is what makes the control honest about what it is for.
 *
 * ── The code is dark on white, always ────────────────────────────────────────
 *
 * The original draws it in its own accent, and that is a nicer picture. It is
 * also a picture that stops scanning: forty-four of the concepts are light, and
 * an accent like Mono Moonlight Crater's near-white would put a white code on a
 * white plate. A code that cannot be read is worth less than one that does not
 * match, so the plate is fixed and the frame around it carries the concept.
 *
 * ── Rendered inside the themed element, not portalled ────────────────────────
 *
 * Custom properties inherit down the DOM, not up from the layout root. A dialog
 * portalled to `document.body` sits outside the element that declares the
 * concept and would wear the cabinet's own palette instead — the same defect
 * the native `<select>` had, in a bigger box.
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, QrCode, X } from 'lucide-react'

import { LocalQr } from '@/components/ui/local-qr'

export function ConnectLinkDialog({
  url,
  surface,
  buttonClassName,
  onCopy,
  onClose,
}: {
  url: string
  surface: { readonly raised: string; readonly sunken: string }
  /** The screen's own step-button shape, so this sheet has no second one. */
  buttonClassName: string
  onCopy: () => Promise<boolean>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const panel = useRef<HTMLDivElement | null>(null)
  const closeButton = useRef<HTMLButtonElement | null>(null)

  // Focus moves into the sheet, and only that. No `body { overflow: hidden }`
  // here: the cabinet scrolls its `<main>`, not its body, so locking the body
  // would be a line that reads like it stops the page moving and does nothing.
  useEffect(() => {
    closeButton.current?.focus()
  }, [])

  /**
   * Escape closes; Tab stays inside.
   *
   * Without the cycle, tabbing out of the sheet lands on the buttons of the
   * screen behind it — which are still there, still clickable, and now covered
   * by an overlay the person cannot see past.
   */
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab' || panel.current === null) return
    const focusable = panel.current.querySelectorAll<HTMLElement>('button, [href]')
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (first === undefined || last === undefined) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      data-testid="connect-link-dialog"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-link-dialog-title"
        className={`${surface.raised} w-full max-w-[21rem] p-4 md:p-5`}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <QrCode aria-hidden="true" className="size-4 text-[color:var(--brand-primary)]" />
            {t('connect.linkSheetHeading')}
          </span>
          <button
            ref={closeButton}
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            // The same corner the header actions take — see `SMALL_CORNER`.
            className={`${surface.sunken} flex size-7 shrink-0 items-center justify-center rounded-[min(var(--radius-item),35%)] text-[color:var(--brand-primary)]`}
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>

        {/* The plate is white on purpose — see the note at the top of the file.
            It is `mx-auto` at its natural size rather than stretched, so the
            code keeps its quiet zone at every screen width. */}
        <div className="mt-4 flex justify-center">
          <div className="rounded-[var(--radius-card)] bg-white p-2">
            <LocalQr url={url} label={t('connect.linkSheetHeading')} size={208} captioned={false} />
          </div>
        </div>

        <h2 id="connect-link-dialog-title" className="mt-4 text-center text-base font-semibold">
          {t('connect.linkSheetTitle')}
        </h2>
        <p className="mt-1 text-center text-xs leading-relaxed text-[color:var(--brand-muted-foreground)]">
          {t('connect.linkSheetBody')}
        </p>

        <button
          type="button"
          className={`${surface.sunken} ${buttonClassName} mt-4`}
          onClick={() => void onCopy()}
        >
          <Copy aria-hidden="true" className="size-4" />
          {t('connect.copyLink')}
        </button>
      </div>
    </div>
  )
}

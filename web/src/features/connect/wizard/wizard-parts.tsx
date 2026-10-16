/**
 * wizard-parts
 * ────────────
 * The pieces the guided connect walk is drawn with, kept apart from the walk's
 * state so each can be read on its own.
 *
 * The same rules as the page with every instruction, and the same guard
 * (`connect-page-tokens.test.ts`): every colour and corner is one of the
 * cabinet's tokens, so the walk wears the connect screen's concept — or the
 * cabinet's own look — without knowing which. Two departures, both deliberate:
 *
 *  - Some things are round because of what they ARE: the radar's rings, the
 *    success badge, a live dot, a scrap of confetti. They take `CIRCLE`, the
 *    one place this file says "round"; nothing a theme gives a corner to does.
 *  - The app's mark sits on a neutral dark plate that does NOT follow the
 *    theme. Most marks in the library are a light glyph with no background of
 *    their own; on a light concept they would vanish. The plate is the one
 *    surface that must not move with the palette.
 */
import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronLeft, LifeBuoy, Power, X } from 'lucide-react'

import { BrandLogo } from '@/components/ui/brand-logo'
import { useBranding } from '@/lib/branding-provider'
import { cn } from '@/lib/utils'
import { resolveBrandLogo } from '@/types/branding'

/** Round by nature — see the header. The only place this file names the shape. */
export const CIRCLE = 'rounded-full'

/** A corner that stays a corner on a small box (`connect-page.tsx`, `SMALL_CORNER`). */
export const SMALL_CORNER = 'rounded-[min(var(--radius-item),35%)]'

/** A card standing over the ground: the connect screen's raised surface. */
export const RAISED =
  'rounded-[var(--radius-card)] border border-[color:var(--color-border-soft)] ' +
  'bg-[color:var(--color-surface-high)] backdrop-blur-[var(--glass-blur)]'

/** A control set into a card: chips, plain buttons, the list of tips. */
export const SUNKEN =
  'rounded-[var(--radius-item)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)]'

/** The accent, softened, for an icon's tile and the selected outline's glow. */
export const ACCENT_SOFT = 'bg-[color-mix(in_oklab,var(--brand-primary)_14%,transparent)]'

export const PRIMARY_BUTTON =
  'relative flex min-h-14 w-full items-center justify-center gap-2.5 rounded-[var(--radius-item)] px-5 ' +
  'bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)] text-base font-semibold ' +
  'shadow-[0_10px_26px_-8px_color-mix(in_oklab,var(--brand-primary)_45%,transparent)] ' +
  'transition-transform active:scale-[0.97] disabled:opacity-40'

export const OUTLINE_BUTTON =
  'flex min-h-[52px] w-full items-center justify-center gap-2 rounded-[var(--radius-item)] px-4 ' +
  'border border-[color:var(--color-border-strong)] text-[15px] font-medium ' +
  'transition-transform active:scale-[0.98] disabled:opacity-40'

export const GHOST_BUTTON =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-item)] px-4 ' +
  'text-[15px] font-medium text-[color:var(--brand-muted-foreground)]'

/**
 * The QR sheet's copy button: shape only. The sheet lays its own sunken
 * surface under the button, so a class with a fill or a text colour of its
 * own fights it — PRIMARY_BUTTON there put the accent's foreground, dark
 * under a light accent, on the dark sunken fill, and the label vanished.
 */
export const SHEET_BUTTON =
  'flex min-h-[52px] w-full items-center justify-center gap-2 px-4 text-[15px] font-medium ' +
  'transition-transform active:scale-[0.98]'

/** The header: back, where we are, help — and four segments that fill as the walk goes. */
export function WizardHeader({
  label,
  filled,
  showProgress,
  backLabel,
  helpLabel,
  onBack,
  onHelp,
}: {
  label: string
  /** How many of the four segments are full. */
  filled: number
  showProgress: boolean
  backLabel: string
  helpLabel: string
  onBack: () => void
  onHelp: () => void
}) {
  return (
    <header className="relative z-10 flex flex-col gap-3 pb-1.5 pt-1.5">
      <div className="flex items-center justify-between gap-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel}
          title={backLabel}
          className={`${SUNKEN} ${SMALL_CORNER} flex size-[38px] shrink-0 items-center justify-center`}
        >
          <ChevronLeft aria-hidden="true" className="size-[18px]" />
        </button>
        {/* The operator's mark beside where we are: the walk is their
            cabinet's, and a customer half-way through it in another app's
            shadow should still see whose it is. */}
        <div className="flex min-w-0 items-center justify-center gap-2">
          <BrandTile size={26} />
          <p
            data-wizard-label=""
            aria-live="polite"
            className="min-w-0 truncate text-[13px] font-medium text-[color:var(--brand-muted-foreground)]"
          >
            {label}
          </p>
        </div>
        <button
          type="button"
          onClick={onHelp}
          className={`${SUNKEN} flex h-[38px] shrink-0 items-center gap-1.5 px-3 text-[13px] font-medium text-[color:var(--brand-muted-foreground)]`}
        >
          <LifeBuoy aria-hidden="true" className="size-[15px]" />
          {helpLabel}
        </button>
      </div>
      <div
        aria-hidden="true"
        data-wizard-progress=""
        className={cn('flex gap-1.5 transition-opacity duration-300', showProgress ? 'opacity-100' : 'opacity-0')}
      >
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className={`block h-1 flex-1 overflow-hidden ${SMALL_CORNER} bg-[color:var(--color-surface-high)]`}
          >
            <span
              className={cn(
                'block h-full bg-[color:var(--brand-primary)] transition-[width] duration-500 ease-[cubic-bezier(.65,0,.35,1)]',
                index < filled ? 'w-full' : 'w-0',
              )}
            />
          </span>
        ))}
      </div>
    </header>
  )
}

/**
 * An app's mark on its neutral plate, or its first letter when the catalog
 * has no mark for it. The markup was sanitized by the panel on the way in
 * (`connect-page.tsx`, `Icon`), which is why it can be injected here.
 */
export function AppMark({ markup, name, size }: { markup: string | undefined; name: string; size: number }) {
  const style: CSSProperties = { width: size, height: size }
  const usable = typeof markup === 'string' && markup.startsWith('<svg')
  return (
    <span
      aria-hidden="true"
      style={style}
      className={`${SMALL_CORNER} flex shrink-0 items-center justify-center overflow-hidden border border-white/10 bg-black/85 text-white`}
    >
      {usable ? (
        <span className="block size-[74%] [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: markup }} />
      ) : (
        <span className="font-bold" style={{ fontSize: size * 0.42 }}>
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  )
}

/**
 * The operator's own mark, presented the way «Брендинг» says to present it —
 * the same plate (glass, solid, outline or none), the same fill of the plate
 * and the same glow as the sign-in tile (`entry-brand-tile.tsx`), at the size
 * this screen needs. Only the corner is the connect theme's, like every other
 * box here. With no logo uploaded it is the default mark in the brand colour,
 * exactly as everywhere else in the cabinet (`BrandLogo`).
 */
export function BrandTile({ size }: { size: number }) {
  const { branding } = useBranding()
  const logo = resolveBrandLogo(branding.brandLogo)
  const filled = logo.frame === 'glass' || logo.frame === 'solid'
  const mark = Math.round(size * logo.fill)
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: filled ? 'var(--color-surface)' : 'transparent',
    boxShadow: [
      logo.frame === 'none' ? null : 'inset 0 0 0 1px var(--color-border-soft)',
      logo.glow > 0 ? `0 0 ${Math.round(28 * logo.glow)}px var(--color-brand-glow)` : null,
    ]
      .filter((layer): layer is string => layer !== null)
      .join(', '),
    backdropFilter: logo.frame === 'glass' ? 'blur(24px)' : undefined,
    WebkitBackdropFilter: logo.frame === 'glass' ? 'blur(24px)' : undefined,
  }
  return (
    <span
      aria-hidden="true"
      data-wizard-brand={logo.frame}
      className={`${SMALL_CORNER} flex shrink-0 items-center justify-center`}
      style={style}
    >
      <BrandLogo style={{ width: mark, height: mark }} />
    </span>
  )
}

/** A catalog icon drawn in the current colour, or the fallback. Same trust as {@link AppMark}. */
export function CatalogIcon({
  markup,
  fallback,
  className,
}: {
  markup: string | undefined
  fallback: ReactNode
  className: string
}) {
  if (typeof markup !== 'string' || !markup.startsWith('<svg')) return <>{fallback}</>
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 ${className} [&>svg]:size-full`}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}

/** A tick that draws itself. Static under «reduce motion» (`connect-wizard.css`). */
export function DrawnCheck({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('cw-draw', className)}
    >
      <path pathLength={1} d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/** Rings opening out while the walk waits; they fold back in when the connection is found. */
export function Radar({ found }: { found: boolean }) {
  return (
    <div data-cw-found={found ? 'true' : 'false'} className="relative grid h-[220px] place-items-center">
      {[0, 1, 2].map((ring) => (
        <i
          key={ring}
          aria-hidden="true"
          className={`cw-ring absolute size-[92px] ${CIRCLE} border-2 border-[color:var(--brand-primary)]`}
        />
      ))}
      <motion.span
        aria-hidden="true"
        animate={{ scale: found ? 1.08 : 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 18 }}
        className={cn(
          `relative grid size-[92px] place-items-center ${CIRCLE} border-[1.5px] transition-colors duration-300`,
          found
            ? 'border-[color:var(--brand-primary)] bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]'
            : 'border-[color-mix(in_oklab,var(--brand-primary)_55%,transparent)] bg-[color:var(--color-surface-high)] text-[color:var(--brand-primary)] shadow-[0_0_40px_color-mix(in_oklab,var(--brand-primary)_34%,transparent)]',
        )}
      >
        {found ? <DrawnCheck className="size-[34px]" /> : <Power className="size-[34px]" />}
      </motion.span>
    </div>
  )
}

/**
 * The finish: a badge that pops in, and a handful of confetti in the theme's
 * own colours. Laid out once per mount from fixed angles, so a re-render does
 * not re-scatter it; none of it under «reduce motion».
 */
export function SuccessBurst({ reduced }: { reduced: boolean }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 22 }, (_, index) => {
        const angle = (Math.PI * 2 * index) / 22 + ((index * 37) % 10) / 25
        const distance = 70 + ((index * 53) % 70)
        return {
          index,
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance * 0.75 - 10,
          rotate: 420 + index * 40,
          color:
            index % 3 === 0
              ? 'var(--brand-primary)'
              : index % 3 === 1
                ? 'var(--brand-foreground)'
                : 'color-mix(in oklab, var(--brand-primary) 55%, var(--brand-foreground))',
        }
      }),
    [],
  )
  return (
    <div className="relative grid h-[150px] w-[180px] place-items-center">
      <motion.span
        initial={reduced ? false : { scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 14 }}
        className={`grid size-24 place-items-center ${CIRCLE} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)] shadow-[0_16px_48px_color-mix(in_oklab,var(--brand-primary)_40%,transparent)]`}
      >
        <DrawnCheck className="size-[46px]" />
      </motion.span>
      {!reduced &&
        pieces.map((piece) => (
          <motion.i
            key={piece.index}
            aria-hidden="true"
            initial={{ x: 0, y: 0, rotate: 0, scale: 0.4, opacity: 0 }}
            animate={{
              x: [0, piece.x * 0.6, piece.x],
              y: [0, piece.y * 0.6, piece.y + 40],
              rotate: [0, piece.rotate / 2, piece.rotate],
              scale: [0.4, 1, 0.8],
              opacity: [0, 1, 0],
            }}
            transition={{ duration: 1.05, delay: 0.18, ease: [0.2, 0.7, 0.3, 1], times: [0, 0.35, 1] }}
            className={`pointer-events-none absolute left-1/2 top-1/2 -ml-1 -mt-[3px] h-[5px] w-2 ${SMALL_CORNER}`}
            style={{ background: piece.color }}
          />
        ))}
    </div>
  )
}

export interface HelpTip {
  readonly title: string
  readonly body: string
  readonly icon: ReactNode
}

/**
 * «Помощь»: what usually goes wrong at THIS step, for THIS device and app.
 *
 * Portalled to the body with the screen's tokens carried onto the overlay —
 * the reason is in `connect-link-dialog.tsx`: the shell's `<main>` is a z-10
 * stacking context and the floating navigation is its z-20 sibling, so a
 * sheet rendered inside it loses to the navigation whatever z-index it has.
 */
export function HelpSheet({
  open,
  title,
  context,
  tips,
  themeStyle,
  closeLabel,
  reduced,
  onClose,
  children,
}: {
  open: boolean
  title: string
  context: readonly string[]
  tips: readonly HelpTip[]
  themeStyle: CSSProperties
  closeLabel: string
  reduced: boolean
  onClose: () => void
  children: ReactNode
}) {
  const closeButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [open, onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="help"
          className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center"
          style={themeStyle}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.01 : 0.25 }}
        >
          <button
            type="button"
            aria-label={closeLabel}
            tabIndex={-1}
            onClick={onClose}
            className="absolute inset-0 bg-black/55 backdrop-blur-[4px]"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            data-wizard-help=""
            initial={reduced ? { opacity: 0 } : { y: '105%' }}
            animate={reduced ? { opacity: 1 } : { y: 0 }}
            exit={reduced ? { opacity: 0 } : { y: '105%' }}
            transition={{ type: 'tween', duration: reduced ? 0.01 : 0.34, ease: [0.2, 0.9, 0.3, 1] }}
            className={`${RAISED} relative flex max-h-[86dvh] w-full max-w-[30rem] flex-col gap-4 overflow-y-auto px-5 pb-[calc(1.75rem+env(safe-area-inset-bottom))] pt-3 text-[color:var(--brand-foreground)] sm:pb-6`}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="pt-2 text-[21px] font-semibold tracking-[-0.02em]">{title}</h2>
              <button
                ref={closeButton}
                type="button"
                onClick={onClose}
                aria-label={closeLabel}
                className={`${SUNKEN} ${SMALL_CORNER} mt-1 flex size-9 shrink-0 items-center justify-center`}
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
            {context.length > 0 && (
              <div className="-mt-1.5 flex flex-wrap gap-1.5">
                {context.map((chip) => (
                  <span
                    key={chip}
                    className={`${SUNKEN} flex h-6 items-center px-2.5 text-xs font-medium text-[color:var(--brand-muted-foreground)]`}
                  >
                    {chip}
                  </span>
                ))}
              </div>
            )}
            {tips.length > 0 && (
              <ul className={`${SUNKEN} m-0 list-none px-3.5 py-0.5`}>
                {tips.map((tip, index) => (
                  <li
                    key={tip.title}
                    className={cn(
                      'flex items-start gap-3 py-3',
                      index > 0 && 'border-t border-[color:var(--color-border-soft)]',
                    )}
                  >
                    <span className="mt-px shrink-0 text-[color:var(--brand-primary)] [&>svg]:size-[17px]">
                      {tip.icon}
                    </span>
                    <div className="min-w-0">
                      <b className="block text-sm font-semibold">{tip.title}</b>
                      <span className="mt-0.5 block text-[13px] leading-snug text-[color:var(--brand-muted-foreground)]">
                        {tip.body}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/**
 * connect-platform-picker
 * ───────────────────────
 * Choosing the device the instructions are written for.
 *
 * ── Why this is not a `<select>` ─────────────────────────────────────────────
 *
 * It was one, and a `<select>`'s open list is drawn by the operating system.
 * Declaring `color-scheme` got it to stop being a white sheet on a black
 * screen, but that is as far as a native list can be dressed: the highlighted
 * row is painted with the platform's own selection colour — on Windows a solid
 * opaque blue — and the report was exactly that, "не видно за ним ничего".
 * Somebody arrowing through the list cannot read the row they are standing on,
 * which is the one row that matters.
 *
 * A native control is worth a lot on a phone, so this is not a trade made
 * lightly. What tipped it: this list is four to seven short items, it is opened
 * once per visit, and it sits on a screen whose whole point is that it wears
 * the operator's concept. A control that visibly does not belong to that screen
 * costs more here than the OS wheel gains.
 *
 * ── Selection is a tint, not a block ─────────────────────────────────────────
 *
 * The chosen row is marked with the accent at low opacity plus a tick, so the
 * label stays legible on top of it. That is the complaint, answered: the mark
 * says where you are without covering what you are reading.
 *
 * The tint is an overlay element rather than `color-mix()`, because the accent
 * arrives as an operator's hex, an `rgb()` from the concept generator, or an
 * eight-digit hex that already carries alpha — and one `opacity` over a solid
 * fill is correct for all three, on every engine the cabinet runs in.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'

import { line, type ConnectPlatform, type PlatformId } from './connect-catalog'

export function PlatformPicker({
  platforms,
  value,
  locale,
  label,
  icons,
  onChange,
  surface,
}: {
  platforms: readonly ConnectPlatform[]
  value: PlatformId
  locale: string
  label: string
  /** The whole library: every row shows its own mark, not only the trigger. */
  icons: Readonly<Record<string, string>>
  onChange: (next: PlatformId) => void
  /** The two class strings the screen dresses its surfaces with. */
  surface: { readonly raised: string; readonly sunken: string }
}) {
  const [open, setOpen] = useState(false)
  // Where the keyboard is, which is NOT where the selection is: arrowing down
  // moves this and leaves the chosen platform alone until Enter.
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const list = useRef<HTMLUListElement | null>(null)
  const listId = useId()

  const current = platforms.find((p) => p.id === value) ?? platforms[0] ?? null

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    // `pointerdown`, not `click`: a click on a control elsewhere would otherwise
    // land while this list is still open and covering it.
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Opening starts on the chosen row and moves the keyboard into the list, so
  // the first arrow press steps off the current platform rather than off the
  // top of the list. Once, on open — a `ref` callback runs on every render, and
  // re-focusing on each keystroke is a way to fight whatever else wants focus.
  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, platforms.findIndex((p) => p.id === value)))
    list.current?.focus()
  }, [open, platforms, value])

  // Closing has to put the focus back. Without it somebody who presses Escape
  // is returned to the top of the document, which on this screen means tabbing
  // through the whole header again to get where they already were.
  const close = (restoreFocus: boolean): void => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }

  const pick = (next: PlatformId): void => {
    onChange(next)
    close(true)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        setOpen(true)
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (index + 1) % platforms.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (index - 1 + platforms.length) % platforms.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActive(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActive(platforms.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const chosen = platforms[active]
      if (chosen !== undefined) pick(chosen.id)
    } else if (event.key === 'Tab') {
      close(false)
    }
  }

  if (current === null) return null

  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${line(current.title, locale)}`}
        data-testid="connect-platform-trigger"
        onKeyDown={onKeyDown}
        onClick={() => setOpen((was) => !was)}
        // `--radius-item`, the same corner the app chips take. It was
        // `--radius-pill` — 9999px — so on a concept with a modest radius this
        // one control sat on the screen as a lozenge among rectangles.
        className={`${surface.sunken} flex items-center gap-[6px] rounded-[var(--radius-item)] px-[9px] py-2 text-xs font-medium md:gap-2 md:px-3 md:py-2.5`}
      >
        <PlatformMark markup={icons[current.iconKey ?? '']} />
        <span className="truncate">{line(current.title, locale)}</span>
        <ChevronsUpDown
          aria-hidden="true"
          className="size-3 shrink-0 text-[color:var(--brand-primary)] md:size-3.5"
        />
      </button>

      {open && (
        // Rendered here rather than portalled to the body: custom properties
        // inherit down the DOM, so a list inside the themed element wears the
        // concept and one at the root would wear the cabinet's own palette —
        // which is the whole defect a native list had.
        <ul
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${listId}-${active}`}
          data-testid="connect-platform-list"
          onKeyDown={onKeyDown}
          ref={list}
          className={`${surface.raised} absolute right-0 top-[calc(100%+6px)] z-30 max-h-64 min-w-[11rem] overflow-y-auto p-1 outline-none`}
        >
          {platforms.map((platform, index) => {
            const selected = platform.id === value
            return (
              // The row IS the option. A `<button>` inside `role="option"`
              // gives a screen reader two controls where there is one, and the
              // keyboard never reaches the inner one anyway: the list holds
              // focus and `aria-activedescendant` points at these ids.
              <li
                key={platform.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={selected}
                data-connect-platform={platform.id}
                data-selected={selected ? '' : undefined}
                onPointerEnter={() => setActive(index)}
                onClick={() => pick(platform.id)}
                className="relative flex cursor-pointer items-center gap-2 rounded-[var(--radius-item)] px-2 py-2 text-xs"
              >
                {/* Where you are, and where the keyboard is: two weights of the
                    same accent, so the two can be told apart and neither of
                    them hides the label. */}
                {(selected || index === active) && (
                  <span
                    aria-hidden="true"
                    data-connect-platform-tint=""
                    className={`pointer-events-none absolute inset-0 rounded-[var(--radius-item)] bg-[color:var(--brand-primary)] ${
                      selected ? 'opacity-20' : 'opacity-10'
                    }`}
                  />
                )}
                <PlatformMark markup={icons[platform.iconKey ?? '']} />
                <span className="relative z-10 min-w-0 flex-1 truncate">
                  {line(platform.title, locale)}
                </span>
                {selected && (
                  <Check
                    aria-hidden="true"
                    className="relative z-10 size-3.5 shrink-0 text-[color:var(--brand-primary)]"
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * A platform's own mark, tinted with the accent.
 *
 * Sanitized in the panel — allow-listed elements and attributes, every handler
 * and every outward reference stripped. The cabinet does not sanitize it again
 * because it cannot do it better than the side that saw the write.
 */
function PlatformMark({ markup }: { markup?: string }) {
  if (typeof markup !== 'string' || !markup.startsWith('<svg')) return null
  return (
    <span
      aria-hidden="true"
      className="relative z-10 inline-flex size-[13px] shrink-0 text-[color:var(--brand-primary)] [&>svg]:size-full md:size-[15px]"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}

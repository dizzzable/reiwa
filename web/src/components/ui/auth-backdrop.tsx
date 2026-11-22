import { useBranding } from '@/lib/branding-provider'
import { resolveAuthBackground } from '@/lib/auth-background'

/**
 * AuthBackdrop — the operator's image or video behind the entry screens.
 *
 * Painted ABOVE every background the page already has (`NetworkBg`'s glows, the
 * page's own `--brand-bg-primary`) and BELOW the content: the layer is fixed and
 * sits at `z-0`, while every screen puts its column at `z-10`. Nothing inside is
 * interactive — `pointer-events: none` — so the fields and buttons above keep
 * every click, and the video carries no controls and no sound: it is wallpaper,
 * not a player.
 *
 * A veil of the operator's own background colour is laid over the media. The
 * entry screens draw type straight on the page (the recover and register
 * screens have no glass sheet around their captions), and an arbitrary
 * photograph under them is unreadable as soon as its middle happens to be
 * bright. The veil is a gradient at ~0.6 / 0.3 / 0.7 of `--brand-bg-primary`, so
 * the theme owns how the media reads rather than a hardcoded black overlay.
 *
 * Renders nothing at all when the panel has no background configured — that is
 * the shipped state and the previous rendering, byte for byte.
 */
export function AuthBackdrop({ className = '' }: { readonly className?: string }) {
  const { branding } = useBranding()
  const background = resolveAuthBackground(branding.authBackground)

  if (background.kind === 'none' || background.url === null) return null

  return (
    <div
      aria-hidden
      data-auth-backdrop={background.kind}
      className={`pointer-events-none fixed inset-0 z-0 overflow-hidden ${className}`.trim()}
    >
      {background.kind === 'video' ? (
        <video
          data-auth-backdrop-media
          className="h-full w-full object-cover"
          src={background.url}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        />
      ) : (
        <img
          data-auth-backdrop-media
          className="h-full w-full object-cover"
          src={background.url}
          alt=""
          decoding="async"
        />
      )}
      <div
        className="absolute inset-0"
        style={{
          // Two layers, because an arbitrary photo has no promises about its
          // own brightness: a FLAT wash holds the floor everywhere, and the
          // gradient adds the depth the entry screens already had (darker at the
          // top behind the heading, darker at the bottom behind the actions).
          //
          // LIGHTER SINCE 22.11 — every caption on the entry screens moved onto
          // a glass sheet (`.entry-panel`: the recover heading, its Telegram
          // line, the back link, the register's sign-in row, the support pill),
          // so the media no longer has to be dimmed for text to survive. The
          // old floor was 0.40 flat + 0.70…0.80 gradient, which on a dark clip
          // read as "no background at all". Text contrast is now the sheets'
          // job; this wash only keeps a bright photo from fighting them.
          background:
            'linear-gradient(180deg, color-mix(in oklab, var(--brand-bg-primary) 45%, transparent) 0%, color-mix(in oklab, var(--brand-bg-primary) 22%, transparent) 42%, color-mix(in oklab, var(--brand-bg-primary) 55%, transparent) 100%), color-mix(in oklab, var(--brand-bg-primary) 20%, transparent)',
        }}
      />
    </div>
  )
}

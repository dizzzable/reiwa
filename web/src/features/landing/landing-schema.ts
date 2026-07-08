/**
 * Landing schema — render-time types + a light fail-closed parser.
 *
 * The authoritative Zod schema lives on the rezeis side; here we mirror the
 * shape as TypeScript types and provide a light runtime coercion that:
 *  - keeps only sections with a KNOWN `type` (unknown types are DROPPED, never
 *    thrown — fail-closed rendering, Requirement 3.5),
 *  - keeps only sections with `visible !== false`,
 *  - defaults missing bookkeeping fields (`enabled: false`, `locales: ['ru']`).
 *
 * No zod dependency is pulled into the pre-login bundle: the renderer treats
 * every field defensively and skips a section that fails a per-section shape
 * check inside its component (`renderSection` in `landing-renderer.tsx`).
 */

export type LocalizedText = Record<string, string>;

export type SectionType =
  | 'hero'
  | 'featuresGrid'
  | 'howItWorks'
  | 'pricing'
  | 'faq'
  | 'testimonials'
  | 'stats'
  | 'trustLogos'
  | 'ctaBanner'
  | 'footer';

export const KNOWN_SECTION_TYPES: readonly SectionType[] = [
  'hero',
  'featuresGrid',
  'howItWorks',
  'pricing',
  'faq',
  'testimonials',
  'stats',
  'trustLogos',
  'ctaBanner',
  'footer',
];

export interface LandingSection {
  readonly id: string;
  readonly type: SectionType;
  readonly visible: boolean;
  readonly animation?: LandingAnimation;
  readonly data: Record<string, unknown>;
}

export type LandingBackground =
  | 'none'
  | 'gradient'
  | 'aurora'
  | 'grid'
  | 'dots'
  | 'glow'
  | 'mesh'
  | 'noise'
  | 'blobs'
  | 'spotlight'
  | 'network';
export type LandingSurfaceStyle = 'solid' | 'glass' | 'outline';
export type LandingAnimation = 'none' | 'fade' | 'fadeUp' | 'zoom';

export interface LandingTheme {
  readonly inherit?: boolean;
  readonly colors?: {
    readonly primary?: string;
    readonly bg?: string;
    readonly fg?: string;
    readonly accent?: string;
  };
  readonly font?: { readonly family?: string; readonly scale?: number };
  readonly radius?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  readonly background?: LandingBackground;
  readonly backgroundColors?: readonly string[];
  readonly animateBackground?: boolean;
  readonly surfaceStyle?: LandingSurfaceStyle;
}

export interface LandingConfigPayload {
  readonly schemaVersion: number;
  readonly enabled: true;
  readonly theme: LandingTheme;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly meta: { readonly title: LocalizedText; readonly description: LocalizedText };
  readonly ogImage?: string;
  readonly sections: readonly LandingSection[];
}

export type DisabledLandingPayload = { readonly enabled: false };
export type EffectiveLandingPayload = LandingConfigPayload | DisabledLandingPayload;

function isKnownSectionType(value: unknown): value is SectionType {
  return typeof value === 'string' && (KNOWN_SECTION_TYPES as readonly string[]).includes(value);
}

/**
 * Coerce an untrusted payload into a valid `EffectiveLandingPayload`. Unknown
 * section types are dropped, hidden sections are removed, and any structural
 * failure returns the disabled sentinel so the SPA safely falls back to
 * `/sign-in` instead of rendering a broken page.
 */
export function parseLandingPayload(raw: unknown): EffectiveLandingPayload {
  if (raw === null || typeof raw !== 'object') return { enabled: false };
  const obj = raw as Record<string, unknown>;
  if (obj['enabled'] !== true) return { enabled: false };

  const rawSections = Array.isArray(obj['sections']) ? (obj['sections'] as unknown[]) : [];
  const sections: LandingSection[] = [];
  for (const item of rawSections) {
    if (item === null || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (!isKnownSectionType(s['type'])) continue;
    if (s['visible'] === false) continue;
    const id = typeof s['id'] === 'string' ? (s['id'] as string) : `${s['type'] as string}-${sections.length}`;
    const data = s['data'] !== null && typeof s['data'] === 'object' ? (s['data'] as Record<string, unknown>) : {};
    const animation =
      typeof s['animation'] === 'string' &&
      ['none', 'fade', 'fadeUp', 'zoom'].includes(s['animation'] as string)
        ? (s['animation'] as LandingAnimation)
        : undefined;
    sections.push({ id, type: s['type'] as SectionType, visible: true, animation, data });
  }

  const locales = Array.isArray(obj['locales'])
    ? (obj['locales'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : ['ru'];
  const defaultLocale =
    typeof obj['defaultLocale'] === 'string' && (obj['defaultLocale'] as string).length > 0
      ? (obj['defaultLocale'] as string)
      : locales[0] ?? 'ru';
  const meta =
    obj['meta'] !== null && typeof obj['meta'] === 'object'
      ? (obj['meta'] as { title?: LocalizedText; description?: LocalizedText })
      : { title: {}, description: {} };
  const theme =
    obj['theme'] !== null && typeof obj['theme'] === 'object'
      ? (obj['theme'] as LandingTheme)
      : { inherit: true };

  return {
    schemaVersion: typeof obj['schemaVersion'] === 'number' ? (obj['schemaVersion'] as number) : 1,
    enabled: true,
    theme,
    locales: locales.length > 0 ? locales : ['ru'],
    defaultLocale,
    meta: {
      title: (meta.title ?? {}) as LocalizedText,
      description: (meta.description ?? {}) as LocalizedText,
    },
    ...(typeof obj['ogImage'] === 'string' ? { ogImage: obj['ogImage'] as string } : {}),
    sections,
  };
}

/**
 * Localized-text picker with default-locale fallback. Returns `''` when
 * nothing usable is present — the renderer then hides empty affordances.
 */
export function pickLocalized(
  value: unknown,
  locale: string,
  defaultLocale: string,
): string {
  if (value === null || typeof value !== 'object') return '';
  const map = value as Record<string, unknown>;
  const primary = map[locale];
  if (typeof primary === 'string' && primary.length > 0) return primary;
  const fallback = map[defaultLocale];
  if (typeof fallback === 'string' && fallback.length > 0) return fallback;
  for (const v of Object.values(map)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/**
 * Site-relative or `https://…` URL only. Any other scheme (including
 * `javascript:`, `data:`, `vbscript:`, protocol-relative `//`) is rejected —
 * the caller passes `null` into `href`/`src` and the affordance is dropped or
 * downgraded to plain text. Defence-in-depth (schema already rejected these
 * on publish, but the renderer must not trust the input either).
 */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  if (/^https:\/\/[^\s]+$/i.test(trimmed)) return trimmed;
  return null;
}

/**
 * Minimal allow-list HTML sanitizer for FAQ rich text (defence-in-depth; the
 * schema already restricts input). Removes every tag not in the allow-list,
 * strips every attribute except `href` on `<a>` (validated via `safeUrl`), and
 * neutralises event handlers / scheme-escaping attempts. No DOMPurify is
 * pulled into the pre-login bundle — the FAQ answer is a short bounded string
 * and this is easier to audit than an external dep.
 */
const RICH_TEXT_TAG_ALLOWLIST = new Set(['b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'p', 'br']);

export function sanitizeRichText(input: string): string {
  return input.replace(/<([^>]+)>/g, (_match, inner: string) => {
    const cleaned = inner.trim().replace(/^\//, '').split(/[\s>]/)[0]?.toLowerCase() ?? '';
    if (!cleaned || !RICH_TEXT_TAG_ALLOWLIST.has(cleaned)) return '';
    const isClose = inner.trim().startsWith('/');
    if (cleaned === 'a' && !isClose) {
      const hrefMatch = inner.match(/\shref\s*=\s*"([^"]*)"/i);
      const url = hrefMatch ? safeUrl(hrefMatch[1]) : null;
      if (url === null) return '';
      return `<a href="${url}" rel="noopener nofollow ugc" target="_blank">`;
    }
    return isClose ? `</${cleaned}>` : `<${cleaned}>`;
  });
}

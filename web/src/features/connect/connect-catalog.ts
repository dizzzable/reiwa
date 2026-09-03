/**
 * connect-catalog
 * ───────────────
 * Reading the catalog the panel sends, and turning a button into something the
 * browser can act on.
 *
 * The panel and the cabinet are separate images and deploy separately, so
 * nothing here trusts the payload's shape: everything is narrowed from
 * `unknown`, and anything unrecognised is dropped rather than rendered. A
 * cabinet one release behind its panel shows fewer apps; it does not show a
 * broken screen, and it never shows a button it does not understand.
 *
 * ── The one rule this file does NOT own ──────────────────────────────────────
 *
 * How to substitute the subscription URL into a deep link. `{{SUBSCRIPTION_LINK}}`
 * means two different things — raw in a path, percent-encoded in a query — and
 * the panel decides which at save time and ships the answer as `encode`. This
 * file obeys it and refuses a button that arrives without one.
 *
 * That is deliberate and it is the whole point: the same rule written on both
 * sides of an image boundary is the shape that has already drifted apart on us,
 * and a drift here is invisible — the app opens, adds nothing, and every
 * customer reports "the button does nothing".
 */

export const PLATFORM_IDS = [
  'ios',
  'android',
  'windows',
  'macos',
  'linux',
  'androidtv',
  'appletv',
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export type LocalizedText = Readonly<Record<string, string>>;

export type ConnectButton =
  | { readonly kind: 'external'; readonly label: LocalizedText; readonly url: string }
  | {
      readonly kind: 'deepLink';
      readonly label: LocalizedText;
      readonly template: string;
      readonly encode: 'raw' | 'component';
    }
  | { readonly kind: 'copyLink'; readonly label: LocalizedText };

export interface ConnectStep {
  readonly title: LocalizedText;
  readonly body: LocalizedText | null;
  readonly iconKey: string | null;
  readonly buttons: readonly ConnectButton[];
}

export interface ConnectApp {
  readonly id: string;
  readonly name: string;
  readonly iconKey: string | null;
  readonly featured: boolean;
  readonly steps: readonly ConnectStep[];
}

export interface ConnectPlatform {
  readonly id: PlatformId;
  readonly title: LocalizedText;
  readonly iconKey: string | null;
  readonly apps: readonly ConnectApp[];
}

export interface ConnectCatalog {
  readonly platforms: readonly ConnectPlatform[];
  readonly icons: Readonly<Record<string, string>>;
  readonly showConnectionKeys: boolean;
}

const SUBSCRIPTION_LINK_TOKEN = '{{SUBSCRIPTION_LINK}}';

/** Schemes the cabinet will never put in an `href`, whatever the panel says. */
const FORBIDDEN_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'about']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): LocalizedText | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [locale, line] of Object.entries(value)) {
    if (typeof line === 'string' && line.trim().length > 0) out[locale] = line;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function schemeOf(value: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(value.trim());
  return match === null ? null : match[1].toLowerCase();
}

function button(value: unknown): ConnectButton | null {
  if (!isRecord(value)) return null;
  const label = text(value['label']);
  if (label === null) return null;

  switch (value['kind']) {
    case 'external': {
      const url = str(value['url']);
      if (url === null) return null;
      const scheme = schemeOf(url);
      // A store link is opened by the cabinet; a scheme it did not expect is
      // one the panel should have refused, and the cabinet is not the place to
      // find out whether it did.
      if (scheme !== 'http' && scheme !== 'https') return null;
      return { kind: 'external', label, url };
    }
    case 'deepLink': {
      const template = str(value['template']);
      const encode = value['encode'];
      if (template === null) return null;
      if (encode !== 'raw' && encode !== 'component') return null;
      if (!template.includes(SUBSCRIPTION_LINK_TOKEN)) return null;
      const scheme = schemeOf(template);
      if (scheme === null || FORBIDDEN_SCHEMES.has(scheme)) return null;
      return { kind: 'deepLink', label, template, encode };
    }
    case 'copyLink':
      return { kind: 'copyLink', label };
    default:
      return null;
  }
}

function step(value: unknown): ConnectStep | null {
  if (!isRecord(value)) return null;
  const title = text(value['title']);
  if (title === null) return null;
  const buttons = Array.isArray(value['buttons'])
    ? value['buttons'].map(button).filter((b): b is ConnectButton => b !== null)
    : [];
  return { title, body: text(value['body']), iconKey: str(value['iconKey']), buttons };
}

function app(value: unknown): ConnectApp | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const name = str(value['name']);
  if (id === null || name === null) return null;
  const steps = Array.isArray(value['steps'])
    ? value['steps'].map(step).filter((s): s is ConnectStep => s !== null)
    : [];
  if (steps.length === 0) return null;
  return {
    id,
    name,
    iconKey: str(value['iconKey']),
    featured: value['featured'] === true,
    steps,
  };
}

function platform(value: unknown): ConnectPlatform | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  if (typeof id !== 'string' || !(PLATFORM_IDS as readonly string[]).includes(id)) return null;
  const title = text(value['title']);
  if (title === null) return null;
  const apps = Array.isArray(value['apps'])
    ? value['apps'].map(app).filter((a): a is ConnectApp => a !== null)
    : [];
  // A platform whose apps all failed to read is a platform the screen would
  // open on and show nothing.
  if (apps.length === 0) return null;
  return { id: id as PlatformId, title, iconKey: str(value['iconKey']), apps };
}

/**
 * Read whatever the edge returned.
 *
 * `null` for anything unusable — including the `null` the edge itself serves
 * when the panel is unreachable. The screen has one degraded mode, not two.
 */
export function readCatalog(payload: unknown): ConnectCatalog | null {
  if (!isRecord(payload)) return null;
  const platforms = Array.isArray(payload['platforms'])
    ? payload['platforms'].map(platform).filter((p): p is ConnectPlatform => p !== null)
    : [];
  if (platforms.length === 0) return null;

  const icons: Record<string, string> = {};
  if (isRecord(payload['icons'])) {
    for (const [key, markup] of Object.entries(payload['icons'])) {
      if (typeof markup === 'string' && markup.trim().startsWith('<svg')) icons[key] = markup;
    }
  }
  return { platforms, icons, showConnectionKeys: payload['showConnectionKeys'] === true };
}

/**
 * The href for an "add to app" button.
 *
 * `encode` comes from the panel, which derived it from where the placeholder
 * sits in the template. Substituted raw into a query parameter, the `?`, `&`,
 * `=` and `#` inside a subscription URL truncate it: the app opens and adds
 * nothing, which reads to everybody as a broken button rather than a mangled
 * one.
 */
export function buildDeepLink(button: ConnectButton, subscriptionUrl: string): string | null {
  if (button.kind !== 'deepLink') return null;
  if (subscriptionUrl.trim().length === 0) return null;
  const value =
    button.encode === 'component' ? encodeURIComponent(subscriptionUrl) : subscriptionUrl;
  return button.template.split(SUBSCRIPTION_LINK_TOKEN).join(value);
}

/**
 * The app to open on: the one this person used last, else the recommended one,
 * else the first.
 *
 * Remembering is the thing a standalone page could never do, and it is what
 * turns a reinstall or a second device from a quest back into two taps.
 */
export function chooseApp(
  platform: ConnectPlatform,
  remembered: string | null,
): ConnectApp {
  const byId = remembered === null ? undefined : platform.apps.find((a) => a.id === remembered);
  return byId ?? platform.apps.find((a) => a.featured) ?? platform.apps[0];
}

/**
 * The line to show, in the language the cabinet is running in.
 *
 * Falls back rather than blanking: a half-translated catalog is a normal state
 * for an operator to be in, and an empty card is a worse answer than a line in
 * the other language.
 */
export function line(value: LocalizedText | null, locale: string): string {
  if (value === null) return '';
  return value[locale] ?? value['en'] ?? value['ru'] ?? Object.values(value)[0] ?? '';
}

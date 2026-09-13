/**
 * connect-trampoline
 * ──────────────────
 * The detour an "add to app" link takes when the page it was tapped on cannot
 * open an app itself: out of the Telegram Mini App through Telegram's own
 * `openLink`, onto a page of the cabinet's in a real browser, and from THAT
 * page's button into the app. Why the Mini App cannot do it directly is in
 * `deep-link-handoff.ts`; this file is the link's passage across the hop.
 *
 * ── The link travels in the fragment, and only there ────────────────────────
 *
 * A subscription URL is the key to somebody's subscription. A fragment is never
 * sent in a request, so the page load that carries it writes nothing to any
 * access log on the way — not this API's, not a proxy's in front of it. A query
 * string would be in all of them.
 *
 * It is base64url rather than percent-encoding because four different native
 * link pipelines carry it before a browser does: Telegram for iOS re-parses the
 * address with its own percent-encoding fallback, Telegram for Android rebuilds
 * it through `Uri`, Telegram for macOS rewrites `#` and escapes, and the web
 * clients hand it to `window.open`. An alphabet of letters, digits, `-` and `_`
 * is one none of them has a reason to touch.
 *
 * ── The page opens only what the operator's own catalog would have built ────
 *
 * The page is public — Safari has none of Telegram's cookies — so anybody can
 * hand anybody an address of it, and whatever the fragment says, the button
 * says in the operator's name. A scheme allowlist cannot be the check: the
 * catalog is the operator's to edit, the owner's own shop runs an app the
 * shipped catalog does not contain, and a list written here would refuse it.
 *
 * So the page fetches the same public catalog the connect screen reads and
 * accepts the link only when some deep-link button in it, fed this
 * subscription URL, produces exactly this link. Any scheme the operator
 * configured works; a scheme they did not — `itms-services:`, `tel:`, an
 * `intent:` URL, a different app's import endpoint — does not, and neither
 * does http, https or anything that executes, which are refused before the
 * catalog is consulted at all.
 *
 * ── …and only around a subscription this cabinet handed out ────────────────
 *
 * The catalog vouches for the SHAPE of the link and for nothing inside it: the
 * operator's own `incy://add/{{SUBSCRIPTION_LINK}}` builds
 * `incy://add/https://evil.example/sub` from a stranger's subscription as
 * readily as from the operator's, and on its own the page would offer that on
 * the operator's domain. So the payload carries a third field, `sig` — the
 * signature `GET /subscriptions/all` put on the subscription the connect screen
 * was showing (`src/api/lib/connect-handoff-signature.ts`). Once the catalog
 * has vouched, the page sends the cabinet the SHA-256 of the subscription URL
 * with that signature, and puts the link behind its button only when the answer
 * is yes. Neither the URL nor the link is in that request. A payload without a
 * signature is not a payload.
 *
 * What remains is what existed before the connect screen did: somebody handing
 * somebody else a subscription the OPERATOR issued. A valid signature says this
 * cabinet gave that URL to a signed-in subscriber; it does not say the
 * subscription belongs to whoever opened the page, nor that it is still live.
 * So the page still names the subscription's host beside the button, and
 * nothing on it opens without a tap.
 */
import { buildDeepLink, isAppSchemeUrl, type ConnectCatalog } from './connect-catalog';

/** The public route that receives the hop. Registered in `App.tsx`. */
export const TRAMPOLINE_PATH = '/connect/open';

export interface TrampolinePayload {
  /** The deep link exactly as the connect screen built it. */
  readonly link: string;
  /** The subscription URL it was built from — what "copy" hands over. */
  readonly subscriptionUrl: string;
  /** The cabinet's signature over `subscriptionUrl`: the subscription's `connectSignature`. */
  readonly signature: string;
}

/**
 * Longer than any real pair, short enough that a hostile address cannot make
 * the page decode megabytes.
 */
const MAX_FRAGMENT_LENGTH = 16_000;

/**
 * A signature as the cabinet spells one: 32 bytes in 43 unpadded base64url
 * characters, the last of which carries four bits and two zero bits — so only
 * these sixteen characters can end it. The verify route applies the same test,
 * so a payload this page accepts is never one the cabinet refuses as malformed.
 */
const SIGNATURE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** The trampoline address for a link, on the given origin. */
export function trampolineUrl(origin: string, payload: TrampolinePayload): string {
  const body = JSON.stringify({ link: payload.link, sub: payload.subscriptionUrl, sig: payload.signature });
  return `${origin}${TRAMPOLINE_PATH}#${toBase64Url(body)}`;
}

/**
 * The payload in a `location.hash`, or `null` for anything that is not one.
 *
 * Never throws: the fragment is whatever the address bar holds, and a page that
 * crashed on a mangled one would be a blank screen instead of an explanation.
 */
export function readTrampolinePayload(hash: string): TrampolinePayload | null {
  const encoded = hash.startsWith('#') ? hash.slice(1) : hash;
  if (encoded.length === 0 || encoded.length > MAX_FRAGMENT_LENGTH) return null;
  const json = fromBase64Url(encoded);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { link, sub, sig } = parsed as Record<string, unknown>;
  if (typeof link !== 'string' || typeof sub !== 'string' || typeof sig !== 'string') return null;
  if (link.length === 0 || sub.length === 0 || !SIGNATURE.test(sig)) return null;
  return { link, subscriptionUrl: sub, signature: sig };
}

/**
 * The SHA-256 of a subscription URL in base64url — what the page asks the
 * cabinet about in place of the URL itself.
 *
 * `crypto.subtle` exists only in a secure context. This page is only ever
 * reached through `openLink` from a Telegram Mini App's own https origin, and
 * where it is missing anyway the promise rejects, which the page treats like a
 * network failure: a retry, and no button.
 */
export async function subscriptionDigest(subscriptionUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscriptionUrl));
  return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * Whether the operator's catalog vouches for this link — the first of the
 * page's two checks, and never enough on its own: the button also waits for
 * the cabinet's yes on the signature (`subscriptionDigest` above).
 *
 * The scheme and subscription tests come first and do not depend on the
 * catalog, so a refusal of `javascript:` or `https:` is not something a
 * malformed or hostile catalog could ever talk the page out of.
 */
export function verifyTrampolinePayload(
  catalog: ConnectCatalog | null,
  payload: TrampolinePayload,
): boolean {
  if (!isAppSchemeUrl(payload.link)) return false;
  if (!isSubscriptionUrl(payload.subscriptionUrl)) return false;
  if (catalog === null) return false;
  for (const platform of catalog.platforms) {
    for (const app of platform.apps) {
      for (const step of app.steps) {
        for (const button of step.buttons) {
          if (
            button.kind === 'deepLink' &&
            buildDeepLink(button, payload.subscriptionUrl) === payload.link
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** A subscription link is an http(s) address; anything else is not one. */
function isSubscriptionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function toBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    // `fatal`: bytes that are not UTF-8 are a mangled address, not a link with a
    // replacement character in the middle of it.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

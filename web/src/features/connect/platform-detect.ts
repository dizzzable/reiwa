/**
 * platform-detect
 * ───────────────
 * Which platform the person is on, so the screen opens on their apps instead of
 * on a list of seven.
 *
 * This is the one thing an external subscription page cannot do. Reached by a
 * link, it knows nothing about the device and has to ask — which is why the
 * page we redirect to today opens with a dropdown of every platform we support.
 * The cabinet is already running on the device.
 *
 * ── Guessing is allowed here, and only here ──────────────────────────────────
 *
 * User-agent sniffing is unreliable by construction: it is a string a browser
 * chooses to send, iPadOS deliberately claims to be a Mac, and every "request
 * desktop site" toggle exists to make it lie. So the detection is a DEFAULT,
 * never a decision: the platform picker stays on the screen, and picking from
 * it is one tap. A wrong guess costs that tap; requiring the tap from everyone
 * costs it always.
 *
 * The order of the checks is load-bearing — Android is matched before Linux
 * because every Android UA also says Linux, and the TV variants before their
 * phone counterparts for the same reason.
 */
import { PLATFORM_IDS, type PlatformId } from './connect-catalog';

interface DetectionInput {
  readonly userAgent: string;
  /** `navigator.maxTouchPoints`; the only signal that separates an iPad from a Mac. */
  readonly maxTouchPoints: number;
  readonly platform: string;
}

export function detectPlatform(input: DetectionInput): PlatformId | null {
  const ua = input.userAgent.toLowerCase();
  if (ua.length === 0) return null;

  // TVs first: an Android TV is also an Android, and a tvOS device also says
  // "like Mac OS X". Matched later, they would each be swallowed by the phone.
  if (ua.includes('android') && (ua.includes('tv') || ua.includes('aft'))) return 'androidtv';
  if (ua.includes('appletv') || ua.includes('apple tv') || ua.includes('tvos')) return 'appletv';

  if (ua.includes('android')) return 'android';

  // iPadOS 13+ reports the desktop Safari UA on purpose, so the UA alone reads
  // an iPad as a Mac and offers it Mac apps that will not install. Touch points
  // are what tells them apart: a Mac reports 0.
  const claimsMac = ua.includes('macintosh') || ua.includes('mac os x');
  if (claimsMac && input.maxTouchPoints > 1) return 'ios';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
  if (claimsMac) return 'macos';

  if (ua.includes('windows') || input.platform.toLowerCase().startsWith('win')) return 'windows';
  // Last, because Android and several TV boxes also say Linux.
  if (ua.includes('linux') || ua.includes('x11') || ua.includes('cros')) return 'linux';

  return null;
}

/** The detection against the live browser, guarded for a non-browser render. */
export function detectCurrentPlatform(): PlatformId | null {
  if (typeof navigator === 'undefined') return null;
  return detectPlatform({
    userAgent: navigator.userAgent ?? '',
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    platform: (navigator as Navigator & { platform?: string }).platform ?? '',
  });
}

const REMEMBERED_APP_KEY = 'reiwa.connect.app';

/**
 * The app this person chose last, per platform.
 *
 * Per platform, because the same person legitimately uses different apps on
 * their phone and their laptop, and remembering one across both would open the
 * wrong card on whichever they touched second.
 *
 * Best-effort: storage throws in a private window and in some in-app browsers,
 * and a screen that cannot remember a preference is still a working screen.
 */
export function rememberedApp(platform: PlatformId): string | null {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_APP_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = (parsed as Record<string, unknown>)[platform];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function rememberApp(platform: PlatformId, appId: string): void {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_APP_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    const next: Record<string, unknown> =
      typeof parsed === 'object' && parsed !== null ? { ...(parsed as object) } : {};
    // Bounded by the platform list rather than by whatever keys are already in
    // there: this value survives across releases, and an old key nobody writes
    // any more would otherwise sit in storage forever.
    for (const key of Object.keys(next)) {
      if (!(PLATFORM_IDS as readonly string[]).includes(key)) delete next[key];
    }
    next[platform] = appId;
    window.localStorage.setItem(REMEMBERED_APP_KEY, JSON.stringify(next));
  } catch {
    // Nothing to do and nothing worth telling the customer.
  }
}

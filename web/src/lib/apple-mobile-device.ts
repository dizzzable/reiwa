/**
 * "Is this an iPhone, iPad or iPod?" — whatever browser it is, and whatever
 * the user agent pretends.
 *
 * iPadOS 13+ sends a desktop Mac user agent in every browser, so a
 * `/iPhone|iPad|iPod/` test misses every iPad; the touch points give it away,
 * because no Mac has a touch screen. The ONE copy of this test: web push asks it
 * (`lib/push.ts`, where it decides that iOS and iPadOS deliver push only to an
 * app added to the Home Screen) and so does the install sheet
 * (`hooks/use-install-prompt.ts`, which adds "and it is Safari").
 *
 * No imports, so neither of those two drags the other's dependencies in.
 */
export function isAppleMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

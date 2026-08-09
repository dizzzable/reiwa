/**
 * `?next=` — the destination a deep-link was aiming at, carried across the
 * screens that stand between the launch and it.
 *
 * A Mini App deep-link opens the cabinet straight on a route (`${miniAppUrl}
 * /renew`, from the expiry notification's «Продлить» button). Everything
 * between that document and `/renew` — the bootstrap hand-off, and then the
 * credential gates in `StealthLayout` — is a redirect, and a redirect that
 * forgets where the user was going lands them on `/dashboard` instead. The
 * intended page is not recoverable at that point: the launch is spent and the
 * notification is not coming again.
 *
 * The validation is the one `tma-bootstrap-page` already applied, moved here so
 * the gates cannot drift from it: a same-origin absolute path and nothing else.
 * `//evil.example` is a protocol-relative URL that `navigate()` would happily
 * follow off-app, and a bare `evil.example` would resolve against the current
 * route — so `next` must start with exactly one `/`.
 */

/** A `next` value that is safe to navigate to, or `null`. */
export function sanitizeNextDestination(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : null
}

/** This document's validated `?next=`, or `null`. */
export function readNextDestination(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): string | null {
  return sanitizeNextDestination(new URLSearchParams(search).get('next'))
}

/**
 * `?next=<encoded>` for appending to a redirect target, or `''`.
 *
 * Empty for anything that fails validation, so a crafted value is dropped at
 * the point it would be forwarded rather than carried one screen further.
 */
export function nextDestinationQuery(raw: string | null | undefined): string {
  const destination = sanitizeNextDestination(raw)
  return destination === null ? '' : `?next=${encodeURIComponent(destination)}`
}

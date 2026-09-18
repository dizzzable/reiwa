import { sanitizeNextDestination } from '@/lib/next-destination'

/**
 * A bot sign-in link — `?signin=<token>` — on ANY cabinet path.
 *
 * ── The defect this exists for ────────────────────────────────────────────
 *
 * The bot stamps its one-time token onto whatever cabinet address a button
 * opens: `/` for «Кабинет», `/dashboard` for the trial button when there is no
 * Mini App, `/plans` or `/renew` for an operator's own button. Only the home
 * page ever spent it. Everywhere else the protected shell saw no session and
 * redirected to `/bootstrap` — with a bare path for `/dashboard`, and with the
 * token buried inside `next` for every other page — so the home page that
 * followed found no `signin` to read. The customer tapped «Попробовать
 * бесплатно» in the bot and met the sign-in form of an account that has no
 * password, and the token, never spent, sat valid in `next` for five minutes.
 *
 * So a token anywhere but `/` is handed to `/` BEFORE any route decides
 * anything, together with where the link was going; the home page spends it
 * exactly as it always has and then goes there.
 */

/** The query parameter the bot carries its one-time sign-in token in. */
export const SIGNIN_TOKEN_PARAM = 'signin'

/**
 * The only token shape `POST /api/v1/auth/bot-signin` will exchange: 64 hex
 * characters. Anything else is not handed over — it could never sign anybody
 * in, and a redirect for it would only be a detour.
 */
export function isSigninTokenShape(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/i.test(value)
}

/**
 * Routes that are a way INTO the cabinet rather than a place in it.
 *
 * A link aimed at one of them has no destination of its own — after signing in
 * the customer belongs on the default page, not back on a sign-in form — except
 * that such a route may carry the real destination in its own `next`
 * (`/bootstrap?next=/renew`), which is then the one kept. Compared lower-case,
 * because the router matches paths regardless of case.
 */
const ENTRY_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/dashboard',
  '/bootstrap',
  '/tma',
  '/welcome',
  '/sign-in',
  '/register',
  '/recover',
  '/claim',
  '/finish-setup',
  '/change-password',
])

/**
 * Where to send a document whose address carries a sign-in token on a path
 * other than `/`, or `null` when there is nothing to hand over.
 *
 * The answer is `/` with the token, every other parameter of the address as it
 * was (the `utm_*` tags, `ref`, `campaign` — the home page carries those on),
 * and `next` naming where the link was going. `next` passes the same
 * same-origin check every other hop applies, so a crafted path is dropped here
 * rather than forwarded.
 */
export function magicLinkHandoffTarget(pathname: string, search: string): string | null {
  if (pathname === '/') return null
  const params = new URLSearchParams(search)
  const token = params.get(SIGNIN_TOKEN_PARAM)
  if (!isSigninTokenShape(token)) return null

  params.delete(SIGNIN_TOKEN_PARAM)
  const destination = destinationOf(pathname, params)
  params.delete('next')

  const target = new URLSearchParams(params)
  target.set(SIGNIN_TOKEN_PARAM, token)
  if (destination !== null) target.set('next', destination)
  return `/?${target.toString()}`
}

function destinationOf(pathname: string, rest: URLSearchParams): string | null {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (ENTRY_PATHS.has(trimmed.toLowerCase())) {
    return sanitizeNextDestination(rest.get('next'))
  }
  const query = rest.toString()
  return sanitizeNextDestination(query.length > 0 ? `${pathname}?${query}` : pathname)
}

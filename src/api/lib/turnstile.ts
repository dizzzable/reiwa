/**
 * Cloudflare Turnstile server-side verification.
 *
 * Used by the anonymous support endpoint to gate conversation creation
 * behind a human-verification challenge when `SUPPORT_TURNSTILE_SECRET` is
 * configured. Best-effort + fail-closed: a missing token or any error
 * verifying returns `false` (the caller rejects the request). When the
 * secret is not configured the caller skips verification entirely and
 * relies on rate limiting.
 */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(
  secret: string,
  token: string | undefined | null,
  ip?: string,
): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0) return false;
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set("remoteip", ip);
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(5_000),
    });
    const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
    return data?.success === true;
  } catch {
    return false;
  }
}

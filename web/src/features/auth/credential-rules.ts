/**
 * The rules a new login and a new password must meet in the browser — the
 * same ones `/claim`, `/finish-setup` and registration enforce, so a customer
 * who picks a login anywhere is held to one standard. The panel is the source
 * of truth (`loginPolicy`); these only save a round trip.
 *
 * Each returns the key under `claim.usernameError.*` / `claim.passwordError.*`
 * that names the problem, or `null` when the value is acceptable.
 */

const LOGIN_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

export function validateLoginName(value: string): string | null {
  if (!value) return "required";
  if (value.length < 3) return "tooShort";
  if (value.length > 32) return "tooLong";
  if (!LOGIN_PATTERN.test(value)) return "invalidChars";
  return null;
}

export function validateNewPassword(value: string): string | null {
  if (!value) return "required";
  if (value.length < 8) return "tooShort";
  if (value.length > 128) return "tooLong";
  return null;
}

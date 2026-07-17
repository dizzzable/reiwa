import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/**
 * Parses untrusted initData for failed-auth diagnostics only.
 * Never use this result for identity, authorization, or account selection.
 */
export function parseUnverifiedTelegramInitData(
  initData: string,
): { auth_date: number } | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const authDate = Number(params.get('auth_date') ?? 0);
    if (!Number.isSafeInteger(authDate) || authDate <= 0) return null;
    return { auth_date: authDate };
  } catch {
    return null;
  }
}

export function validateTelegramInitData(initData: string, botToken: string): TelegramUser | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const providedBuf = Buffer.from(hash, 'hex');

    // Recompute the HMAC over a given field set and compare in constant time.
    const matches = (entries: [string, string][]): boolean => {
      const dataCheckString = entries
        .slice()
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      const computed = createHmac('sha256', secretKey).update(dataCheckString).digest();
      return computed.length === providedBuf.length && timingSafeEqual(computed, providedBuf);
    };

    // Telegram (since late 2024) also ships an Ed25519 `signature` field for
    // third-party validation. Clients/SDKs disagree on whether `signature` is
    // part of the bot-token HMAC `data_check_string`. Accept EITHER convention:
    // signature included, or excluded. Both still require the bot token, so
    // security is unchanged — we only stop rejecting valid users over a field
    // ordering/inclusion quirk.
    const allEntries = Array.from(params.entries());
    const withoutSignature = allEntries.filter(([k]) => k !== 'signature');
    if (!matches(allEntries) && !matches(withoutSignature)) {
      return null;
    }

    // Check auth_date freshness. The HMAC already proves authenticity; the
    // freshness window only limits replay of a leaked initData. 1h was too
    // strict (desktop clients can reuse a slightly older auth_date and clock
    // skew on the host produced false 401s) — 24h is the common, safe window.
    const authDate = Number(params.get('auth_date') ?? 0);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) return null;

    const userRaw = params.get('user');
    if (!userRaw) return null;

    return JSON.parse(userRaw) as TelegramUser;
  } catch {
    return null;
  }
}

/**
 * Validates a Telegram **Login Widget** payload (distinct from Mini App
 * initData): the secret key is `SHA256(bot_token)` and the data-check-string is
 * every field except `hash`, sorted and joined by `\n`. Returns the user on a
 * valid, fresh (<24h) signature, else `null`.
 *
 * Reference: https://core.telegram.org/widgets/login#checking-authorization
 */
export function validateTelegramWidget(
  fields: Record<string, string | undefined>,
  botToken: string,
): TelegramUser | null {
  try {
    const hash = fields.hash;
    if (!hash) return null;

    const entries = Object.entries(fields).filter(
      ([k, v]) => k !== 'hash' && v !== undefined,
    ) as [string, string][];

    const dataCheckString = entries
      .slice()
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = createHash('sha256').update(botToken).digest();
    const computed = createHmac('sha256', secretKey).update(dataCheckString).digest();
    const providedBuf = Buffer.from(hash, 'hex');
    if (computed.length !== providedBuf.length || !timingSafeEqual(computed, providedBuf)) {
      return null;
    }

    const authDate = Number(fields.auth_date ?? 0);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) return null;

    const id = Number(fields.id ?? 0);
    if (!Number.isFinite(id) || id <= 0) return null;
    return {
      id,
      first_name: fields.first_name ?? '',
      last_name: fields.last_name,
      username: fields.username,
    };
  } catch {
    return null;
  }
}

/**
 * Safe, secret-free diagnostic for a failing initData validation. Returns the
 * sorted field names that go into the data_check_string and short prefixes of
 * the computed vs provided HMAC so we can tell apart a token mismatch (both
 * computed correctly but differ) from an unexpected-field problem. NEVER logs
 * the bot token or full hashes.
 */
export function diagnoseTelegramInitData(
  initData: string,
  botToken: string,
): { keys: string[]; computedPrefix: string; providedPrefix: string; hasSignature: boolean } {
  const params = new URLSearchParams(initData);
  const provided = params.get('hash') ?? '';
  const hasSignature = params.has('signature');
  params.delete('hash');
  params.delete('signature');
  const keys = Array.from(params.keys()).sort((a, b) => a.localeCompare(b));
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return {
    keys,
    computedPrefix: computed.slice(0, 12),
    providedPrefix: provided.slice(0, 12),
    hasSignature,
  };
}

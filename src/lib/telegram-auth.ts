import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export function parseTelegramInitData(
  initData: string,
): { user: TelegramUser; auth_date: number } | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const userRaw = params.get('user');
    const authDate = Number(params.get('auth_date') ?? 0);
    if (!userRaw) return null;

    const user: TelegramUser = JSON.parse(userRaw);
    return { user, auth_date: authDate };
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

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    // Constant-time comparison of the two hex digests. `timingSafeEqual`
    // throws on length mismatch, so guard first (a wrong-length hash is
    // never valid anyway).
    const computedBuf = Buffer.from(computedHash, 'hex');
    const providedBuf = Buffer.from(hash, 'hex');
    if (
      computedBuf.length !== providedBuf.length ||
      !timingSafeEqual(computedBuf, providedBuf)
    ) {
      return null;
    }

    // Check auth_date freshness (within 1 hour)
    const authDate = Number(params.get('auth_date') ?? 0);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 3600) return null;

    const userRaw = params.get('user');
    if (!userRaw) return null;

    return JSON.parse(userRaw) as TelegramUser;
  } catch {
    return null;
  }
}

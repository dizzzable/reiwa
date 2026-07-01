import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

import { validateTelegramWidget } from '../src/lib/telegram-auth.js';

const BOT_TOKEN = '123456:test-bot-token';

/** Signs a widget payload the way Telegram's Login Widget does. */
function sign(fields: Record<string, string>): string {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHash('sha256').update(BOT_TOKEN).digest();
  return createHmac('sha256', secret).update(dataCheckString).digest('hex');
}

describe('validateTelegramWidget', () => {
  it('accepts a valid, fresh payload', () => {
    const base = {
      id: '777000',
      first_name: 'Ann',
      username: 'ann',
      auth_date: String(Math.floor(Date.now() / 1000)),
    };
    const user = validateTelegramWidget({ ...base, hash: sign(base) }, BOT_TOKEN);
    expect(user).not.toBeNull();
    expect(user?.id).toBe(777000);
    expect(user?.username).toBe('ann');
  });

  it('rejects a tampered id', () => {
    const base = { id: '777000', first_name: 'Ann', auth_date: String(Math.floor(Date.now() / 1000)) };
    const hash = sign(base);
    expect(validateTelegramWidget({ ...base, id: '888', hash }, BOT_TOKEN)).toBeNull();
  });

  it('rejects a wrong bot token', () => {
    const base = { id: '777000', first_name: 'Ann', auth_date: String(Math.floor(Date.now() / 1000)) };
    expect(validateTelegramWidget({ ...base, hash: sign(base) }, 'other-token')).toBeNull();
  });

  it('rejects a stale payload (auth_date older than 24h)', () => {
    const base = {
      id: '777000',
      first_name: 'Ann',
      auth_date: String(Math.floor(Date.now() / 1000) - 90_000),
    };
    expect(validateTelegramWidget({ ...base, hash: sign(base) }, BOT_TOKEN)).toBeNull();
  });

  it('rejects a payload with no hash', () => {
    expect(validateTelegramWidget({ id: '1', auth_date: '1' }, BOT_TOKEN)).toBeNull();
  });
});

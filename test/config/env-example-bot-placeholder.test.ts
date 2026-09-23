/**
 * `.env.example` does not name a bot after the panel.
 *
 * Every install starts from this file, and `BOT_USERNAME` is the bot the
 * cabinet sends customers back to after a payment (`t.me/<BOT_USERNAME>?start=
 * payment_return`). It shipped as `RezeisBot`: the panel's name, and a handle
 * that is not the operator's — an install that kept it sent its customers to
 * a stranger's bot. The placeholder is now neutral, and this reads the file as
 * `env_file` does: every assignment, commented examples included, of every key
 * that names a bot.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ENV_EXAMPLE = fileURLToPath(new URL('../../.env.example', import.meta.url));

/** `KEY=value` for every line that assigns a bot username, commented or not. */
function botUsernameExamples(): Array<{ readonly key: string; readonly value: string }> {
  const out: Array<{ readonly key: string; readonly value: string }> = [];
  for (const line of readFileSync(ENV_EXAMPLE, 'utf8').split(/\r?\n/)) {
    const match = /^#?\s*([A-Z0-9_]*BOT_USERNAME)=(.*)$/.exec(line.trim());
    if (match !== null) out.push({ key: match[1], value: match[2].trim() });
  }
  return out;
}

describe('.env.example', () => {
  it('ships a bot username placeholder, and not one named after the panel', () => {
    const examples = botUsernameExamples();

    expect(examples.map((example) => example.key)).toContain('BOT_USERNAME');
    for (const { key, value } of examples) {
      expect(value, key).not.toMatch(/rezeis/i);
    }
  });
});

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The commands that switch an existing install's Redis to the append-only log
 * (review R2a-06).
 *
 * They are run in the operator's host shell, where `.env` is NOT loaded — only
 * Docker Compose reads it. `-a "$REDIS_PASSWORD"` there passes an empty
 * password: `CONFIG SET appendonly yes` answers NOAUTH and the log stays off,
 * the check prints nothing, and an operator who goes on and replaces the
 * compose file starts Redis EMPTY — every web session signed out, every saved
 * settings copy gone. And `aof_rewrite_in_progress:0` alone is already true
 * while the rewrite is only scheduled.
 *
 * Both places the commands are written: `docs/environment.md` and the comment
 * in `docker-compose.yml`.
 */

const DOC = readFileSync(new URL('../../docs/environment.md', import.meta.url), 'utf8');
const COMPOSE = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');

/** Every `valkey-cli -a …` command line in a text. */
function passwordArgs(text: string): string[] {
  return [...text.matchAll(/valkey-cli -a ("[^"]*"|\S+)/g)].map((match) => match[1] as string);
}

describe.each([
  ['docs/environment.md', DOC],
  ['docker-compose.yml', COMPOSE],
])('the AOF switch in %s', (_file, text) => {
  it('never passes the password as a host-shell variable, and names where it comes from', () => {
    const args = passwordArgs(text);
    // Anchor: the switch command is there to check (the healthcheck's
    // `"-a", "${REDIS_PASSWORD}"` is Compose's own substitution, not matched).
    expect(args.length).toBeGreaterThanOrEqual(1);
    for (const arg of args) {
      expect(arg).not.toMatch(/\$/);
      expect(arg).toMatch(/REDIS_PASSWORD/);
    }
  });

  it('waits for the rewrite to be neither running nor scheduled', () => {
    expect(text).toMatch(/aof_rewrite_in_progress:0/);
    expect(text).toMatch(/aof_rewrite_scheduled:0/);
  });
});

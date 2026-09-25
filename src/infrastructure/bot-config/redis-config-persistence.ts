/**
 * RedisConfigPersistence
 * ──────────────────────
 * The bot config's `ConfigPersistencePort`: its last-known-good copy, kept by
 * the store every panel settings group shares
 * (`infrastructure/config-versions/last-known-good.ts`), so the bot seeds its
 * cache from it on a cold restart instead of the hardcoded Reiwa default.
 *
 * Design notes:
 *   - Both methods are best-effort and never throw — the store's contract:
 *     `save` swallows write errors, `load` answers `null` on a miss, parse or
 *     shape failure, and "unreadable" when Redis could not be read at all —
 *     which the cache must not remember as "no copy".
 *   - A lightweight shape check guards against a corrupt or schema-drifted
 *     copy poisoning the bot on boot.
 *   - The copy used to live under `reiwa:botconfig:last-known-good` with a
 *     7-day TTL and no shape number. That key is read once, as a fallback,
 *     and deleted by the first save under the new one; the TTL is gone with
 *     it, because an outage longer than a week is exactly when the operator's
 *     buttons matter most.
 *   - What is saved may carry Telegram `file_id`s the bot stamped in after the
 *     panel answered (`BotConfigCache.stampBannerFileId`). They belong to this
 *     bot token; a copy from another token only costs a re-upload by URL. It
 *     is kept under the panel's version of the answer, not the stamped one.
 *   - A config over the copy's cap is not written: the operator is told, once
 *     per version, with its size (`config-versions/copy-not-saved.ts`). It used
 *     to be a log line only, and a bot restarted during a panel outage came
 *     back with older buttons and nothing on the panel to say why.
 */
import type { ConfigPersistencePort } from '../../application/ports/config-persistence.port.js';
import { configVersionOf } from '../config-versions/config-version.js';
import type { CopyNotSavedReporter } from '../config-versions/copy-not-saved.js';
import {
  LAST_KNOWN_GOOD_DEFAULT_MAX_BYTES,
  LAST_KNOWN_GOOD_UNREADABLE,
  type LastKnownGoodGroup,
  type LastKnownGoodStorePort,
  type LastKnownGoodUnreadable,
} from '../config-versions/last-known-good.js';

import type { BotConfig } from './types.js';

/** Minimal structural guard — enough to reject corrupt / drifted JSON. */
function isBotConfigShape(value: unknown): value is BotConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.buttons) &&
    typeof v.visual === 'object' &&
    v.visual !== null &&
    typeof v.features === 'object' &&
    v.features !== null
  );
}

/** The bot config's group in the last-known-good store. */
export const BOT_CONFIG_LKG: LastKnownGoodGroup<BotConfig> = {
  name: 'bot-config',
  shape: 1,
  legacyKey: 'reiwa:botconfig:last-known-good',
  accepts: isBotConfigShape,
};

export class RedisConfigPersistence implements ConfigPersistencePort {
  constructor(
    private readonly store: LastKnownGoodStorePort,
    /** Where a copy over the cap is told; nowhere when omitted (tests). */
    private readonly copyNotSaved?: CopyNotSavedReporter,
  ) {}

  async load(): Promise<BotConfig | null | LastKnownGoodUnreadable> {
    const copy = await this.store.load(BOT_CONFIG_LKG);
    return copy === null || copy === LAST_KNOWN_GOOD_UNREADABLE ? copy : copy.payload;
  }

  async save(config: BotConfig, version?: string): Promise<void> {
    const outcome = await this.store.save(BOT_CONFIG_LKG, config, version);
    if (outcome === 'too-large') {
      this.copyNotSaved?.report('bot-config', {
        configVersion: version ?? configVersionOf(config),
        bytes: Buffer.byteLength(JSON.stringify(config), 'utf8'),
        maxBytes: BOT_CONFIG_LKG.maxBytes ?? LAST_KNOWN_GOOD_DEFAULT_MAX_BYTES,
      });
    }
  }
}

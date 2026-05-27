/**
 * `BannerStorePort` implementation backed by an admin-override callback
 * + a filesystem assets tree.
 *
 * The 5-step lookup chain documented on `BannerStorePort`:
 *
 *   1. DB  `bot.banner.<name>.<lang>`     via `getOverride`
 *   2. DB  `bot.banner.<name>`            via `getOverride`
 *   3. FS  `assets/banners/<lang>/<name>.{ext}`
 *   4. FS  `assets/banners/<lang>/default.{ext}`
 *   5. FS  `assets/banners/default.{ext}`
 *
 * The DB legs (1–2) are not actually database reads — reiwa never
 * touches the admin DB directly. Instead the bot's bot-config refresh
 * loop hands a snapshot of `bot-config.translations` to the store via
 * the `getOverride(key)` callback. That keeps the resolver in O(1)
 * memory lookups on the hot path while the periodic refresh handles
 * cache freshness on a separate timer.
 *
 * The FS legs (3–5) walk `<assetsRoot>/<lang>/<name>.<ext>` candidates
 * across the supported image formats. The first hit wins; misses are
 * silent (callers expect `null` for "no banner" without an error).
 *
 * Async fs.access is used instead of fs.existsSync so a slow disk does
 * not block the event loop on every banner render.
 */
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

import type {
  BannerResource,
  BannerStorePort,
} from '../../application/ports/banner-store.port.js';
import type { LoggerPort } from '../../application/ports/logger.port.js';
import {
  BANNER_FORMATS,
  type BannerName,
} from '../../core/enums/banner-name.enum.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';

const OVERRIDE_KEY_PREFIX = 'bot.banner';
const DEFAULT_NAME = 'default';

/**
 * Callback that returns the operator-managed override for a `BotText`
 * key (e.g. `bot.banner.menu.en`). Implementations are expected to
 * return `undefined` for unknown keys and a trimmed-non-empty URL
 * string when the operator has set one.
 */
export type GetOverride = (key: string) => string | undefined;

export interface BannerStoreOptions {
  /**
   * Absolute (or process-cwd-relative) path to the directory hosting the
   * filesystem fallback assets. Layout:
   *   <assetsRoot>/<lang>/<name>.<ext>
   *   <assetsRoot>/default.<ext>
   *
   * Missing directories are tolerated — the store simply keeps walking
   * the lookup chain when an `access` call fails.
   */
  readonly assetsRoot: string;
  readonly getOverride: GetOverride;
  readonly logger?: LoggerPort;
}

export class BannerStore implements BannerStorePort {
  private readonly assetsRoot: string;
  private readonly getOverride: GetOverride;
  private readonly logger: LoggerPort | undefined;

  constructor(options: BannerStoreOptions) {
    this.assetsRoot = options.assetsRoot;
    this.getOverride = options.getOverride;
    this.logger = options.logger;
  }

  async resolve(name: BannerName, lang: SupportedLocale): Promise<BannerResource | null> {
    // Step 1: locale-scoped admin override.
    const localised = this.readOverride(`${OVERRIDE_KEY_PREFIX}.${name}.${lang}`);
    if (localised) return { kind: 'url', url: localised };

    // Step 2: locale-agnostic admin override.
    const generic = this.readOverride(`${OVERRIDE_KEY_PREFIX}.${name}`);
    if (generic) return { kind: 'url', url: generic };

    // Step 3: FS asset for this lang + name.
    const langNamed = await this.firstExistingFile(join(this.assetsRoot, lang), name);
    if (langNamed) return { kind: 'file', path: langNamed };

    // Step 4: FS default for this lang.
    const langDefault = await this.firstExistingFile(join(this.assetsRoot, lang), DEFAULT_NAME);
    if (langDefault) return { kind: 'file', path: langDefault };

    // Step 5: FS global default.
    const globalDefault = await this.firstExistingFile(this.assetsRoot, DEFAULT_NAME);
    if (globalDefault) return { kind: 'file', path: globalDefault };

    return null;
  }

  private readOverride(key: string): string | null {
    let value: string | undefined;
    try {
      value = this.getOverride(key);
    } catch (err: unknown) {
      this.logger?.warn({ err, key }, 'BannerStore.getOverride threw');
      return null;
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return null;
    return trimmed;
  }

  private async firstExistingFile(dir: string, baseName: string): Promise<string | null> {
    for (const ext of BANNER_FORMATS) {
      const candidate = join(dir, `${baseName}.${ext}`);
      try {
        await access(candidate, fsConstants.R_OK);
        return candidate;
      } catch {
        // miss — try the next format
      }
    }
    return null;
  }
}

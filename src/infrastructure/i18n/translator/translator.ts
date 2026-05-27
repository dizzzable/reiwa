/**
 * Translator implementation that satisfies both `TranslatorPort` and
 * `LocalePackHydrator`.
 *
 * Lookup precedence (matches the snoups/remnashop convention adopted in
 * dezign Wave 0):
 *   1. operator override pack for `lang`            (admin `BotText`)
 *   2. built-in pack for `lang`                     (`BUILTIN_PACKS[lang]`)
 *   3. operator override pack for the default locale (RU)
 *   4. built-in RU baseline                          (`RU_PACK`)
 *   5. the raw key itself — visible failure beats silent gibberish
 *
 * The class is pure (no I/O); operator overrides are pushed in via
 * `setOverrides()` from the bot-config refresh loop. A process-wide
 * singleton (`translator`) is exported for the bot/api/worker; tests
 * construct their own instance for isolation.
 */
import {
  DEFAULT_LOCALE,
  type SupportedLocale,
  isSupportedLocale,
} from '../../../core/enums/locale.enum.js';
import type {
  LocalePackHydrator,
  TranslatorPort,
} from '../../../application/ports/translator.port.js';
import { BUILTIN_PACKS, RU_PACK } from '../packs/index.js';

type LocalePack = Readonly<Record<string, string>>;

/**
 * Hydrate operator overrides from `/api/internal/bot-config.translations`.
 *
 * Two key shapes are accepted (operators can mix both inside the same
 * `BotText` table):
 *   1. **Per-locale namespaced** `<lang>.<i18n key>` — default for new
 *      deploys. e.g. `en.menu.choose_action`.
 *   2. **Per-key suffix** `<i18n key>.<lang>` — legacy STEALTHNET layout.
 *      e.g. `menu.choose_action.en`.
 *
 * Anything not matching the above is treated as a Russian baseline
 * override — operators editing copy in the admin without touching code.
 *
 * `button.<id>.<lang>` survives unchanged so `resolveButtonLabel` can
 * find it directly. RU is hard-coded — we still index ru-prefixed keys
 * so admin overrides still work (e.g. `ru.menu.choose_action`).
 */
function ingestOverrides(
  raw: Readonly<Record<string, string>> | null | undefined,
): Map<SupportedLocale, Map<string, string>> {
  const packs = new Map<SupportedLocale, Map<string, string>>();
  if (!raw) return packs;

  const ensure = (lang: SupportedLocale): Map<string, string> => {
    let pack = packs.get(lang);
    if (!pack) {
      pack = new Map<string, string>();
      packs.set(lang, pack);
    }
    return pack;
  };

  for (const [rawKey, rawValue] of Object.entries(raw)) {
    if (typeof rawValue !== 'string') continue;

    // Shape (1): "<lang>.<i18n key>"
    const head = rawKey.split('.', 1)[0];
    if (head.length === 2 && /^[a-z]{2}$/.test(head) && isSupportedLocale(head)) {
      const subKey = rawKey.slice(head.length + 1);
      ensure(head).set(subKey, rawValue);
      // Mirror `button.<id>.<lang>` to support resolveButtonLabel
      // when admin uses the per-locale-namespace shape.
      if (subKey.startsWith('button.')) {
        ensure(head).set(rawKey, rawValue);
      }
      continue;
    }

    // Shape (2): "<i18n key>.<lang>" — only the trailing 2-letter chunk
    // is treated as the locale tag.
    const lastDot = rawKey.lastIndexOf('.');
    if (lastDot > 0) {
      const tail = rawKey.slice(lastDot + 1);
      if (tail.length === 2 && /^[a-z]{2}$/.test(tail) && isSupportedLocale(tail)) {
        const subKey = rawKey.slice(0, lastDot);
        ensure(tail).set(subKey, rawValue);
        if (subKey.startsWith('button.')) {
          ensure(tail).set(`${subKey}.${tail}`, rawValue);
        }
        continue;
      }
    }

    // Otherwise treat as a global RU override.
    ensure(DEFAULT_LOCALE).set(rawKey, rawValue);
  }

  return packs;
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  let out = template;
  for (const [vk, vv] of Object.entries(vars)) {
    out = out.split(`{{${vk}}}`).join(String(vv));
  }
  return out;
}

export class Translator implements TranslatorPort, LocalePackHydrator {
  private overrides: Map<SupportedLocale, Map<string, string>> = new Map();

  setOverrides(map: Readonly<Record<string, string>> | null | undefined): void {
    this.overrides = ingestOverrides(map);
  }

  t(key: string, lang: SupportedLocale, vars?: Record<string, string | number>): string {
    const val = this.lookup(key, lang) ?? key;
    return vars ? interpolate(val, vars) : val;
  }

  resolveButtonLabel(buttonId: string, fallbackLabel: string, lang: SupportedLocale): string {
    const fullKey = `button.${buttonId}.${lang}`;
    const overridePack = this.overrides.get(lang);
    if (overridePack) {
      const direct = overridePack.get(fullKey) ?? overridePack.get(`button.${buttonId}`);
      if (direct !== undefined && direct.trim().length > 0) return direct;
    }
    return fallbackLabel;
  }

  /** Test seam — wipes operator overrides between unit tests. */
  reset(): void {
    this.overrides = new Map();
  }

  private lookup(key: string, lang: SupportedLocale): string | undefined {
    const overridePack = this.overrides.get(lang);
    if (overridePack) {
      const direct = overridePack.get(key) ?? overridePack.get(`bot.${key}`);
      if (direct !== undefined) return direct;
    }
    if (lang !== DEFAULT_LOCALE) {
      const builtIn: LocalePack | undefined = BUILTIN_PACKS[lang];
      if (builtIn !== undefined && builtIn[key] !== undefined) return builtIn[key];
    }
    const ruOverride = this.overrides.get(DEFAULT_LOCALE);
    if (ruOverride) {
      const direct = ruOverride.get(key) ?? ruOverride.get(`bot.${key}`);
      if (direct !== undefined) return direct;
    }
    return RU_PACK[key];
  }
}

/** Process-wide singleton — Wave 2+ will inject this via DI. */
export const translator = new Translator();

/**
 * Format days with Russian pluralization rules. Lives in the translator
 * module because the day.* keys are part of the translation pack.
 */
export function formatDays(n: number, lang: SupportedLocale = DEFAULT_LOCALE): string {
  if (lang !== 'ru') {
    const oneOrMany = n === 1 ? translator.t('day.one', lang) : translator.t('day.many', lang);
    return `${n} ${oneOrMany}`;
  }
  const abs = Math.abs(n);
  const lastTwo = abs % 100;
  const last = abs % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${n} ${translator.t('day.many', lang)}`;
  if (last === 1) return `${n} ${translator.t('day.one', lang)}`;
  if (last >= 2 && last <= 4) return `${n} ${translator.t('day.few', lang)}`;
  return `${n} ${translator.t('day.many', lang)}`;
}

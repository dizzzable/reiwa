import type { SupportedLocale } from '../../core/enums/locale.enum.js';

/**
 * Translator contract for the bot, api and worker.
 *
 * `t(key, lang, vars?)` is the only translation entry point. The key
 * convention is `{category}-{scope}-{entity}-{action}` (e.g. `btn-cabinet`,
 * `msg-welcome`, `ntf-payment-completed`) — see snoups/remnashop assets
 * `README` for the full convention.
 *
 * Lookup precedence is implementation-defined but typically:
 *   1. operator override pack (admin-managed `BotText` rows for `lang`)
 *   2. operator override pack for the default locale
 *   3. built-in pack for `lang`
 *   4. built-in pack for the default locale
 *   5. the raw `key` itself, so missing translations are visible in the UI
 */
export interface TranslatorPort {
  /**
   * Resolve `key` for `lang`, interpolating `vars` into `{{name}}`
   * placeholders. Always returns a string; never throws.
   */
  t(key: string, lang: SupportedLocale, vars?: Record<string, string | number>): string;

  /**
   * Resolve a per-button label. Tries `button.<id>.<lang>` overrides
   * first, falls back to the operator-managed `BotButton.label` raw
   * value when no localised form exists.
   */
  resolveButtonLabel(buttonId: string, fallbackLabel: string, lang: SupportedLocale): string;
}

/**
 * Side-channel for hydrating operator-managed translation packs without
 * forcing the consumer to depend on the entire `TranslatorPort`.
 *
 * `setOverrides(map)` accepts the flat key->value translation map returned
 * by the bot-config endpoint (admin's source of truth). Implementations
 * dispatch keys onto per-locale buckets according to the operator-chosen
 * key shape (`<lang>.<i18n key>` or `<i18n key>.<lang>`).
 */
export interface LocalePackHydrator {
  setOverrides(map: Readonly<Record<string, string>> | null | undefined): void;
}

/**
 * Public entry point for the bot/api/worker.
 *
 * Exposes a process-wide `translator` singleton (a `Translator` instance
 * that satisfies both `TranslatorPort` and `LocalePackHydrator`), the
 * locale auto-detect helper and the per-user locale cache. Everything
 * downstream of Wave 2 should depend on the port types from
 * `application/ports/translator.port` and resolve the implementation
 * through DI; until then, importing the singletons directly from here
 * is the supported path.
 */
export { BUILTIN_PACKS, RU_PACK, EN_PACK } from './packs/index.js';
export {
  Translator,
  translator,
  formatDays,
} from './translator/index.js';
export {
  detectLocaleFromTelegram,
  UserLocaleCache,
  userLocaleCache,
} from './locale-detector/index.js';

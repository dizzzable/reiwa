/**
 * Built-in translation packs shipped in the bot image.
 *
 * `BUILTIN_PACKS` is the dispatch table consumed by the translator. New
 * locales are added by:
 *   1. authoring `<locale>.pack.ts` next to this file
 *   2. registering it under its 2-letter key here
 *   3. extending `SUPPORTED_LOCALES` in `core/enums/locale.enum.ts`
 *
 * The Russian pack (`RU_PACK`) is exported separately as the
 * source-of-truth baseline — `t()` falls back to it whenever the
 * requested locale and operator overrides both miss.
 */
import type { SupportedLocale } from '../../../core/enums/locale.enum.js';

import { EN_PACK } from './en.pack.js';
import { RU_PACK } from './ru.pack.js';

export { RU_PACK } from './ru.pack.js';
export { EN_PACK } from './en.pack.js';

export const BUILTIN_PACKS: Readonly<Record<SupportedLocale, Readonly<Record<string, string>>>> = {
  ru: RU_PACK,
  en: EN_PACK,
};

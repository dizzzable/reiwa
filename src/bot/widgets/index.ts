/**
 * Bot widgets barrel.
 *
 * Pure rendering helpers consumed by handlers / pages. They do not
 * touch the AdminClient, the bot config cache or grammy lifecycle —
 * inputs come in, an `InlineKeyboard` (or similar) goes out.
 */
export {
  BUTTON_KIND_MAP,
  buildMainKeyboard,
  isTelegramSafeButtonUrl,
  resolveBinding,
  type ButtonBinding,
  type ButtonKind,
  type MainKeyboardOptions,
} from './main-keyboard.js';

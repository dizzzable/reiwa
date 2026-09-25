/**
 * A settings copy that was NOT saved because it is over the saved-copy cap
 * (`last-known-good.ts`), told to the operator: a warning through the
 * `ErrorReporter` — `POST /api/internal/system/error` → the panel's «Журнал
 * аудита» → «Системные события», card «Кабинет не сохранил копию …». Customers
 * see the new settings at once; what is lost is the copy a restart during a
 * panel outage serves, which stays an older one, or none.
 *
 * The public config was the only group told (review R2a-07). The bot config
 * and the connect page wrote a log line nobody reads, and a bot restarted
 * during an outage then showed older buttons with nothing on the panel to say
 * why.
 *
 * The context is what the panel's card reads (agreed with the panel side,
 * 25.09.2026):
 *   event          `reiwa.config.copy_not_saved`
 *   group          `public-config` | `bot-config` | `connect-page`
 *   configVersion  the panel version of the payload NOT saved. Not `version`:
 *                  the reporter adds the build's identity after the context
 *                  (`withReiwaBuildInfo`), and its `version` is the cabinet's —
 *                  the config's version sent as `version` never arrived
 *   bytes, maxBytes
 *   why            Russian, for «💡 Почему»: the kind, the size, what to do
 *
 * Once per group and version: the public config is saved again on every TTL
 * refresh and the bot config on every read of the panel, while the payload
 * stays the same size.
 */
import type { LoggerPort } from '../../application/ports/logger.port.js';
import { ReiwaSystemEventType } from '../../core/enums/system-event-type.enum.js';
import type { ErrorReporter } from '../error-reporter/index.js';
import { formatCopySize } from './last-known-good.js';

/** The settings groups whose too-large copy is told to the operator. */
export type CopyNotSavedGroup = 'public-config' | 'bot-config' | 'connect-page';

/** A copy that was not saved, and why. */
export interface CopyNotSaved {
  /** The panel version of the payload that was not saved. */
  readonly configVersion: string;
  readonly bytes: number;
  readonly maxBytes: number;
}

export interface CopyNotSavedReporter {
  /** Tell the operator, once per group and version. Never throws. */
  report(group: CopyNotSavedGroup, skipped: CopyNotSaved): void;
}

/** `bytes` as an operator reads it on a Russian card: `5,3 МБ`. */
export function megabytesRu(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

/** Per group: the log line's subject and consequence, and the card's «Почему». */
const WORDS: Record<
  CopyNotSavedGroup,
  { readonly subject: string; readonly consequence: string; readonly why: (size: string, cap: string) => string }
> = {
  'public-config': {
    subject: 'Public config copy not saved',
    consequence: 'customers see the new appearance, but a restart during a panel outage serves the older saved copy (or none)',
    why: (size, cap) =>
      `Оформление кабинета весит ${size} — больше предела ${cap} для его копии в Redis кабинета, поэтому копия не обновлена. ` +
      'Клиенты видят новое оформление, но если кабинет перезапустится, пока панель недоступна, ' +
      'он покажет прежнюю сохранённую копию (или стандартное оформление, если копии нет). ' +
      'Уменьшите оформление: картинки, загруженные прямо в поля, и количество своих иконок.',
  },
  'bot-config': {
    subject: 'Bot config copy not saved',
    consequence: 'the bot runs on the new config, but a restart during a panel outage serves the older saved copy (or the stock one)',
    why: (size, cap) =>
      `Настройки бота весят ${size} — больше предела ${cap} для их копии в Redis кабинета, поэтому копия не обновлена. ` +
      'Бот работает с новыми настройками, но если он перезапустится, пока панель недоступна, ' +
      'он покажет прежнюю сохранённую копию (или стандартные кнопки и тексты, если копии нет). ' +
      'Уменьшите настройки бота: лишние экраны и длинные тексты в «Карте бота».',
  },
  'connect-page': {
    subject: 'Connect page copy not saved',
    consequence: 'customers see the new connect screen, but a restart during a panel outage serves the older saved copy (or none)',
    why: (size, cap) =>
      `Экран подключения весит ${size} — больше предела ${cap} для его копии в Redis кабинета, поэтому копия не обновлена. ` +
      'Клиенты видят новый экран подключения, но если кабинет перезапустится, пока панель недоступна, ' +
      'он покажет прежнюю сохранённую копию (или выключенный экран подключения, если копии нет). ' +
      'Уменьшите его на странице «Страница подписки»: картинки, загруженные прямо в поля, и количество приложений.',
  },
};

export function createCopyNotSavedReporter(opts: {
  readonly logger?: LoggerPort | undefined;
  readonly errorReporter?: ErrorReporter | undefined;
}): CopyNotSavedReporter {
  const log = opts.logger?.child({ component: 'saved-copy' });
  /** Per group, the version last reported. */
  const reported = new Map<CopyNotSavedGroup, string>();
  return {
    report(group, skipped): void {
      if (reported.get(group) === skipped.configVersion) return;
      reported.set(group, skipped.configVersion);
      const words = WORDS[group];
      // The version is in the sentence too: the reporter drops a sentence it
      // sent in the last minute, and two saves of about the same size read the
      // same without it — the second version would never be told.
      const message =
        `${words.subject} (config ${skipped.configVersion.slice(0, 8)}): ${formatCopySize(skipped.bytes)} is over the ` +
        `${formatCopySize(skipped.maxBytes)} cap — ${words.consequence}`;
      const context = {
        event: ReiwaSystemEventType.CONFIG_COPY_NOT_SAVED,
        group,
        configVersion: skipped.configVersion,
        bytes: skipped.bytes,
        maxBytes: skipped.maxBytes,
        why: words.why(megabytesRu(skipped.bytes), megabytesRu(skipped.maxBytes)),
      };
      try {
        log?.warn(context, message);
        opts.errorReporter?.report({ level: 'warning', message, context });
      } catch {
        // Telling the operator must never fail the save that found it.
      }
    },
  };
}

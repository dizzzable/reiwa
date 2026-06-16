/**
 * Startup banner
 * ──────────────
 * A small, pretty boot banner printed once per process (api / bot / worker),
 * in the spirit of Remnawave's and remnashop's startup art. Written straight
 * to stdout (not through pino) so it renders as readable lines in
 * `docker compose logs`. Colour is opt-out via the standard `NO_COLOR` env.
 */
import { REIWA_VERSION } from './version.js';

export type ReiwaRole = 'api' | 'bot' | 'worker';

const WAVE = '▰▱'.repeat(22);
const RULE = '─'.repeat(44);

const useColor = process.env.NO_COLOR === undefined;
function paint(text: string, code: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const ROLE_LABELS: Record<ReiwaRole, string> = {
  api: 'API · Mini App · web cabinet',
  bot: 'Telegram bot',
  worker: 'Background worker',
};

/** Print the reiwa boot banner for the given process role. */
export function printReiwaBanner(role: ReiwaRole): void {
  const cyan = (s: string): string => paint(s, '36');
  const bold = (s: string): string => paint(s, '1');
  const dim = (s: string): string => paint(s, '2');

  const lines = [
    '',
    cyan(`  ${WAVE}`),
    `     ${bold('🌊  R E I W A')}   ${dim('·')}   ${bold(`v${REIWA_VERSION}`)}`,
    dim(`  ${RULE}`),
    `     ${dim('Edge · Telegram bot · Mini App')}`,
    `     Role     ${cyan(ROLE_LABELS[role])}`,
    `     Author   ${bold('dizzzable')}`,
    `     GitHub   ${dim('github.com/dizzzable/reiwa')}`,
    cyan(`  ${WAVE}`),
    '',
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

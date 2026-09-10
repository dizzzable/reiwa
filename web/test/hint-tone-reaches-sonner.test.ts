/**
 * WHICH SONNER CALL A TONE ACTUALLY REACHES.
 *
 * `hint-tone-severity.test.ts` pins tone → severity and
 * `hint-toast-tone.test.ts` pins severity → the CSS that paints it. Both were
 * green while the middle link — severity → the sonner method — was free to be
 * anything: pointing all four entries of `SEVERITY_TOAST` at `toast.info`
 * passed the entire cabinet suite, and that is verbatim the defect the tone
 * files exist to prevent. "Your subscription has ended" in the same calm blue
 * as "here is what is new".
 *
 * This file lives in `web/test` deliberately. `sonner` is installed under
 * `web/node_modules` and the runner lives at the repository root, so a
 * `vi.mock('sonner')` from `test/` resolves to a different module id than the
 * one `hint-toast.ts` imports — the mock silently does not apply, nothing is
 * recorded, and every case fails for a reason unrelated to tones. Measured.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const raised: Array<{ readonly severity: string; readonly title: string }> = [];

const toastMock = vi.hoisted(() => {
  const record =
    (severity: string) =>
    (title: string) => {
      (globalThis as { __raised?: Array<{ severity: string; title: string }> }).__raised?.push({
        severity,
        title,
      });
      return `${severity}:${title}`;
    };
  return Object.assign(record('default'), {
    info: record('info'),
    success: record('success'),
    warning: record('warning'),
    error: record('error'),
    dismiss: vi.fn(),
  });
});
vi.mock('sonner', () => ({ toast: toastMock }));

(globalThis as { __raised?: unknown }).__raised = raised;

const { showHintToast } = await import('@/features/hints/hint-toast');
type Options = Parameters<typeof showHintToast>[0];

function draw(tone: string): void {
  showHintToast({
    hint: {
      key: 'tpl-x',
      title: 'Заголовок',
      body: 'Текст',
      mode: 'TOAST',
      tone,
      ctaKind: 'NONE',
      ctaLabel: null,
      ctaTarget: null,
    } as unknown as Options['hint'],
    t: ((key: string) => key) as unknown as Options['t'],
    navigate: vi.fn() as unknown as Options['navigate'],
    onAct: vi.fn(),
    onDismiss: vi.fn(),
    onExpire: vi.fn(),
  });
}

describe('the sonner call a hint tone reaches', () => {
  beforeEach(() => {
    raised.length = 0;
  });

  it.each([
    ['INFO', 'info'],
    ['SUCCESS', 'success'],
    ['WARNING', 'warning'],
    ['DANGER', 'error'],
  ])('raises %s through toast.%s', (tone, severity) => {
    draw(tone);

    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe(severity);
    expect(raised[0]?.title).toBe('Заголовок');
  });

  it('does not send every tone to the same call', () => {
    // Anti-collapse anchor. Four cases that each pass in isolation still
    // permit a table whose entries all point at one method IF each case only
    // checked "something was raised".
    for (const tone of ['INFO', 'SUCCESS', 'WARNING', 'DANGER']) {
      draw(tone);
    }

    expect(new Set(raised.map((entry) => entry.severity)).size).toBe(4);
  });
});

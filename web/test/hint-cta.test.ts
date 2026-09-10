/**
 * What the button on a pop-up does.
 *
 * The cabinet draws a hint two ways — a modal and a toast — and both hand the
 * decision to one function, on purpose: the modal used to carry its own opener
 * and got Telegram wrong, showing a `t.me` link as a landing page inside the
 * in-app browser instead of resolving it natively.
 *
 * Which made the EXTERNAL branch the interesting one, and it was the branch
 * nothing covered. A route can be eyeballed on any page; an external open only
 * misbehaves inside Telegram, where nobody is looking, and the failure is a
 * customer landing on a web page that says "open in Telegram".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openExternalUrl = vi.fn();
vi.mock('@/lib/utils', () => ({ openExternalUrl: (url: string) => openExternalUrl(url) }));

const { hasHintCta, runHintCta } = await import('@/features/hints/hint-cta');
type Hint = Parameters<typeof runHintCta>[0];

function hint(input: Partial<Hint>): Hint {
  return {
    key: 'tpl-x',
    title: 'Заголовок',
    body: 'Текст',
    mode: 'MODAL',
    tone: 'INFO',
    ctaKind: 'NONE',
    ctaLabel: null,
    ctaTarget: null,
    ...input,
  } as Hint;
}

describe("following a pop-up button", () => {
  beforeEach(() => {
    openExternalUrl.mockClear();
  });

  it('navigates inside the cabinet for a ROUTE', () => {
    const navigate = vi.fn();

    runHintCta(hint({ ctaKind: 'ROUTE', ctaTarget: '/renew', ctaLabel: 'Продлить' }), navigate as never);

    expect(navigate).toHaveBeenCalledWith('/renew');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('hands an EXTERNAL address to the shared opener, not to the router', () => {
    // THE BRANCH THAT WAS UNCOVERED. `openExternalUrl` is the only place in
    // the cabinet that knows a `t.me` link has to go through
    // `openTelegramLink`; a `navigate()` here, or a bare `window.open`, is the
    // bug this function was extracted to stop coming back.
    const navigate = vi.fn();

    runHintCta(
      hint({ ctaKind: 'EXTERNAL', ctaTarget: 'https://t.me/example_bot', ctaLabel: 'Открыть бота' }),
      navigate as never,
    );

    expect(openExternalUrl).toHaveBeenCalledWith('https://t.me/example_bot');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does nothing for a kind this build has not heard of', () => {
    // A newer panel can send one. Doing SOMETHING with it — navigating to the
    // raw target, say — is worse than doing nothing: the hint closes and
    // reports `acted`, so a dead button is recorded as the pop-up working.
    const navigate = vi.fn();

    runHintCta(hint({ ctaKind: 'DEEPLINK' as never, ctaTarget: '/anywhere' }), navigate as never);

    expect(navigate).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('does not draw a button for a kind it would not follow', () => {
    // The pair that keeps the two consistent: anything `hasHintCta` says yes
    // to, `runHintCta` must act on. A yes here with no branch there is exactly
    // the dead button above.
    for (const kind of ['ROUTE', 'EXTERNAL', 'NONE', 'DEEPLINK']) {
      const candidate = hint({
        ctaKind: kind as never,
        ctaTarget: '/somewhere',
        ctaLabel: 'Кнопка',
      });
      if (!hasHintCta(candidate)) continue;

      const navigate = vi.fn();
      openExternalUrl.mockClear();
      runHintCta(candidate, navigate as never);

      expect(
        navigate.mock.calls.length + openExternalUrl.mock.calls.length,
        `${kind} draws a button that does nothing`,
      ).toBe(1);
    }
  });

  it('draws no button without both a target and a label', () => {
    expect(hasHintCta(hint({ ctaKind: 'ROUTE', ctaTarget: '/renew', ctaLabel: null }))).toBe(false);
    expect(hasHintCta(hint({ ctaKind: 'ROUTE', ctaTarget: null, ctaLabel: 'Продлить' }))).toBe(false);
    expect(hasHintCta(hint({ ctaKind: 'ROUTE', ctaTarget: '', ctaLabel: 'Продлить' }))).toBe(false);
  });
});

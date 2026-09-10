/**
 * Which toast a tone is drawn as.
 *
 * Four tones arrive from the panel and each is drawn in its own colour with its
 * own icon — that IS the tone; nothing else carries it. A mapping that sends
 * DANGER to the info toast does not fail, does not warn, and does not look
 * wrong in a screenshot of one hint: it looks like a hint. The operator wrote
 * "your subscription has ended" and the customer reads it in the same calm blue
 * as "here is what is new".
 *
 * The pairs are asserted one by one rather than by counting keys, because two
 * entries swapped keeps the count, the type and the shape intact.
 *
 * The table lives apart from `hint-toast.ts` so this file does not pull
 * `sonner` in. The cabinet installs its front-end packages under `web/` and
 * this runner lives at the repository root, so a `vi.mock('sonner')` here
 * resolves to a different module id than the one `hint-toast.ts` imports: the
 * mock does not apply, nothing is recorded, and every case fails for a reason
 * that has nothing to do with the mapping. Measured, not assumed.
 */
import { describe, expect, it } from 'vitest';

import {
  HINT_TONE_RAIL,
  HINT_TONE_SEVERITY,
  railForTone,
  severityForTone,
} from '@/features/hints/hint-tone';

describe('the severity a hint tone is drawn as', () => {
  it.each([
    ['INFO', 'info'],
    ['SUCCESS', 'success'],
    ['WARNING', 'warning'],
    ['DANGER', 'error'],
  ])('draws %s as the %s toast', (tone, severity) => {
    expect(severityForTone(tone)).toBe(severity);
  });

  it('covers every tone the cabinet accepts, and nothing else', () => {
    // The type is a closed union of four; a fifth key here is a tone the API
    // client cannot produce, and a missing one is a tone that silently
    // downgrades to info.
    expect(Object.keys(HINT_TONE_SEVERITY).sort()).toEqual([
      'DANGER',
      'INFO',
      'SUCCESS',
      'WARNING',
    ]);
  });

  it('gives each tone a severity of its own', () => {
    // Anti-collapse anchor. Mapping all four to `info` satisfies every
    // "has an entry" check ever written and erases the tone completely.
    const severities = Object.values(HINT_TONE_SEVERITY);
    expect(new Set(severities).size).toBe(severities.length);
  });

  it('under-states a tone a newer panel invents, rather than over-stating it', () => {
    // The panel's vocabulary is not frozen and the two ship as separate
    // images. Falling back keeps the hint on screen; falling back to the
    // QUIETEST severity keeps an unknown tone from raising a false alarm.
    expect(severityForTone('CRITICAL')).toBe('info');
    expect(severityForTone('')).toBe('info');
  });
});

/**
 * THE MODAL AND THE TOAST MUST ANSWER "AN UNKNOWN TONE" THE SAME WAY.
 *
 * The stripe above a modal's title IS its tone; nothing else carries it. The
 * modal had its own table with `?? TONE_RULE.INFO` written at the use site,
 * which covers a tone that is merely unrecognised — but NOT one that happens to
 * name a member of `Object.prototype`. `table["constructor"]` is not
 * `undefined`; it is a function inherited through the prototype chain, so `??`
 * never fires. The modal then drew a stripe with no colour class at all, and
 * the toast — whose lookup fed that same function into sonner's table — got
 * `undefined` back and THREW before reaching the screen. One panel value, two
 * different wrong answers.
 *
 * Both tables are now read through one own-property lookup, so there is one
 * answer and these cases hold it.
 */
describe('the stripe a hint tone is drawn as', () => {
  it.each([
    ['INFO', 'bg-blue-500/70'],
    ['SUCCESS', 'bg-emerald-500/70'],
    ['WARNING', 'bg-amber-500/70'],
    ['DANGER', 'bg-(--brand-primary)/70'],
  ])('draws %s with its own rule', (tone, rail) => {
    expect(railForTone(tone)).toBe(rail);
  });

  it('gives each tone a rule of its own', () => {
    // Anti-collapse anchor, the same one the severity table carries: mapping
    // all four to the info blue satisfies every "has an entry" check and erases
    // the tone completely.
    const rails = Object.values(HINT_TONE_RAIL);
    expect(new Set(rails).size).toBe(rails.length);
  });

  it('covers exactly the tones the cabinet accepts', () => {
    expect(Object.keys(HINT_TONE_RAIL).sort()).toEqual([
      'DANGER',
      'INFO',
      'SUCCESS',
      'WARNING',
    ]);
  });

  it('falls back for a tone a newer panel invents, exactly as the toast does', () => {
    expect(railForTone('CRITICAL')).toBe(HINT_TONE_RAIL.INFO);
    expect(railForTone('')).toBe(HINT_TONE_RAIL.INFO);
  });

  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'answers %s with the fallback in BOTH tables, not with something off the prototype',
    (tone) => {
      // The one shape a plain `??` cannot catch. Left alone it reaches the DOM
      // as a stripe with no colour and sonner as a call to `undefined`.
      expect(railForTone(tone)).toBe(HINT_TONE_RAIL.INFO);
      expect(severityForTone(tone)).toBe('info');
    },
  );
});

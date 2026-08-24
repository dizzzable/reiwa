import { describe, expect, it } from 'vitest';

import { stripComments } from './source-scan.js';

/**
 * THE HELPER THAT EVERY SOURCE GUARD STANDS ON.
 *
 * `stripComments` decides what the Redis, Pool and push-icon guards are
 * allowed to see. When it removes too much they scan nothing, find nothing,
 * and pass — the worst possible direction for a mistake in a guard.
 *
 * That happened on 2026-08-24. The first implementation stripped block
 * comments before line comments, and `web/src/sw.ts` documents its routes as
 * `//   /support, /linking/*, /push/*, /realtime/*.` — three glob paths that a
 * regex reads as three block-comment openers. The file held seven `/*` against
 * one terminator, so the strip ran from the first glob to that terminator and
 * deleted the `WebPushPayload` interface on the way.
 */
describe('stripComments removes comments without eating code', () => {
  it('does not let a glob inside a LINE comment open a block comment', () => {
    // THE PRODUCTION DEFECT, in its smallest form.
    const source = [
      '// routes: /linking/*, /push/*, /realtime/*.',
      'interface Kept { readonly icon?: string }',
      '/** a real block comment */',
      'const x = 1',
    ].join('\n');

    const stripped = stripComments(source);

    expect(stripped).toContain('interface Kept');
    expect(stripped).toContain('const x = 1');
  });

  it('still removes what it is for', () => {
    // ANTI-VACUITY. `return source` would pass the spec above and turn every
    // guard into prose-matching: a comment mentioning `new Redis(` would read
    // as a construction site and the offender lists would fill with fiction.
    const source = ['/** talks about new Redis(url) */', "const y = 'kept'", '// new Pool(nothing)'].join('\n');

    const stripped = stripComments(source);

    expect(stripped).not.toContain('talks about');
    expect(stripped).not.toContain('new Pool(nothing)');
    expect(stripped).toContain("const y = 'kept'");
  });

  it('leaves a mid-line // alone so a URL in real code survives', () => {
    // Cutting every line at its first `//` turns `new Redis("redis://host")`
    // into `new Redis("redis:` and hides the offender shaped most like real
    // code — the exact false negative this helper must not produce.
    const source = 'const c = new Redis("redis://host:6379")';

    expect(stripComments(source)).toBe(source);
  });
});

describe('stripComments survives the shapes this repository actually contains', () => {
  it('does not let a JSDoc block swallow the code after it', () => {
    // THE SECOND DEFECT, found while fixing the first. Filtering ` *`
    // continuation lines removes the ` */` that terminates the block, leaving
    // `/**` unpaired — and the block strip then runs to whatever terminator it
    // finds next, taking real code with it. It deleted whole classes out of
    // `transport.ts`, and the guards over that file went quiet rather than red.
    const source = [
      '/**',
      ' * A doc block with a continuation line.',
      ' */',
      'class Kept {',
      '  method() { return 1 }',
      '}',
      '/** another */',
      'const after = 2',
    ].join('\n')

    const stripped = stripComments(source)

    expect(stripped).toContain('class Kept')
    expect(stripped).toContain('const after = 2')
    expect(stripped).not.toContain('continuation line')
  })

  it('removes both comment kinds when they sit next to each other', () => {
    const source = [
      '// line',
      '/** block */',
      'const both = 3',
    ].join('\n')

    const stripped = stripComments(source)

    expect(stripped).not.toContain('line')
    expect(stripped).not.toContain('block')
    expect(stripped).toContain('const both = 3')
  })
})

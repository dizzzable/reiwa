import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { sourceFiles, stripComments } from './source-scan.js';

/**
 * THE HELPER THAT EVERY SOURCE GUARD STANDS ON.
 *
 * `stripComments` decides what the Redis, Pool and push-icon guards are
 * allowed to see. When it removes too much they scan nothing, find nothing,
 * and pass — the worst possible direction for a mistake in a guard.
 *
 * That happened twice, both times to a regex that could not tell a comment
 * marker from text. On 2026-08-24 the first implementation stripped block
 * comments before line comments, and `web/src/sw.ts` documents its routes as
 * `//   /support, /linking/*, /push/*, /realtime/*.` — three glob paths that a
 * regex reads as three block-comment openers; the strip deleted the
 * `WebPushPayload` interface. On 2026-09-26 the fix for that turned out to
 * have been blind from its first day: `"https://*.telegram.org"` in the CSP of
 * `src/api/app.ts` opened a "comment" that the regex literal `/^\/assets\/.*\/`
 * closed 688 lines later — 451 of that file's 698 code lines, invisible to
 * both construction-site guards.
 *
 * The helper now takes its comments from the TypeScript parser. Each spec in
 * the third block below is a shape that defeats a regex, or a scanner that
 * guesses regex-versus-division from the previous token, with a forbidden call
 * AFTER the trap: a helper that falls for it loses the call and goes red.
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

  it('removes a JSDoc block that carries tags', () => {
    // The parser keeps JSDoc as nodes with tokens of their own. Walking into
    // them as if they were code would read `@deprecated` as a token and the
    // `/**` before it as an unclosed comment.
    const source = ['/**', ' * @deprecated use `Next` instead', ' * @param url where', ' */', 'function old(url: string) {}'].join('\n')

    const stripped = stripComments(source)

    expect(stripped).not.toContain('@deprecated')
    expect(stripped).toContain('function old(url: string) {}')
  })
})

describe('stripComments reads tokens: a comment marker inside one is text', () => {
  it('keeps a string holding /* and everything after it (the app.ts defect)', () => {
    // THE 2026-09-26 DEFECT, in its smallest form: a `/*` inside a CSP origin,
    // and the `*` `/` that closed the fake comment inside a route regex.
    const source = [
      'const frameAncestors = ["https://*.telegram.org"];',
      'const client = new Redis(url);',
      'app.get(/^\\/assets\\/.*/, serve);',
    ].join('\n');

    expect(stripComments(source)).toBe(source);
  });

  it('keeps comment markers inside strings', () => {
    const source = [
      "const a = '// not a comment';",
      'const b = "/* nor this";',
      'const client = new Redis(url);',
      "const c = 'nor this */';",
      '// a real one',
    ].join('\n');

    const stripped = stripComments(source);

    expect(stripped).toContain("'// not a comment'");
    expect(stripped).toContain('"/* nor this"');
    expect(stripped).toContain('new Redis(url)');
    expect(stripped).toContain("'nor this */'");
    expect(stripped).not.toContain('a real one');
  });

  it('keeps regex literals holding /* or //', () => {
    const source = [
      'const stars = /[/*]+/g;',
      'const client = new Redis(url);',
      'const doubled = /[//]{2}/;',
      '/** a real one */',
    ].join('\n');

    const stripped = stripComments(source);

    expect(stripped).toContain('/[/*]+/g');
    expect(stripped).toContain('new Redis(url)');
    expect(stripped).toContain('/[//]{2}/');
    expect(stripped).not.toContain('a real one');
  });

  it('keeps template literals whole, nested ones included, and strips a comment inside ${}', () => {
    // A shader in a template is the shape `web/src` really holds: its GLSL
    // comments start lines with `//`, and they are text of the string.
    const source = [
      'const route = `https://${host}/api/*`;',
      'const nested = `a ${`b ${"//"} /* c */`} d`;',
      'const client = new Redis(url);',
      'const shader = `',
      '// a GLSL comment is text of the template, not of the file',
      'void main() {}`;',
      'const inner = `x ${/* a real one */ y}`;',
    ].join('\n');

    const stripped = stripComments(source);

    expect(stripped).toContain('`https://${host}/api/*`');
    expect(stripped).toContain('`a ${`b ${"//"} /* c */`} d`');
    expect(stripped).toContain('new Redis(url)');
    expect(stripped).toContain('// a GLSL comment is text of the template, not of the file');
    expect(stripped).not.toContain('a real one');
    expect(stripped).toMatch(/`x \$\{\s+y\}`/);
  });

  it('keeps JSX text and attributes, and strips a {/* */} comment', () => {
    const source = [
      'const view = (',
      '  <a href="https://*.example.org" title="//">',
      '    {/* a real one */}',
      '    // text on the page, not a comment',
      '    /* also text */',
      '  </a>',
      ');',
      'const client = new Redis(url);',
      '/** a real two */',
    ].join('\n');

    const stripped = stripComments(source, 'view.tsx');

    expect(stripped).toContain('href="https://*.example.org" title="//"');
    expect(stripped).toContain('{ }');
    expect(stripped).toContain('// text on the page, not a comment');
    expect(stripped).toContain('/* also text */');
    expect(stripped).toContain('new Redis(url)');
    expect(stripped).not.toContain('a real');
    // No name needed: this does not read as .ts at all, so .tsx is the only
    // grammar left, and it is the one the helper takes.
    expect(stripComments(source)).toBe(stripped);
  });

  it('tells division from a regex the way the parser does', () => {
    // A `/` after `)` is division in `(a + b) / 2` and a regex after
    // `if (ready)`. A scanner that guesses from the previous token reads the
    // second one as division too, meets `/*` inside the class and loses the
    // line after it.
    const source = [
      'const half = (a + b) / 2 / /* a real one */ 1;',
      'if (ready) /[/*]/.test(input);',
      'const client = new Redis(url);',
      'const ratio = total / count; /* a real two */',
    ].join('\n');

    const stripped = stripComments(source);

    expect(stripped).toContain('(a + b) / 2 /');
    expect(stripped).toContain('if (ready) /[/*]/.test(input);');
    expect(stripped).toContain('new Redis(url)');
    expect(stripped).toContain('total / count;');
    expect(stripped).not.toContain('a real');
  });
});

describe('stripComments keeps the shape its callers rely on', () => {
  it('turns a comment into a space, so the tokens either side never fuse', () => {
    // Removing the comment outright would read `newRedis(url)`, which no
    // construction-site pattern matches.
    expect(stripComments('const c = new/**/Redis(url);')).toContain('new Redis(url)');
  });

  it('keeps every line where it was, and strips a comment at the end of a code line', () => {
    // Prose after code on the same line used to survive: a trailing
    // `// new Pool(prose)` read as a construction site.
    const source = [
      'const client = new Pool(origin); // new Pool(prose)',
      '/*',
      ' * three lines',
      ' */',
      'const after = 1;',
    ].join('\n');

    const lines = stripComments(source).split('\n');

    expect(lines).toHaveLength(5);
    expect(lines[0].trimEnd()).toBe('const client = new Pool(origin);');
    expect(lines[4]).toBe('const after = 1;');
  });

  it('returns LF line endings, as it always has', () => {
    expect(stripComments('const a = 1;\r\n// one\r\nconst b = 2;\r\n')).toBe('const a = 1;\n \nconst b = 2;\n');
  });
});

describe('stripComments refuses to guess', () => {
  it('throws on a source the parser cannot read, instead of stripping a guess', () => {
    expect(() => stripComments('const = ;')).toThrow(/cannot read/);
  });

  it('throws when .ts and .tsx disagree on where the comments are, and obeys a file name', () => {
    // As .ts this is a type assertion on `a`, and `// b</div>;` is a comment.
    // As .tsx it is an element, and `a // b` is its text. Both parse cleanly.
    const source = 'const x = <div>a // b</div>;\nconst y = 1;';

    expect(() => stripComments(source)).toThrow(/both as \.ts and as \.tsx/);
    expect(stripComments(source, 'x.tsx')).toContain('a // b');
    expect(stripComments(source, 'x.ts')).not.toContain('// b');
  });
});

describe('stripComments sees every token of every file the guards scan', () => {
  it('src/**/*.ts and web/src/sw.ts: the same program after the strip, and no comment left in it', () => {
    // The specs above are the shapes we know of. This one is the shape nobody
    // has written yet: whatever the next file under src/ holds. The parser
    // prints each file with comments dropped, before and after the strip; the
    // two must be the same program. Then the stripped file is printed WITH
    // comments, and there must be none to print.
    const bare = ts.createPrinter({ removeComments: true });
    const full = ts.createPrinter({ removeComments: false });
    const print = (printer: ts.Printer, text: string, name: string): string =>
      printer.printFile(ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true));

    const files = [...sourceFiles('src'), 'web/src/sw.ts'];
    expect(files.length).toBeGreaterThan(200);
    const changed: string[] = [];
    const commented: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const stripped = stripComments(text);
      const program = print(bare, stripped, file);
      if (program !== print(bare, text, file)) changed.push(file);
      if (stripped.split('\n').length !== text.split('\n').length) changed.push(`${file}: line count`);
      if (print(full, stripped, file) !== program) commented.push(file);
    }

    expect(changed).toEqual([]);
    expect(commented).toEqual([]);
  }, 60_000);
});

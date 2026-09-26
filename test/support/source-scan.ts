import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import ts from 'typescript';

/**
 * Helpers for guards that assert something about EVERY construction site in
 * `src/` rather than about the three or four that exist today.
 *
 * The failure mode these serve is always the same shape: a client, a pool, a
 * dispatcher built next year by someone who never read the incident that made
 * the options mandatory. A guard that names the known sites guards the past.
 */

/** Every `.ts` file under `dir`, recursively. */
export function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

/**
 * Removes comments so prose ABOUT a call is not read as the call.
 *
 * ── Tokenised by the TypeScript parser, not matched by a regex ───────────────
 *
 * Only the parser knows where a comment is. A `/*` is a comment opener only
 * where a token could start; inside a string, a template, a regex literal or
 * JSX text it is text. Every regex-based strip got that wrong, and it always
 * went wrong in the same direction: it deleted CODE, and a guard that scans
 * code it has accidentally deleted reports no offenders and passes.
 *
 *   - 2026-08-24: block comments stripped first. `web/src/sw.ts` documents its
 *     routes in a line comment (`/push/*, /realtime/*`); each glob opened a
 *     "comment", and the strip ate the `WebPushPayload` interface.
 *   - 2026-09-26: the fix for that (line comments first) was still a regex.
 *     `src/api/app.ts` allows `"https://*.telegram.org"` in its CSP; the `/*`
 *     in that STRING opened a "comment" that ran to the `*` `/` inside the
 *     REGEX `/^\/assets\/.*\/` 688 lines further down. 451 of the file's 698
 *     code lines (190-878) were invisible to the Redis and Pool guards from
 *     the day this helper was written: a bare `new Redis(` or `new Pool(`
 *     planted there passed both of them.
 *
 * ── What callers get ─────────────────────────────────────────────────────────
 *
 *   - Every comment is gone: `//` to the end of the line, `/* … *\/` and JSDoc,
 *     `{/* … *\/}` in JSX (the braces stay, they are code).
 *   - Everything else is kept byte for byte, including the `//` and `/*`
 *     inside strings, templates, regex literals and JSX text.
 *   - A comment becomes one space, or the line breaks it spanned. Line N of the
 *     result is line N of the file, and the tokens either side of a comment
 *     never fuse: `new/**\/Redis(url)` reads `new Redis(url)`, not `newRedis`.
 *   - Line endings come back as `\n`, as they always did.
 *
 * ── It refuses rather than guesses ───────────────────────────────────────────
 *
 * A source the parser cannot read without errors THROWS. So does one that reads
 * cleanly both as `.ts` and as `.tsx` with different comments: in
 * `const x = <div>a // b</div>;` the `// b</div>;` is a comment after the type
 * assertion `<div>a` as `.ts`, and the text of an element as `.tsx`.
 * Pass `fileName` and the extension picks the grammar; without it the helper
 * tries `.ts` and `.tsx` and needs them to agree. A red test that says "cannot
 * read this file" costs a minute; a guard that quietly skipped two thirds of a
 * file went unnoticed for a month.
 */
export function stripComments(source: string, fileName?: string): string {
  let result = '';
  let from = 0;
  for (const [start, end] of commentsOf(source, fileName)) {
    result += source.slice(from, start);
    let breaks = '';
    for (let at = start; at < end; at += 1) {
      if (ts.isLineBreak(source.charCodeAt(at))) breaks += source[at];
    }
    result += breaks === '' ? ' ' : breaks;
    from = end;
  }
  result += source.slice(from);
  return result.replace(/\r\n/g, '\n');
}

type Span = readonly [start: number, end: number];

/** The grammar each extension is written in. Anything else: try both TS grammars. */
const GRAMMAR_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': '.ts',
  '.mts': '.ts',
  '.cts': '.ts',
  '.tsx': '.tsx',
  '.js': '.js',
  '.mjs': '.js',
  '.cjs': '.js',
  '.jsx': '.jsx',
};

function commentsOf(source: string, fileName: string | undefined): readonly Span[] {
  const named = fileName === undefined ? undefined : GRAMMAR_BY_EXTENSION[extname(fileName).toLowerCase()];
  const label = fileName ?? 'this source';
  if (named !== undefined) {
    const parsed = parse(source, named);
    if (parsed.errors.length > 0) throw unreadable(label, [[named, parsed]]);
    return commentSpans(parsed.sourceFile);
  }

  const asTs = parse(source, '.ts');
  const asTsx = parse(source, '.tsx');
  const clean = [asTs, asTsx].filter((parsed) => parsed.errors.length === 0);
  if (clean.length === 0) {
    throw unreadable(label, [
      ['.ts', asTs],
      ['.tsx', asTsx],
    ]);
  }
  const [first, second] = clean.map((parsed) => commentSpans(parsed.sourceFile));
  if (second !== undefined && !sameSpans(first, second)) {
    throw new Error(
      `stripComments: ${label} reads cleanly both as .ts and as .tsx, and the two disagree on ` +
        'where its comments are. Pass the file name so the extension picks the grammar.',
    );
  }
  return first;
}

interface Parsed {
  readonly sourceFile: ts.SourceFile;
  readonly errors: readonly ts.Diagnostic[];
}

function parse(source: string, extension: string): Parsed {
  // A fixed, absolute name: the extension picks the grammar, and the one-file
  // program below finds the file under exactly the name it was given.
  const name = `/scanned${extension}`;
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: (requested) => (requested === name ? sourceFile : undefined),
    fileExists: (requested) => requested === name,
    readFile: () => undefined,
    writeFile: () => undefined,
    getDefaultLibFileName: () => '/lib.d.ts',
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (requested) => requested,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  // The parse errors, through the public API. The program holds this one file
  // and resolves nothing, so it adds no second parse.
  const program = ts.createProgram({
    rootNames: [name],
    options: { noLib: true, noResolve: true, types: [], allowJs: true },
    host,
  });
  return { sourceFile, errors: program.getSyntacticDiagnostics(sourceFile) };
}

function unreadable(label: string, attempts: ReadonlyArray<readonly [extension: string, parsed: Parsed]>): Error {
  const reasons = attempts.map(([extension, { sourceFile, errors }]) => {
    const [first] = errors;
    const { line } = sourceFile.getLineAndCharacterOfPosition(first.start ?? 0);
    return `as ${extension}, line ${line + 1}: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`;
  });
  return new Error(
    `stripComments cannot read ${label} (${reasons.join('; ')}). ` +
      'It refuses to guess where the comments are; pass the file name if the grammar is the problem.',
  );
}

/**
 * Where the comments are: whatever lies BETWEEN the tokens the parser produced.
 *
 * Each token covers its own text — a string, a template part, a regex literal,
 * a run of JSX text — so a comment marker inside one is never seen here. What
 * is left between two tokens can only be whitespace or comments; anything else
 * means this walk missed a token, and the helper throws instead of dropping it.
 */
function commentSpans(sourceFile: ts.SourceFile): readonly Span[] {
  const text = sourceFile.text;
  const spans: Span[] = [];
  let covered = ts.getShebang(text)?.length ?? 0;

  const between = (from: number, to: number): void => {
    let at = from;
    while (at < to) {
      const code = text.charCodeAt(at);
      if (ts.isWhiteSpaceLike(code)) {
        at += 1;
      } else if (text.startsWith('//', at)) {
        let end = at + 2;
        while (end < to && !ts.isLineBreak(text.charCodeAt(end))) end += 1;
        spans.push([at, end]);
        at = end;
      } else if (text.startsWith('/*', at)) {
        const close = text.indexOf('*/', at + 2);
        if (close < 0 || close + 2 > to) throw missedToken(at);
        spans.push([at, close + 2]);
        at = close + 2;
      } else {
        throw missedToken(at);
      }
    }
  };

  const missedToken = (at: number): Error => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(at);
    return new Error(
      `stripComments: line ${line + 1} holds ${JSON.stringify(text.slice(at, at + 20))} between two ` +
        'tokens, and it is neither whitespace nor a comment that ends before the next token. ' +
        'The token walk missed something; refusing to drop it.',
    );
  };

  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      // A JSDoc block is a comment the parser also keeps as a node. Its text
      // lies between two real tokens, and `between` takes it from there.
      return;
    }
    if (ts.isToken(node)) {
      // `getStart` skips the trivia before the token — and for JSX text, only
      // the whitespace: `// x` inside an element is text, not a comment.
      between(covered, node.getStart(sourceFile));
      covered = Math.max(covered, node.end);
      return;
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };

  visit(sourceFile);
  between(covered, text.length);
  return spans;
}

function sameSpans(a: readonly Span[], b: readonly Span[]): boolean {
  return a.length === b.length && a.every(([start, end], index) => b[index][0] === start && b[index][1] === end);
}

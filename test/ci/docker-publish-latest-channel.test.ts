import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * `:latest` IS THE RELEASE CHANNEL, AND ONLY A PUSHED `v*` TAG MOVES IT.
 *
 * `docker-compose.yml` and the README send every operator to
 * `ghcr.io/…/reiwa:latest`, so whatever `latest` points at is what the next
 * `docker compose pull` installs everywhere. Two separate settings in
 * `.github/workflows/docker-publish.yml` decide that, and each one has already
 * been wrong:
 *
 *  - the `type=raw,value=latest` line was `enable={{is_default_branch}}`, so
 *    every push to main published unreleased code as `latest`;
 *  - its replacement kept docker/metadata-action's default `flavor:
 *    latest=auto`, under which `type=ref,event=tag` adds `latest` for ANY tag
 *    ref on its own (metadata-action v6.2.0, src/meta.ts `procRefTag`; README
 *    "Latest tag"). A manual "Run workflow" on an old tag republished that old
 *    build as `latest`, while the comment above the line called it the only
 *    source.
 *
 * Nothing exercises this workflow before it publishes, and a wrong `enable` is
 * not an error to the action. So this spec reads the file and works out what
 * each trigger would publish. The slice of metadata-action it needs is modelled
 * below for the tag types this workflow uses; any other type, flavor entry or
 * expression fails the spec instead of being guessed at.
 *
 * The same spec guards rezeis (`rezeis-admin/test/docker-publish-latest-channel.spec.ts`):
 * the two workflows are changed together.
 */

const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/docker-publish.yml', import.meta.url),
  'utf8',
);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

// ── Reading the metadata step out of the workflow ────────────────────────────

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line: string): boolean {
  const text = line.trim();
  return text === '' || text.startsWith('#');
}

/**
 * The `with:` inputs of the workflow's one docker/metadata-action step, one
 * entry per line. A block scalar (`tags: |`) keeps its lines; blank lines and
 * `#` lines are dropped, as the action drops them (`getInputList(…, { comment:
 * '#' })` in src/context.ts).
 */
function metadataStepInputs(source: string): Map<string, string[]> {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const usesAt = lines.flatMap((line, index) =>
    /^\s*(?:-\s+)?uses:\s*docker\/metadata-action@/.test(line) ? [index] : [],
  );
  check(usesAt.length === 1, 'docker-publish.yml should run docker/metadata-action exactly once');
  const usesIndex = usesAt[0];
  const keyIndent = lines[usesIndex].indexOf('uses:');

  // The step is the list item that holds `uses:`: from its `- ` line down to
  // the first line that sits left of the step's keys.
  let start = usesIndex;
  while (start > 0 && !/^\s*-\s/.test(lines[start])) {
    start -= 1;
  }
  let end = usesIndex + 1;
  while (end < lines.length && (isBlankOrComment(lines[end]) || indentOf(lines[end]) >= keyIndent)) {
    end += 1;
  }

  const withIndex = lines.findIndex(
    (line, index) =>
      index >= start && index < end && line.indexOf('with:') === keyIndent && /with:\s*$/.test(line),
  );
  check(withIndex !== -1, 'the metadata step has no `with:` block');

  const inputs = new Map<string, string[]>();
  let childIndent: number | null = null;
  for (let index = withIndex + 1; index < end; index += 1) {
    const line = lines[index];
    if (isBlankOrComment(line)) {
      continue;
    }
    const indent = indentOf(line);
    if (indent <= keyIndent) {
      break;
    }
    childIndent ??= indent;
    check(indent === childIndent, `unexpected indentation in the metadata step, line ${index + 1}`);

    const entry = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    check(entry, `cannot read line ${index + 1} of the metadata step: ${line.trim()}`);
    const [, key, rest] = entry;

    if (rest === '|' || rest === '|-') {
      const values: string[] = [];
      let inner = index + 1;
      for (; inner < end; inner += 1) {
        if (lines[inner].trim() === '') {
          continue;
        }
        if (indentOf(lines[inner]) <= childIndent) {
          break;
        }
        if (!lines[inner].trim().startsWith('#')) {
          values.push(lines[inner].trim());
        }
      }
      inputs.set(key, values);
      index = inner - 1;
    } else if (/^[|>]/.test(rest)) {
      throw new Error(`unmodelled block scalar style \`${rest}\` for \`${key}\``);
    } else {
      inputs.set(key, [rest.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')]);
    }
  }
  return inputs;
}

/** Splits `a=1,b=${{ f(x, y) }}` on the commas GitHub leaves in place. */
function splitAttributes(line: string): string[] {
  check(!line.includes('"'), `unmodelled quoting in \`${line}\``);
  const fields: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < line.length; index += 1) {
    if (line.startsWith('${{', index)) {
      depth += 1;
      current += '${{';
      index += 2;
    } else if (depth > 0 && line.startsWith('}}', index)) {
      depth -= 1;
      current += '}}';
      index += 1;
    } else if (line[index] === ',' && depth === 0) {
      fields.push(current.trim());
      current = '';
    } else {
      current += line[index];
    }
  }
  fields.push(current.trim());
  return fields;
}

// ── What GitHub hands the action: `${{ }}` evaluated for one trigger ─────────

interface Trigger {
  /** `github.event_name` */
  readonly event: string;
  /** `github.ref` */
  readonly ref: string;
}

type Value = string | boolean | null;

interface Token {
  readonly kind: 'string' | 'operator' | 'name';
  readonly text: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:'((?:[^']|'')*)'|(&&|\|\||==|!=|[!(),])|([A-Za-z_][A-Za-z0-9_.-]*))/y;
  let index = 0;
  while (source.slice(index).trim() !== '') {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) {
      throw new Error(`cannot read the expression \`${source.trim()}\` at position ${index}`);
    }
    if (match[1] !== undefined) {
      tokens.push({ kind: 'string', text: match[1].replace(/''/g, "'") });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: 'operator', text: match[2] });
    } else {
      tokens.push({ kind: 'name', text: match[3] });
    }
    index = pattern.lastIndex;
  }
  return tokens;
}

/**
 * GitHub's expression language, as far as this workflow could use it: string
 * literals, `github.*` context values, `==`/`!=` (case-insensitive for strings,
 * as GitHub compares them), `!`, `&&`/`||` returning an operand, parentheses,
 * and `startsWith`/`endsWith` (case-insensitive too).
 */
function evaluateExpression(source: string, trigger: Trigger): Value {
  const tokens = tokenize(source);
  let position = 0;
  const isOperator = (text: string): boolean =>
    tokens[position]?.kind === 'operator' && tokens[position]?.text === text;
  const consume = (text: string): void => {
    if (!isOperator(text)) {
      throw new Error(`expected \`${text}\` in \`${source.trim()}\``);
    }
    position += 1;
  };
  const truthy = (value: Value): boolean => value !== false && value !== null && value !== '';
  const loose = (value: Value): Value => (typeof value === 'string' ? value.toLowerCase() : value);

  const context = (name: string): Value => {
    switch (name) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
      case 'github.event_name':
        return trigger.event;
      case 'github.ref':
        return trigger.ref;
      case 'github.ref_name':
        return trigger.ref.replace(/^refs\/(?:heads|tags)\//, '');
      case 'github.ref_type':
        return trigger.ref.startsWith('refs/tags/') ? 'tag' : 'branch';
      default:
        throw new Error(`unmodelled context \`${name}\` in \`${source.trim()}\``);
    }
  };

  const call = (name: string, args: readonly Value[]): Value => {
    if ((name === 'startsWith' || name === 'endsWith') && args.length === 2) {
      const haystack = String(args[0] ?? '').toLowerCase();
      const needle = String(args[1] ?? '').toLowerCase();
      return name === 'startsWith' ? haystack.startsWith(needle) : haystack.endsWith(needle);
    }
    throw new Error(`unmodelled function \`${name}\` in \`${source.trim()}\``);
  };

  const primary = (): Value => {
    const token = tokens[position];
    if (token === undefined) {
      throw new Error(`\`${source.trim()}\` ends too early`);
    }
    position += 1;
    if (token.kind === 'string') {
      return token.text;
    }
    if (token.kind === 'operator' && token.text === '(') {
      const value = or();
      consume(')');
      return value;
    }
    if (token.kind === 'name') {
      if (isOperator('(')) {
        consume('(');
        const args: Value[] = [or()];
        while (isOperator(',')) {
          consume(',');
          args.push(or());
        }
        consume(')');
        return call(token.text, args);
      }
      return context(token.text);
    }
    throw new Error(`unexpected \`${token.text}\` in \`${source.trim()}\``);
  };
  const unary = (): Value => {
    if (isOperator('!')) {
      consume('!');
      return !truthy(unary());
    }
    return primary();
  };
  const comparison = (): Value => {
    let left = unary();
    while (isOperator('==') || isOperator('!=')) {
      const equal = tokens[position].text === '==';
      position += 1;
      const same = loose(left) === loose(unary());
      left = equal ? same : !same;
    }
    return left;
  };
  const and = (): Value => {
    let left = comparison();
    while (isOperator('&&')) {
      consume('&&');
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  const or = (): Value => {
    let left = and();
    while (isOperator('||')) {
      consume('||');
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  };

  const value = or();
  if (position !== tokens.length) {
    throw new Error(`cannot read past \`${tokens[position].text}\` in \`${source.trim()}\``);
  }
  return value;
}

const DEFAULT_BRANCH = 'main';

/** A tag's `enable=` as the action receives it, then as it reads it. */
function isEnabled(raw: string, trigger: Trigger): boolean {
  const text = raw.trim();
  let rendered: string;
  const expression = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  if (expression) {
    // GitHub substitutes `${{ }}` before the action runs: true -> 'true'.
    rendered = String(evaluateExpression(expression[1], trigger) ?? '');
  } else if (text === '{{is_default_branch}}' || text === '{{is_not_default_branch}}') {
    // src/meta.ts `is_default_branch`: the ref with `refs/heads/` removed must
    // be the default branch, so every tag ref reads false.
    const onDefault = trigger.ref.replace(/^refs\/heads\//, '') === DEFAULT_BRANCH;
    rendered = String(text === '{{is_default_branch}}' ? onDefault : !onDefault);
  } else if (text.includes('{{')) {
    throw new Error(`unmodelled enable expression \`${raw}\``);
  } else {
    rendered = text;
  }
  // src/meta.ts getVersion: anything but 'true'/'false' is an error.
  check(rendered === 'true' || rendered === 'false', `metadata-action would refuse enable=${rendered}`);
  return rendered === 'true';
}

// ── What metadata-action publishes for one trigger ───────────────────────────

type LatestFlavor = 'auto' | 'true' | 'false';

/** src/flavor.ts: `latest` defaults to `auto`. Other flavor keys are not modelled. */
function latestFlavor(lines: readonly string[]): LatestFlavor {
  let latest: LatestFlavor = 'auto';
  for (const field of lines.flatMap(splitAttributes)) {
    const [key, value] = field.split('=').map((part) => part.trim());
    if (key.toLowerCase() === 'latest' && (value === 'auto' || value === 'true' || value === 'false')) {
      latest = value;
    } else {
      throw new Error(`unmodelled flavor entry \`${field}\``);
    }
  }
  return latest;
}

interface TagLine {
  readonly source: string;
  readonly type: string;
  readonly attrs: ReadonlyMap<string, string>;
}

/** src/tag.ts DefaultPriorities, for the types modelled here. */
const PRIORITY: Readonly<Record<string, number>> = { semver: 900, ref: 600, raw: 200, sha: 100 };

function parseTagLine(source: string): TagLine {
  const attrs = new Map<string, string>();
  let type = 'raw';
  for (const field of splitAttributes(source)) {
    const separator = field.indexOf('=');
    if (separator === -1) {
      attrs.set('value', field);
    } else if (field.slice(0, separator).trim().toLowerCase() === 'type') {
      type = field.slice(separator + 1).trim();
    } else {
      attrs.set(field.slice(0, separator).trim().toLowerCase(), field.slice(separator + 1).trim());
    }
  }
  if (!(type in PRIORITY)) {
    throw new Error(`unmodelled tag type \`${type}\` in \`${source}\``);
  }
  return { source, type, attrs };
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * The tag names the action outputs (image prefix left off), following
 * src/meta.ts getVersion / setVersion / generateTags: the first name is the
 * version, later ones are partials, and the FIRST line that sets a version also
 * decides the `latest` flag — `auto` means true for `ref,event=tag` and a
 * non-prerelease semver, false for `ref,event=branch`, `raw` and `sha`.
 */
function publishedTags(tagLines: readonly string[], flavor: LatestFlavor, trigger: Trigger): string[] {
  const tags = tagLines
    .map(parseTagLine)
    .sort((left, right) => PRIORITY[right.type] - PRIORITY[left.type]);
  let main: string | undefined;
  const partial: string[] = [];
  let latest: boolean | undefined;
  const setVersion = (name: string, auto: boolean): void => {
    if (name.length === 0) {
      return;
    }
    if (main === undefined) {
      main = name;
    } else if (name !== main) {
      partial.push(name);
    }
    latest ??= flavor === 'auto' ? auto : flavor === 'true';
  };
  const affixed = (tag: TagLine, name: string, defaultPrefix = ''): string =>
    `${tag.attrs.get('prefix') ?? defaultPrefix}${name}${tag.attrs.get('suffix') ?? ''}`;

  for (const tag of tags) {
    if (!isEnabled(tag.attrs.get('enable') ?? 'true', trigger)) {
      continue;
    }
    switch (tag.type) {
      case 'ref': {
        const event = tag.attrs.get('event');
        if (event === 'branch' && trigger.ref.startsWith('refs/heads/')) {
          setVersion(affixed(tag, trigger.ref.slice('refs/heads/'.length)), false);
        } else if (event === 'tag' && trigger.ref.startsWith('refs/tags/')) {
          setVersion(affixed(tag, trigger.ref.slice('refs/tags/'.length)), true);
        } else if (event !== 'branch' && event !== 'tag') {
          throw new Error(`unmodelled ref event in \`${tag.source}\``);
        }
        break;
      }
      case 'semver': {
        if (tag.attrs.has('value') || tag.attrs.has('match')) {
          throw new Error(`unmodelled semver attributes in \`${tag.source}\``);
        }
        const version = SEMVER.exec(trigger.ref.replace(/^refs\/tags\//, ''));
        // Not a tag ref, or not valid semver (every four-part tag): no name, no flag.
        if (!trigger.ref.startsWith('refs/tags/') || !version) {
          break;
        }
        const [, major, minor, patch, prerelease] = version;
        const rendered = (tag.attrs.get('pattern') ?? '')
          .replace(/\{\{\s*version\s*\}\}/g, version[0].replace(/^v/, ''))
          .replace(/\{\{\s*major\s*\}\}/g, major)
          .replace(/\{\{\s*minor\s*\}\}/g, minor)
          .replace(/\{\{\s*patch\s*\}\}/g, patch);
        if (rendered.includes('{{')) {
          throw new Error(`unmodelled semver pattern in \`${tag.source}\``);
        }
        setVersion(affixed(tag, prerelease ? version[0].replace(/^v/, '') : rendered), !prerelease);
        break;
      }
      case 'raw': {
        const value = tag.attrs.get('value') ?? '';
        if (value.includes('{{')) {
          throw new Error(`unmodelled raw value in \`${tag.source}\``);
        }
        setVersion(affixed(tag, value), false);
        break;
      }
      case 'sha': {
        setVersion(affixed(tag, 'abc1234', 'sha-'), false);
        break;
      }
    }
  }

  if (main === undefined) {
    return [];
  }
  const names = [main, ...partial.filter((name, index) => partial.indexOf(name) === index)];
  return latest === true ? [...names, 'latest'] : names;
}

// ── The workflow ─────────────────────────────────────────────────────────────

const INPUTS = metadataStepInputs(WORKFLOW);
const TAG_LINES = INPUTS.get('tags') ?? [];
const FLAVOR_LINES = INPUTS.get('flavor') ?? [];

function publishedBy(trigger: Trigger): string[] {
  return publishedTags(TAG_LINES, latestFlavor(FLAVOR_LINES), trigger);
}

describe('docker-publish.yml: only a pushed v* tag moves :latest', () => {
  it('finds the metadata step and its tag lines', () => {
    // Anti-emptiness: a parser that found nothing would agree that nothing
    // publishes `latest`.
    expect(INPUTS.has('images'), 'the metadata step has no `images` input').toBe(true);
    expect(TAG_LINES.length, `read ${TAG_LINES.length} tag lines out of the metadata step`).toBeGreaterThanOrEqual(4);
  });

  it('switches off the automatic latest, so the tag lines are the only source', () => {
    expect(
      latestFlavor(FLAVOR_LINES),
      'the metadata step has no `flavor: latest=false`. Under the default `latest=auto`, ' +
        '`type=ref,event=tag` adds `latest` for any tag ref by itself (metadata-action ' +
        'src/meta.ts procRefTag), so a manual run on an old tag republishes it as the release.',
    ).toBe('false');
  });

  it('names latest in one raw tag line and nowhere else', () => {
    const naming = TAG_LINES.filter((line) => /latest/i.test(line));
    expect(naming, 'lines naming latest').toHaveLength(1);
    const tag = parseTagLine(naming[0]);
    expect(tag.type).toBe('raw');
    expect(tag.attrs.get('value')).toBe('latest');
    expect(
      tag.attrs.get('enable') ?? '',
      '`latest` follows the default branch again: every push to main becomes the release',
    ).not.toMatch(/default_branch/);
  });

  it('publishes latest when a release tag is pushed', () => {
    const published = publishedBy({ event: 'push', ref: 'refs/tags/v9.8.7.6' });
    expect(published).toContain('v9.8.7.6');
    expect(
      published,
      'a pushed release tag no longer moves latest, so operators stop receiving releases',
    ).toContain('latest');
  });

  it('publishes no latest for a push to main', () => {
    const published = publishedBy({ event: 'push', ref: 'refs/heads/main' });
    expect(published).toContain('main');
    expect(published, 'a push to main publishes unreleased code as latest').not.toContain('latest');
  });

  for (const ref of ['refs/tags/v9.8.7.5', 'refs/tags/not-a-release', 'refs/heads/main']) {
    it(`publishes no latest for a manual run on ${ref}`, () => {
      const published = publishedBy({ event: 'workflow_dispatch', ref });
      expect(published.length, 'a manual run publishes nothing at all').toBeGreaterThan(0);
      expect(published, `Run workflow on ${ref} moves latest to that build`).not.toContain('latest');
    });
  }
});

describe('the metadata-action model agrees with the action', () => {
  // The cases above only mean something if the model CAN produce latest from
  // each source. These are the action's own documented outcomes.
  const push = (ref: string): Trigger => ({ event: 'push', ref });

  it('adds latest for a tag ref under the default flavor (README: refs/tags/v1.2.3 gives v1.2.3, latest)', () => {
    expect(publishedTags(['type=ref,event=tag'], 'auto', push('refs/tags/v1.2.3'))).toEqual(['v1.2.3', 'latest']);
    // A four-part tag is not semver, and ref,event=tag adds latest all the same.
    expect(publishedTags(['type=ref,event=tag'], 'auto', push('refs/tags/v9.8.7.6'))).toEqual([
      'v9.8.7.6',
      'latest',
    ]);
  });

  it('adds none for a branch, and none at all under latest=false', () => {
    expect(publishedTags(['type=ref,event=branch'], 'auto', push('refs/heads/main'))).toEqual(['main']);
    expect(publishedTags(['type=ref,event=tag'], 'false', push('refs/tags/v1.2.3'))).toEqual(['v1.2.3']);
  });

  it('follows a raw latest line only where its enable holds', () => {
    const lines = ['type=ref,event=branch', 'type=raw,value=latest,enable={{is_default_branch}}'];
    expect(publishedTags(lines, 'false', push('refs/heads/main'))).toEqual(['main', 'latest']);
    expect(publishedTags(lines, 'false', push('refs/heads/feature'))).toEqual(['feature']);
    const guarded = [
      'type=ref,event=tag',
      "type=raw,value=latest,enable=${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}",
    ];
    expect(publishedTags(guarded, 'false', push('refs/tags/v9.8.7.6'))).toEqual(['v9.8.7.6', 'latest']);
    expect(publishedTags(guarded, 'false', { event: 'workflow_dispatch', ref: 'refs/tags/v9.8.7.6' })).toEqual([
      'v9.8.7.6',
    ]);
  });

  it('refuses expressions it does not model instead of guessing', () => {
    expect(() =>
      publishedTags(
        ["type=raw,value=latest,enable=${{ github.base_ref == 'main' }}"],
        'false',
        push('refs/heads/main'),
      ),
    ).toThrow(/unmodelled context/);
  });
});

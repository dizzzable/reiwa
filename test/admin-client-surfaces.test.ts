/**
 * Each process tells the panel which one it is, and each keeps what the panel
 * says about itself.
 *
 *  - `src/api/main.ts` builds its `AdminClient` as `surface: "api"`, the bot's
 *    as `'bot'`, the worker's as `"worker"` — and so does any client built in
 *    `src/` later. A client built without a surface sends no identity at all,
 *    and the panel reads it as a cabinet from before the headers: the top-up
 *    «до сброса» withheld from a cabinet that shows it correctly.
 *  - The API's and the bot's version polls hand the panel's `panel` block to
 *    `panelRecorder`, under their own consumer names.
 *  - On the wire, each surface sends the capabilities of its own areas.
 *
 * The mains are scripts that start servers when imported, so their wiring is
 * read through the TypeScript parser, as `test/bot/main-config-wiring.test.ts`
 * does: a commented-out line is not code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { declaredCapabilities, type ReiwaSurface } from '../src/core/capabilities.js';
import { REIWA_BUILD_INFO } from '../src/core/version.js';
import { AdminClient } from '../src/infrastructure/admin-client/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(join(ROOT, path), 'utf8'), ts.ScriptTarget.Latest, true);
}

function nodesOf(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Every `new AdminClient(…)` in a file. */
function clientConstructions(file: ts.SourceFile): ts.NewExpression[] {
  return nodesOf(file)
    .filter(ts.isNewExpression)
    .filter((call) => call.expression.getText(file) === 'AdminClient');
}

/** The `surface` a construction passes in its 4th argument, or `null` when it passes none. */
function surfaceOf(call: ts.NewExpression, file: ts.SourceFile): string | null {
  const options = call.arguments?.[3];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return null;
  const surface = options.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText(file) === 'surface',
  );
  return surface !== undefined && ts.isStringLiteral(surface.initializer) ? surface.initializer.text : null;
}

const MAINS: ReadonlyArray<readonly [path: string, surface: ReiwaSurface]> = [
  ['src/api/main.ts', 'api'],
  ['src/bot/main.ts', 'bot'],
  ['src/worker/main.ts', 'worker'],
];

describe('each main speaks for its own process', () => {
  it.each(MAINS)('%s builds its one client as surface %s', (path, surface) => {
    const file = parse(path);
    const constructions = clientConstructions(file);
    expect(constructions).toHaveLength(1);
    expect(surfaceOf(constructions[0]!, file)).toBe(surface);
  });

  it('every client built anywhere in src/ names its surface', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(ROOT, dir))) {
        const path = `${dir}/${entry}`;
        if (statSync(join(ROOT, path)).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk('src');
    const unnamed: string[] = [];
    let constructions = 0;
    for (const path of files) {
      const file = parse(path);
      for (const call of clientConstructions(file)) {
        constructions += 1;
        if (surfaceOf(call, file) === null) unnamed.push(`${path}: ${call.getText(file).replace(/\s+/g, ' ')}`);
      }
    }
    // The three mains at least: a walk that found nothing would pass vacuously.
    expect(constructions).toBeGreaterThanOrEqual(3);
    expect(unnamed).toEqual([]);
  });

  it.each([
    ['src/api/main.ts', 'api'],
    ['src/bot/main.ts', 'bot'],
  ] as const)('%s keeps what the panel says about itself, as consumer %s', (path, consumer) => {
    const file = parse(path);
    const polls = nodesOf(file)
      .filter(ts.isNewExpression)
      .filter((call) => call.expression.getText(file) === 'ConfigVersionPoller');
    expect(polls).toHaveLength(1);
    const options = polls[0]!.arguments?.[0];
    expect(options !== undefined && ts.isObjectLiteralExpression(options)).toBe(true);
    const property = (name: string): ts.PropertyAssignment | undefined =>
      (options as ts.ObjectLiteralExpression).properties.find(
        (candidate): candidate is ts.PropertyAssignment =>
          ts.isPropertyAssignment(candidate) && candidate.name.getText(file) === name,
      );
    expect(property('consumer')?.initializer.getText(file)).toMatch(new RegExp(`^["']${consumer}["']$`));
    const onPanel = property('onPanel')?.initializer;
    expect(onPanel !== undefined && ts.isCallExpression(onPanel)).toBe(true);
    const recorder = onPanel as ts.CallExpression;
    expect(recorder.expression.getText(file)).toBe('panelRecorder');
    expect(recorder.arguments[1]?.getText(file).replace(/\s+/g, ' ')).toMatch(
      new RegExp(`^\\{ consumer: ["']${consumer}["'], logger \\}$`),
    );
  });
});

/** A panel that answers everything with `{}` and keeps what it was sent. */
interface Panel {
  readonly url: string;
  readonly headers: Array<Record<string, string | string[] | undefined>>;
  readonly server: Server;
}

const panels: Panel[] = [];
const clients: AdminClient[] = [];

async function startPanel(): Promise<Panel> {
  const headers: Panel['headers'] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const panel = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers, server };
  panels.push(panel);
  return panel;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const panel of panels.splice(0)) {
    panel.server.closeAllConnections();
    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  }
});

describe('on the wire, per surface', () => {
  it.each(['api', 'bot', 'worker'] as const)('surface %s sends its own capabilities and this build', async (surface) => {
    const panel = await startPanel();
    const client = new AdminClient(panel.url, 'internal-token', undefined, { surface });
    clients.push(client);

    await client.system.test();

    const [sent] = panel.headers;
    expect(sent!['x-reiwa-capabilities']).toBe(declaredCapabilities(surface).join(','));
    const pairs = Object.fromEntries(
      String(sent!['x-reiwa-client'])
        .split('; ')
        .map((pair) => pair.split('=') as [string, string]),
    );
    expect(pairs['surface']).toBe(surface);
    expect(pairs['version']).toBe(REIWA_BUILD_INFO.version);
    // The container's hostname: `reiwa`, `reiwa-bot` in production.
    const host = hostname();
    if (/^[\w.+-]{1,64}$/.test(host)) expect(pairs['instance']).toBe(host);
  });

  it('a client built without options sends no identity', async () => {
    const panel = await startPanel();
    const client = new AdminClient(panel.url, 'internal-token');
    clients.push(client);

    await client.system.test();

    expect(panel.headers[0]!['x-reiwa-client']).toBeUndefined();
    expect(panel.headers[0]!['x-reiwa-capabilities']).toBeUndefined();
  });
});

/**
 * EVERY CALL TO THE PANEL IS WHAT IT WAS, PLUS TWO HEADERS.
 *
 * The identity (`core/capabilities.ts`) must not change what any flow sends an
 * older panel: not a path, not a body field, not another header. An older
 * panel answers 400 to a body field it has not learned, and a panel without a
 * route answers 404, so either would break a flow that worked yesterday.
 *
 * Every method of every namespace on `AdminClient` is called twice with the
 * same arguments — once on a client built as `surface: 'api'`, once on one
 * built with no surface — and the two dispatches are compared field by field.
 * The pools are replaced by a recorder, so this sees exactly what undici is
 * handed, and the clock is fixed so the signatures match too. Nothing else
 * reaches the network: each namespace talks to the panel only through its
 * transport (checked at the end).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { declaredCapabilities } from '../../../src/core/capabilities.js';
import { AdminClient } from '../../../src/infrastructure/admin-client/index.js';
import { stripComments } from '../../support/source-scan.js';

interface Dispatch {
  readonly pool: 'pool' | 'streamPool';
  readonly method: unknown;
  readonly path: unknown;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly rest: Record<string, unknown>;
}

/** What undici's `Pool.request` resolves with, as far as the transport reads it. */
function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: {
      text: async () => '{}',
      json: async () => ({}),
      resume: () => undefined,
      on: () => undefined,
      pipe: () => undefined,
      async *[Symbol.asyncIterator]() {
        // An empty stream.
      },
    },
  };
}

interface Instrumented {
  readonly client: AdminClient;
  readonly dispatched: Dispatch[];
  close(): Promise<void>;
}

/** A client whose two pools are recorders. The real pools never connected; they are closed at the end. */
function instrumented(surface: 'api' | null): Instrumented {
  const client =
    surface === null
      ? new AdminClient('http://panel.test', 'internal-token', 'shared-secret')
      : new AdminClient('http://panel.test', 'internal-token', 'shared-secret', { surface });
  const transport = (client as unknown as { transport: Record<'pool' | 'streamPool', unknown> }).transport;
  const originals = [transport.pool, transport.streamPool] as Array<{ close(): Promise<void> }>;
  const dispatched: Dispatch[] = [];
  for (const pool of ['pool', 'streamPool'] as const) {
    transport[pool] = {
      request: async (options: Record<string, unknown>) => {
        const { method, path, headers, body, ...rest } = options;
        // As text: a header built from a stand-in argument is the stand-in
        // itself, and two stand-ins with the same label are equal only as text.
        const text = Object.fromEntries(
          Object.entries(headers as Record<string, unknown>).map(([name, value]) => [name, String(value)]),
        );
        dispatched.push({ pool, method, path, headers: text, body, rest });
        return fakeResponse();
      },
      close: async () => undefined,
    };
  }
  return {
    client,
    dispatched,
    close: async () => {
      await Promise.all(originals.map((pool) => pool.close()));
    },
  };
}

/**
 * An argument that serves as anything: a string where one is formatted
 * (`encodeURIComponent`, a template), an object with every field, a function,
 * a list. Its text names where it was read from, so two runs with the same
 * arguments build the same request, and a request built from it shows which
 * argument went where.
 */
function deep(label: string): unknown {
  return anything(label);
}

/**
 * An argument whose every field is a string: what a namespace needs where it
 * checks `typeof identity.userId === 'string'` before it builds the path.
 */
function flat(label: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === Symbol.toPrimitive) return (hint: string) => (hint === 'number' ? 7 : label);
        if (key === 'toJSON' || key === 'toString' || key === 'valueOf') return () => label;
        if (key === 'then' || typeof key === 'symbol') return undefined;
        return `${label}.${key}`;
      },
      has: () => true,
      ownKeys: () => [],
      getOwnPropertyDescriptor: () => undefined,
    },
  );
}

const STAND_INS = { deep, flat } as const;
type StandIn = keyof typeof STAND_INS;

function anything(label: string): unknown {
  const target = (() => undefined) as unknown as object;
  return new Proxy(target, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return (hint: string) => (hint === 'number' ? 7 : label);
      if (key === 'toJSON' || key === 'toString' || key === 'valueOf') return () => label;
      if (key === 'then') return undefined;
      if (key === Symbol.iterator) {
        return function* () {
          yield anything(`${label}[0]`);
        };
      }
      if (key === 'length') return 1;
      if (typeof key === 'symbol') return undefined;
      return anything(`${label}.${key}`);
    },
    apply: () => anything(`${label}()`),
    has: () => true,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

type Route = readonly string[];

/** Every callable on the facade: `system.test`, `linking.telegram.generate`, `openStream`, … */
function routesOf(client: AdminClient): Route[] {
  const routes: Route[] = [['openStream']];
  const walk = (value: object, route: Route, depth: number): void => {
    const prototype = Object.getPrototypeOf(value) as object;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      if (typeof (value as Record<string, unknown>)[name] === 'function') routes.push([...route, name]);
    }
    if (depth > 0) return;
    for (const [name, child] of Object.entries(value)) {
      if (name === 'transport' || typeof child !== 'object' || child === null) continue;
      walk(child as object, [...route, name], depth + 1);
    }
  };
  for (const [name, namespace] of Object.entries(client)) {
    if (name === 'transport' || typeof namespace !== 'object' || namespace === null) continue;
    walk(namespace as object, [name], 0);
  }
  return routes;
}

async function invoke(client: AdminClient, route: Route, standIn: StandIn): Promise<string> {
  let owner: unknown = client;
  for (const step of route.slice(0, -1)) owner = (owner as Record<string, unknown>)[step];
  const method = (owner as Record<string, (...args: unknown[]) => unknown>)[route[route.length - 1]!]!;
  const args = Array.from({ length: Math.max(method.length, 3) }, (_, index) => STAND_INS[standIn](`arg${index}`));
  try {
    await method.apply(owner, args);
    return 'resolved';
  } catch (err: unknown) {
    return `rejected: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const IDENTITY_HEADERS = ['x-reiwa-client', 'x-reiwa-capabilities'];

let identified: Instrumented;
let silent: Instrumented;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_800_000_000_000);
  identified = instrumented('api');
  silent = instrumented(null);
});

afterEach(async () => {
  vi.useRealTimers();
  await identified.close();
  await silent.close();
});

describe('every AdminClient method, with and without an identity', () => {
  it('sends the same requests apart from the two headers', async () => {
    const routes = routesOf(identified.client);
    // A walk that found nothing would pass vacuously: 165 methods on 26.09.2026.
    expect(routes.length).toBeGreaterThan(150);

    const silentRoutes: string[] = [];
    let compared = 0;
    for (const route of routes) {
      const name = route.join('.');
      // The first stand-in that gets the call onto the wire without an
      // identity is the one both clients are compared on.
      let standIn: StandIn = 'deep';
      let outcomeWithout = '';
      let withoutIdentity: Dispatch[] = [];
      for (const candidate of Object.keys(STAND_INS) as StandIn[]) {
        const before = silent.dispatched.length;
        standIn = candidate;
        outcomeWithout = await invoke(silent.client, route, candidate);
        withoutIdentity = silent.dispatched.slice(before);
        if (withoutIdentity.length > 0) break;
      }
      const before = identified.dispatched.length;
      const outcomeWith = await invoke(identified.client, route, standIn);
      const withIdentity = identified.dispatched.slice(before);

      expect(outcomeWith, name).toBe(outcomeWithout);
      expect(withIdentity.length, name).toBe(withoutIdentity.length);
      if (withIdentity.length === 0) silentRoutes.push(`${name} → ${outcomeWith}`);

      withIdentity.forEach((dispatch, index) => {
        const twin = withoutIdentity[index]!;
        const { [IDENTITY_HEADERS[0]!]: client, [IDENTITY_HEADERS[1]!]: capabilities, ...otherHeaders } = dispatch.headers;
        // The two headers, exactly — and nothing else differs.
        expect(client, name).toMatch(/^surface=api; version=[^;]+; commit=[^;]+; instance=[^;]+$/);
        expect(capabilities, name).toBe(declaredCapabilities('api').join(','));
        expect(otherHeaders, name).toEqual(twin.headers);
        expect(Object.keys(otherHeaders), name).toEqual(Object.keys(twin.headers));
        expect(dispatch.pool, name).toBe(twin.pool);
        expect(dispatch.method, name).toBe(twin.method);
        expect(dispatch.path, name).toBe(twin.path);
        expect(dispatch.body, name).toEqual(twin.body);
        expect(dispatch.rest, name).toEqual(twin.rest);
        expect(twin.headers['x-reiwa-client'], name).toBeUndefined();
        compared += 1;
      });
    }

    // Every method reaches the wire with one of the stand-ins. One that stops
    // before it would be compared on its outcome alone, so it is named here
    // and a stand-in that satisfies it is added above.
    expect(silentRoutes).toEqual([]);
    expect(compared).toBeGreaterThanOrEqual(routes.length);
  });
});

describe('the namespaces reach the panel only through the transport', () => {
  it('no namespace builds its own client, pool or fetch', () => {
    const dir = fileURLToPath(new URL('../../../src/infrastructure/admin-client/namespaces/', import.meta.url));
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(25);
    const offenders = files.filter((name) =>
      /\bfetch\(|from ['"]undici['"]|new Pool\(|node:http/.test(stripComments(readFileSync(join(dir, name), 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });
});

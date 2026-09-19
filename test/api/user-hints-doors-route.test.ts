import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createUserHintsRouter } from '../../src/api/routes/user-hints.js';

/**
 * The ask for the next pop-up declares the DOORS this cabinet opens.
 *
 * `api/user-hints-route.test.ts` stubs `next` as `next(input) => …` and so
 * sees only the body; `hint-doors-are-declared.test.ts` reads the route's
 * TEXT. Neither would notice the doors being declared in the source and then
 * never handed to the call, which is what this reads: every argument the route
 * gives the namespace, in order.
 */

type Next = (input: Record<string, unknown>, modes?: readonly string[], doors?: readonly string[]) => Promise<unknown>;

function drive(app: express.Express, body: unknown): Promise<{ status: number; json: unknown }> {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1', configurable: true });
  const request = new IncomingMessage(socket);
  const raw = JSON.stringify(body);
  request.method = 'POST';
  request.url = '/api/v1/hints/next';
  request.headers = {
    host: '127.0.0.1',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  const response = new ServerResponse(request);
  const chunks: string[] = [];
  const settled = new Promise<{ status: number; json: unknown }>((resolve) => {
    (response as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
      if (chunk !== undefined && chunk !== null) chunks.push(String(chunk));
      return true;
    };
    (response as unknown as { end: unknown }).end = (chunk?: unknown): ServerResponse => {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) chunks.push(String(chunk));
      const text = chunks.join('');
      resolve({ status: response.statusCode, json: text.length > 0 ? JSON.parse(text) : undefined });
      return response;
    };
  });
  (app as unknown as (a: IncomingMessage, b: ServerResponse) => void)(request, response);
  request.push(raw);
  request.push(null);
  return settled;
}

function makeApp(next: Next) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, proceed) => {
    req.webSession = { userId: 'user-1', createdAt: 0, ip: '127.0.0.1', lastActivity: 0 };
    proceed();
  });
  app.use(
    '/api/v1',
    createUserHintsRouter({
      adminClient: { userHints: { next } } as never,
      sessionStore: null,
    }),
  );
  return app;
}

describe('POST /hints/next declares the doors', () => {
  it('hands the namespace the doors as the THIRD argument, after the modes', async () => {
    const next = vi.fn<Next>(async () => ({ hint: null }));

    const reply = await drive(makeApp(next), { surface: 'pwa', formFactor: 'mobile', locale: 'ru' });

    expect(reply).toEqual({ status: 200, json: { hint: null } });
    expect(next).toHaveBeenCalledTimes(1);
    const [input, modes, doors] = next.mock.calls[0] as Parameters<Next>;
    expect(doors, 'the doors never reached the call — the panel holds every @connect pop-up back').toEqual([
      '@connect',
    ]);
    // The modes keep their place, and neither list leaks into the body.
    expect(modes).toEqual(['MODAL', 'TOAST']);
    expect(JSON.stringify(input)).not.toContain('@connect');
    expect(JSON.stringify(input)).not.toContain('MODAL');
  });

  it('cannot be widened from the browser', async () => {
    // The body is the audience, and only the audience: a browser naming doors
    // of its own must not change what this image declares.
    const next = vi.fn<Next>(async () => ({ hint: null }));

    await drive(makeApp(next), { surface: 'pwa', doors: ['@anything'], modes: ['BANNER'] });

    const [input, modes, doors] = next.mock.calls[0] as Parameters<Next>;
    expect(doors).toEqual(['@connect']);
    expect(modes).toEqual(['MODAL', 'TOAST']);
    expect(JSON.stringify(input)).not.toContain('@anything');
  });
});

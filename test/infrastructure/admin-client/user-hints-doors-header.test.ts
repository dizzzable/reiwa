import { describe, expect, it, vi } from 'vitest';

import {
  HINT_DOORS_HEADER,
  HINT_MODES_HEADER,
  UserHintsNamespace,
} from '../../../src/infrastructure/admin-client/namespaces/user-hints.js';

/**
 * THE DOORS TRAVEL IN THEIR OWN HEADER, BESIDE THE MODES — NEVER IN THE BODY.
 *
 * A door is a symbolic pop-up button target — `@connect`, «Подключить» as the
 * dashboard means it. An older cabinet would navigate to `@connect` as a path,
 * so the panel holds a door back from every cabinet that did not declare it.
 * The declaration is therefore load-bearing: without this header the panel
 * never sends a single «Не получилось подключиться?» pop-up to this cabinet.
 *
 * The body is out for the modes' reason: the panel validates bodies with
 * `forbidNonWhitelisted`, so a field its DTO has not learned is a 400, and the
 * route turns a 400 into `{ hint: null }` — no hints for anybody.
 *
 * The header NAME is pinned as a literal: the other half of the contract is in
 * another repository, and a typo in either half means no doors, silently.
 */

function fakeTransport() {
  const request = vi.fn(async () => ({ hint: null }));
  return { request } as unknown as { request: ReturnType<typeof vi.fn> };
}

const AUDIENCE = { userId: 'user-1', surface: 'pwa', formFactor: 'mobile', locale: 'ru' } as const;

describe('UserHintsNamespace.next — doors', () => {
  it('sends the doors as their own header, next to the modes, never in the body', async () => {
    const transport = fakeTransport();

    await new UserHintsNamespace(transport as never).next({ ...AUDIENCE }, ['MODAL', 'TOAST'], ['@connect']);

    const [method, path, body, headers] = transport.request.mock.calls[0] as [string, string, unknown, unknown];
    expect(method).toBe('POST');
    expect(path).toBe('/api/internal/user-hints/next');
    expect(headers).toEqual({ 'x-reiwa-hint-modes': 'MODAL,TOAST', 'x-reiwa-hint-doors': '@connect' });
    expect(body, 'the doors were put in the body, which an older panel answers with 400').toEqual(AUDIENCE);
  });

  it('pins the header name, and keeps the door spelled exactly', async () => {
    expect(HINT_DOORS_HEADER).toBe('x-reiwa-hint-doors');
    expect(HINT_MODES_HEADER).toBe('x-reiwa-hint-modes');

    const transport = fakeTransport();
    await new UserHintsNamespace(transport as never).next({ ...AUDIENCE }, undefined, ['@connect', '@other']);

    const headers = transport.request.mock.calls[0]?.[3] as Record<string, string>;
    // Doors alone: the modes header is not invented for them.
    expect(Object.keys(headers)).toEqual(['x-reiwa-hint-doors']);
    // Case-sensitive, comma-joined, no spaces — the panel compares the names.
    expect(headers['x-reiwa-hint-doors']).toBe('@connect,@other');
  });

  it('sends no doors header when the caller declares none', async () => {
    // An empty header would be a claim ("opens no doors"), not silence.
    const transport = fakeTransport();
    const namespace = new UserHintsNamespace(transport as never);

    await namespace.next({ ...AUDIENCE }, ['MODAL']);
    await namespace.next({ ...AUDIENCE }, ['MODAL'], []);

    for (const call of transport.request.mock.calls) {
      expect(call[3]).toEqual({ 'x-reiwa-hint-modes': 'MODAL' });
    }
  });
});

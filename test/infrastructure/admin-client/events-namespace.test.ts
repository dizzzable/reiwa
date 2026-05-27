/**
 * EventsNamespace + EventReporter wiring specs.
 *
 * The namespace is a thin wrapper around AdminTransport.request so we
 * just verify it composes the documented body shape (including the
 * `source: 'reiwa'` metadata stamp). EventReporter is checked by
 * running `emit()` and asserting AdminClient.events.emit was called
 * with the right payload + that promise rejection is swallowed.
 */
import { describe, expect, it, vi } from 'vitest';

import { EventsNamespace } from '../../../src/infrastructure/admin-client/namespaces/events.js';
import { EventReporter, REIWA_EVENTS } from '../../../src/lib/event-reporter.js';
import type { AdminClient } from '../../../src/infrastructure/admin-client/index.js';
import type { AdminTransport } from '../../../src/infrastructure/admin-client/transport.js';

describe('EventsNamespace', () => {
  it('forwards the typed event payload + stamps source: reiwa', async () => {
    const request = vi.fn().mockResolvedValue(null);
    const transport = ({ request } as unknown) as AdminTransport;
    const ns = new EventsNamespace(transport);
    await ns.emit({
      type: 'reiwa.test',
      category: 'SYSTEM',
      severity: 'WARNING',
      message: 'hello',
      metadata: { foo: 'bar' },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('POST');
    expect(request.mock.calls[0][1]).toBe('/api/internal/events');
    expect(request.mock.calls[0][2]).toEqual({
      type: 'reiwa.test',
      category: 'SYSTEM',
      severity: 'WARNING',
      message: 'hello',
      metadata: { source: 'reiwa', foo: 'bar' },
    });
  });

  it('handles missing metadata by using just { source: reiwa }', async () => {
    const request = vi.fn().mockResolvedValue(null);
    const transport = ({ request } as unknown) as AdminTransport;
    const ns = new EventsNamespace(transport);
    await ns.emit({
      type: 'reiwa.simple',
      category: 'AUTH',
      severity: 'INFO',
      message: 'no-meta',
    });
    expect(request.mock.calls[0][2]).toMatchObject({ metadata: { source: 'reiwa' } });
  });
});

describe('EventReporter', () => {
  function buildClient(emit: ReturnType<typeof vi.fn>): AdminClient {
    return ({ events: { emit } } as unknown) as AdminClient;
  }

  it('no-ops when no admin client is supplied', () => {
    const reporter = new EventReporter(null);
    expect(() => reporter.warn(REIWA_EVENTS.IP_BANNED, 'AUTH', 'msg')).not.toThrow();
  });

  it('forwards `info` calls to events.emit with severity INFO', async () => {
    const emit = vi.fn().mockResolvedValue(null);
    const reporter = new EventReporter(buildClient(emit));
    reporter.info(REIWA_EVENTS.USER_REGISTERED_WEB, 'USER', 'created', { id: 1 });
    // emit() is called synchronously inside emit(); just await its tick.
    await Promise.resolve();
    expect(emit).toHaveBeenCalledWith({
      type: REIWA_EVENTS.USER_REGISTERED_WEB,
      category: 'USER',
      severity: 'INFO',
      message: 'created',
      metadata: { id: 1 },
    });
  });

  it('forwards `error` calls with severity ERROR', async () => {
    const emit = vi.fn().mockResolvedValue(null);
    const reporter = new EventReporter(buildClient(emit));
    reporter.error(REIWA_EVENTS.BOT_WEBHOOK_ERROR, 'SYSTEM', 'crashed');
    await Promise.resolve();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'ERROR', message: 'crashed' }),
    );
  });

  it('swallows event-emit failures', async () => {
    const emit = vi.fn().mockRejectedValue(new Error('upstream down'));
    const reporter = new EventReporter(buildClient(emit));
    expect(() =>
      reporter.warn(REIWA_EVENTS.RATE_LIMIT_TRIGGERED, 'AUTH', 'oops'),
    ).not.toThrow();
    // Wait for the unhandled-rejection-style microtask flush before asserting.
    await new Promise((r) => setImmediate(r));
  });
});

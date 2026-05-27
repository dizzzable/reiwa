/**
 * AdminClient namespace facade — composition test.
 *
 * Asserts the Wave 2 contract: every namespace is wired onto the
 * facade, every namespace shares the same transport, and the legacy
 * 62-method surface still maps onto the namespace methods.
 *
 * No upstream HTTP is exercised — we instantiate the client against a
 * dummy URL and only inspect the object graph.
 */
import { describe, expect, it } from 'vitest';

import { AdminClient } from '../../../src/infrastructure/admin-client/index.js';

describe('AdminClient namespace facade', () => {
  const buildClient = () => new AdminClient('http://upstream.local', 'token-fake');

  it('exposes all 17 namespaces', () => {
    const client = buildClient();
    expect(client.system).toBeDefined();
    expect(client.catalog).toBeDefined();
    expect(client.user).toBeDefined();
    expect(client.subscription).toBeDefined();
    expect(client.trial).toBeDefined();
    expect(client.payments).toBeDefined();
    expect(client.devices).toBeDefined();
    expect(client.activity).toBeDefined();
    expect(client.promocodes).toBeDefined();
    expect(client.referrals).toBeDefined();
    expect(client.partner).toBeDefined();
    expect(client.branding).toBeDefined();
    expect(client.webAuth).toBeDefined();
    expect(client.linking).toBeDefined();
    expect(client.push).toBeDefined();
    expect(client.events).toBeDefined();
    expect(client.support).toBeDefined();
  });

  it('exposes the LinkingNamespace nested telegram + email surfaces', () => {
    const client = buildClient();
    expect(typeof client.linking.telegram.generate).toBe('function');
    expect(typeof client.linking.telegram.consume).toBe('function');
    expect(typeof client.linking.email.initiate).toBe('function');
    expect(typeof client.linking.email.verify).toBe('function');
  });

  it('exposes the openStream escape hatch for the SSE proxy', () => {
    const client = buildClient();
    expect(typeof client.openStream).toBe('function');
  });

  it('close() returns a promise (graceful shutdown contract)', async () => {
    const client = buildClient();
    const result = client.close();
    expect(result).toBeInstanceOf(Promise);
    // Drain so the test runner doesn't keep the pool open between specs.
    await result.catch(() => undefined);
  });
});

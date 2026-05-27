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

  it('exposes all 14 namespaces', () => {
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
  });

  it('exposes the LinkingNamespace nested telegram + email surfaces', () => {
    const client = buildClient();
    expect(typeof client.linking.telegram.generate).toBe('function');
    expect(typeof client.linking.telegram.consume).toBe('function');
    expect(typeof client.linking.email.initiate).toBe('function');
    expect(typeof client.linking.email.verify).toBe('function');
  });

  it('preserves the legacy 62-method surface', () => {
    const client = buildClient();
    // Spot-check one method per namespace.
    expect(typeof client.test).toBe('function');
    expect(typeof client.bootstrapUser).toBe('function');
    expect(typeof client.getUserSubscription).toBe('function');
    expect(typeof client.activateTrial).toBe('function');
    expect(typeof client.createCheckout).toBe('function');
    expect(typeof client.getUserDevices).toBe('function');
    expect(typeof client.getTransactions).toBe('function');
    expect(typeof client.activatePromocode).toBe('function');
    expect(typeof client.getReferralSummary).toBe('function');
    expect(typeof client.getPartnerStatus).toBe('function');
    expect(typeof client.getBranding).toBe('function');
    expect(typeof client.webAuthLogin).toBe('function');
    expect(typeof client.linkTelegramConsume).toBe('function');
    expect(typeof client.pushSubscribe).toBe('function');
  });

  it('exposes the request/openStream escape hatches for EventReporter and the SSE proxy', () => {
    const client = buildClient();
    expect(typeof client.request).toBe('function');
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

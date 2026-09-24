import { describe, expect, it, vi } from 'vitest';

import { SupportNamespace } from '../../../src/infrastructure/admin-client/namespaces/support.js';

/**
 * The guest page's language reaches the panel in the `x-support-guest-locale`
 * HEADER, never in the body.
 *
 * The panel's validation refuses a body property its DTO does not declare
 * (`forbidNonWhitelisted`): a panel older than the field would have answered
 * 400 to the whole request, and the guest could not have opened a conversation
 * at all. A header it does not read, it ignores — so this cabinet works in front
 * of an older panel, whose letters simply stay Russian.
 */
describe('SupportNamespace — the guest page’s language', () => {
  function namespace() {
    const request = vi.fn(async () => ({}));
    return { support: new SupportNamespace({ request } as never), request };
  }

  it('opens a conversation with the language in a header, and nothing new in the body', async () => {
    const { support, request } = namespace();
    await support.createGuest({ subject: 's', message: 'm', clientIp: '10.0.0.9', locale: 'en' });

    const [method, path, body, headers] = request.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      Record<string, string>,
    ];
    expect([method, path]).toEqual(['POST', '/api/internal/support/guest']);
    expect(headers).toEqual({ 'x-support-guest-locale': 'en', 'x-support-client-ip': '10.0.0.9' });
    expect(Object.keys(body).sort()).toEqual(['deviceHash', 'email', 'installId', 'message', 'subject']);
    expect(body).not.toHaveProperty('locale');
  });

  it('sends each reply with the language in a header', async () => {
    const { support, request } = namespace();
    await support.replyGuest('tok', 'hello', 'ru');

    expect(request).toHaveBeenCalledWith(
      'POST',
      '/api/internal/support/guest/reply',
      { content: 'hello' },
      { 'x-support-guest-token': 'tok', 'x-support-guest-locale': 'ru' },
    );
  });

  it('sends no language header when the page named none', async () => {
    const { support, request } = namespace();
    await support.createGuest({ subject: 's', message: 'm', locale: null });
    await support.replyGuest('tok', 'hello');
    await support.replyGuest('tok', 'hello', null);

    expect((request.mock.calls[0] as unknown as unknown[])[3]).toEqual({});
    expect((request.mock.calls[1] as unknown as unknown[])[3]).toEqual({ 'x-support-guest-token': 'tok' });
    expect((request.mock.calls[2] as unknown as unknown[])[3]).toEqual({ 'x-support-guest-token': 'tok' });
  });
});

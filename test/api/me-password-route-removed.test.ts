/**
 * `PATCH /api/v1/me/password` is gone, and so is what stood behind it.
 *
 * It set a password with no proof — no current password, no reset link, no
 * sign-out of the other sessions — by relaying to the panel's
 * `PATCH /api/internal/user/session/web-account-password`, which refused every
 * call this cabinet ever made (400: no login; the route itself is deleted on
 * the panel too, `rezeis-admin/test/internal-user-password-route-removed.spec.ts`).
 * Nothing used it, and a route like that is one "fix" away from being a way to
 * take over an account. A password changes on `/auth/change-password`, is set
 * for the first time on `/auth/first-password`, and is reset by a link.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createProfileRouter } from '../../src/api/routes/profile.js';
import { loadConfig } from '../../src/core/config/index.js';
import { AdminClient } from '../../src/infrastructure/admin-client/admin-client.js';
import { sendSocketless } from './socketless-request.js';

const servers: http.Server[] = [];
const clients: AdminClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

describe('the password route with no proof', () => {
  it('answers 404, and nothing reaches the panel', async () => {
    const calls: string[] = [];
    const panel = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        calls.push(`${req.method ?? ''} ${req.url ?? ''}`);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ statusCode: 400, message: ['login must be a string'], error: 'Bad Request' }));
      });
    });
    await new Promise<void>((ready) => panel.listen(0, '127.0.0.1', ready));
    servers.push(panel);
    const adminClient = new AdminClient(`http://127.0.0.1:${(panel.address() as AddressInfo).port}`, 'internal-token');
    clients.push(adminClient);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.webSession = { userId: 'user-a', createdAt: Date.now(), ip: '127.0.0.1', lastActivity: Date.now() };
      req.webSessionId = 'session-a';
      next();
    });
    app.use('/api/v1', createProfileRouter({ adminClient, sessionStore: null, config: loadConfig({ NODE_ENV: 'test' }) }));

    const response = await sendSocketless(app, { method: 'PATCH', url: '/api/v1/me/password', body: { newPasswordHash: 'b'.repeat(64) } });

    expect(response.status).toBe(404);
    expect(calls, 'the old route still relays to the panel').toEqual([]);
  });

  it('has no admin-client method left to relay it', () => {
    const adminClient = new AdminClient('http://127.0.0.1:9', 'internal-token');
    expect('changeWebAccountPassword' in adminClient.user).toBe(false);
    void adminClient.close();
  });
});

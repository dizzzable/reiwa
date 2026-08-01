import express from 'express';
import http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { createActivityRouter } from '../../src/api/routes/activity.js';
import { createProfileRouter } from '../../src/api/routes/profile.js';
import { UpstreamError } from '../../src/core/errors/index.js';

type ActivityMethod = (...args: unknown[]) => Promise<unknown>;

function attachWebSession(
  app: express.Express,
  destroyWebSession: () => Promise<void>,
): void {
  app.use((req, _res, next) => {
    req.webSession = {
      userId: 'missing-user',
      createdAt: Date.now(),
      ip: '127.0.0.1',
      lastActivity: Date.now(),
    };
    req.webSessionId = 'stale-session';
    req.destroyWebSession = destroyWebSession;
    next();
  });
}

function makeActivityApp(
  methods: Partial<{
    readonly getNotifications: ActivityMethod;
    readonly getUnreadCount: ActivityMethod;
    readonly markAllRead: ActivityMethod;
    readonly markRead: ActivityMethod;
  }>,
  destroyWebSession: () => Promise<void>,
): express.Express {
  const app = express();
  attachWebSession(app, destroyWebSession);
  const activity = {
    getNotifications: async () => ({ notifications: [] }),
    getUnreadCount: async () => ({ unread: 0 }),
    markAllRead: async () => ({ ok: true }),
    markRead: async () => ({ ok: true }),
    ...methods,
  };
  app.use(
    '/api/v1',
    createActivityRouter({
      adminClient: { activity } as never,
      sessionStore: null,
      config: { NODE_ENV: 'test' } as never,
    }),
  );
  // Match the production fall-through response, so the test proves a 404 is
  // consumed by the activity contract rather than becoming a global 500.
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ message: 'Internal server error' });
    },
  );
  return app;
}

async function request(
  app: express.Express,
  path: string,
  method: 'GET' | 'POST',
): Promise<{ readonly status: number; readonly body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method },
        (response) => {
          let payload = '';
          response.on('data', (chunk) => (payload += chunk));
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(payload),
            });
          });
        },
      );
      request.on('error', reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const get = (app: express.Express, path: string) => request(app, path, 'GET');
const post = (app: express.Express, path: string) => request(app, path, 'POST');

describe('activity routes for a user absent upstream', () => {
  it('revokes the stale session and returns 401 instead of propagating the upstream identity 404 as a 500', async () => {
    const destroyWebSession = vi.fn(async () => undefined);
    const getNotifications = vi.fn(async () => {
      throw new UpstreamError(
        'GET',
        '/api/internal/user/notifications?userId=missing-user',
        404,
        'User not found',
      );
    });
    const response = await get(
      makeActivityApp(
        { getNotifications, getUnreadCount: vi.fn(async () => ({ unread: 0 })) },
        destroyWebSession,
      ),
      '/api/v1/activity/notifications',
    );

    expect(response).toEqual({ status: 401, body: { message: 'Session expired' } });
    expect(getNotifications).toHaveBeenCalledWith({ userId: 'missing-user' });
    expect(destroyWebSession).toHaveBeenCalledTimes(1);
  });

  it('revokes the stale session for the unread badge too', async () => {
    const destroyWebSession = vi.fn(async () => undefined);
    const getUnreadCount = vi.fn(async () => {
      throw new UpstreamError(
        'GET',
        '/api/internal/user/notifications/unread-count?userId=missing-user',
        404,
        'User not found',
      );
    });
    const response = await get(
      makeActivityApp(
        { getNotifications: vi.fn(async () => ({ notifications: [] })), getUnreadCount },
        destroyWebSession,
      ),
      '/api/v1/activity/notifications/unread-count',
    );

    expect(response).toEqual({ status: 401, body: { message: 'Session expired' } });
    expect(getUnreadCount).toHaveBeenCalledWith({ userId: 'missing-user' });
    expect(destroyWebSession).toHaveBeenCalledTimes(1);
  });

  it('does not disguise an unrelated upstream 404 as a stale session', async () => {
    const destroyWebSession = vi.fn(async () => undefined);
    const response = await get(
      makeActivityApp(
        {
          getNotifications: vi.fn(async () => {
            throw new UpstreamError('GET', '/api/internal/user/notifications', 404, 'Notification event not found');
          }),
          getUnreadCount: vi.fn(async () => ({ unread: 0 })),
        },
        destroyWebSession,
      ),
      '/api/v1/activity/notifications',
    );

    expect(response).toEqual({ status: 500, body: { message: 'Internal server error' } });
    expect(destroyWebSession).not.toHaveBeenCalled();
  });

  it('revokes the stale session when marking every notification read', async () => {
    const destroyWebSession = vi.fn(async () => undefined);
    const markAllRead = vi.fn(async () => {
      throw new UpstreamError(
        'POST',
        '/api/internal/user/notifications/read-all',
        404,
        'User not found',
      );
    });
    const response = await post(
      makeActivityApp({ markAllRead }, destroyWebSession),
      '/api/v1/activity/notifications/read-all',
    );

    expect(response).toEqual({ status: 401, body: { message: 'Session expired' } });
    expect(markAllRead).toHaveBeenCalledWith({ userId: 'missing-user' });
    expect(destroyWebSession).toHaveBeenCalledTimes(1);
  });

  it('does not claim notification writes succeeded when the upstream rejects them', async () => {
    const destroyWebSession = vi.fn(async () => undefined);
    const response = await post(
      makeActivityApp(
        {
          markAllRead: vi.fn(async () => {
            throw new UpstreamError(
              'POST',
              '/api/internal/user/notifications/read-all',
              502,
              'Upstream unavailable',
            );
          }),
        },
        destroyWebSession,
      ),
      '/api/v1/activity/notifications/read-all',
    );

    expect(response).toEqual({ status: 500, body: { message: 'Internal server error' } });
    expect(destroyWebSession).not.toHaveBeenCalled();
  });

  it('revokes the stale session when marking one notification read', async () => {
    const destroyWebSession = vi.fn(async () => undefined);
    const markRead = vi.fn(async () => {
      throw new UpstreamError(
        'POST',
        '/api/internal/user/notifications/notice-1/read',
        404,
        'User not found',
      );
    });
    const response = await post(
      makeActivityApp({ markRead }, destroyWebSession),
      '/api/v1/activity/notifications/notice-1/read',
    );

    expect(response).toEqual({ status: 401, body: { message: 'Session expired' } });
    expect(markRead).toHaveBeenCalledWith({ userId: 'missing-user' }, 'notice-1');
    expect(destroyWebSession).toHaveBeenCalledTimes(1);
  });

  it('makes the session probe revoke a stale CUID and preserve its null contract', async () => {
    const destroyWebSession = vi.fn(async () => undefined);
    const app = express();
    attachWebSession(app, destroyWebSession);
    app.use(
      '/api/v1',
      createProfileRouter({
        adminClient: {
          user: {
            getSession: vi.fn(async () => {
              throw new UpstreamError('GET', '/api/internal/user/session', 404, 'User not found');
            }),
          },
        } as never,
        sessionStore: null,
        config: { NODE_ENV: 'test' } as never,
      }),
    );

    const response = await get(app, '/api/v1/session');

    expect(response).toEqual({ status: 200, body: null });
    expect(destroyWebSession).toHaveBeenCalledTimes(1);
  });

  it('makes the full profile read revoke a stale CUID and preserve its null contract', async () => {
    const destroyWebSession = vi.fn(async () => undefined);
    const app = express();
    attachWebSession(app, destroyWebSession);
    app.use(
      '/api/v1',
      createProfileRouter({
        adminClient: {
          user: {
            getSession: vi.fn(async () => {
              throw new UpstreamError('GET', '/api/internal/user/session', 404, 'User not found');
            }),
          },
        } as never,
        sessionStore: null,
        config: { NODE_ENV: 'test' } as never,
      }),
    );

    const response = await get(app, '/api/v1/me');

    expect(response).toEqual({ status: 200, body: null });
    expect(destroyWebSession).toHaveBeenCalledTimes(1);
  });

  it('logs failed stale-session cleanup but still returns the safe session-probe response', async () => {
    const cleanupError = new Error('Redis connection refused');
    const destroyWebSession = vi.fn(async () => {
      throw cleanupError;
    });
    const warn = vi.fn();
    const app = express();
    app.use((req, _res, next) => {
      req.log = { warn } as never;
      next();
    });
    attachWebSession(app, destroyWebSession);
    app.use(
      '/api/v1',
      createProfileRouter({
        adminClient: {
          user: {
            getSession: vi.fn(async () => {
              throw new UpstreamError(
                'GET',
                '/api/internal/user/session?userId=missing-user',
                404,
                'User not found: upstream diagnostic',
              );
            }),
          },
        } as never,
        sessionStore: null,
        config: { NODE_ENV: 'test' } as never,
      }),
    );

    const response = await get(app, '/api/v1/session');

    expect(response).toEqual({ status: 200, body: null });
    expect(destroyWebSession).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { err: cleanupError },
      'Failed to destroy stale web session',
    );
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('api/internal');
    expect(serialised).not.toContain('upstream diagnostic');
  });
});

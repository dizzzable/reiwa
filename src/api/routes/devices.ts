import { Router } from 'express';
import type { AdminClient } from '../../lib/admin-client.js';
import type { SessionStore } from '../../lib/session-store.js';
import type { ReiwaConfig } from '../../config.js';
import { createFlexibleSessionMiddleware, type AuthRequest } from '../middleware/session.js';
import { resolveUserIdentity } from '../middleware/user-identity.js';

export function createDevicesRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/devices — list HWID devices (active subscription, legacy)
  router.get('/', requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.devices.list(resolveUserIdentity(req));
      res.json(result ?? { devices: [] });
    } catch {
      res.json({ devices: [] });
    }
  });

  // GET /api/v1/devices/subscription/:subscriptionId — list devices for a
  // specific subscription (the cabinet shows devices for the selected card).
  router.get('/subscription/:subscriptionId', requireSession, async (req: AuthRequest, res) => {
    try {
      const subscriptionId = String(req.params['subscriptionId']);
      const result = await adminClient?.devices.listForSubscription(
        resolveUserIdentity(req),
        subscriptionId,
      );
      res.json(result ?? { devices: [] });
    } catch {
      res.json({ devices: [] });
    }
  });

  // DELETE /api/v1/devices/subscription/:subscriptionId/:hwid — revoke a
  // device from a specific subscription only.
  router.delete(
    '/subscription/:subscriptionId/:hwid',
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const subscriptionId = String(req.params['subscriptionId']);
        const hwid = String(req.params['hwid']);
        const result = await adminClient?.devices.deleteForSubscription(
          resolveUserIdentity(req),
          subscriptionId,
          hwid,
        );
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        res.status(400).json({ message: (e as Error).message });
      }
    },
  );

  // POST /api/v1/devices/subscription/:subscriptionId/regenerate — rotate the
  // subscription link and wipe all devices for THIS subscription only.
  router.post(
    '/subscription/:subscriptionId/regenerate',
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const subscriptionId = String(req.params['subscriptionId']);
        const result = await adminClient?.devices.regenerate(
          resolveUserIdentity(req),
          subscriptionId,
        );
        res.json(result ?? { regenerated: true });
      } catch (e: unknown) {
        res.status(400).json({ message: (e as Error).message });
      }
    },
  );

  // DELETE /api/v1/devices/:hwid — delete a device (active subscription, legacy)
  router.delete('/:hwid', requireSession, async (req: AuthRequest, res) => {
    try {
      const hwid = String(req.params['hwid']);
      const result = await adminClient?.devices.delete(resolveUserIdentity(req), hwid);
      res.json(result ?? { ok: true });
    } catch (e: unknown) {
      res.status(400).json({ message: (e as Error).message });
    }
  });

  return router;
}

import { Router } from 'express';
import type { AdminClient } from '../../lib/admin-client.js';
import type { SessionStore } from '../../lib/session-store.js';
import type { ReiwaConfig } from '../../config.js';
import { createSessionMiddleware, type AuthRequest } from '../middleware/session.js';

export function createDevicesRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/devices — list HWID devices
  router.get('/', requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.devices.list(req.telegramId!);
      res.json(result ?? { devices: [] });
    } catch {
      res.json({ devices: [] });
    }
  });

  // DELETE /api/v1/devices/:hwid — delete a device
  router.delete('/:hwid', requireSession, async (req: AuthRequest, res) => {
    try {
      const hwid = String(req.params['hwid']);
      const result = await adminClient?.devices.delete(req.telegramId!, hwid);
      res.json(result ?? { ok: true });
    } catch (e: unknown) {
      res.status(400).json({ message: (e as Error).message });
    }
  });

  return router;
}

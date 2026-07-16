/**
 * BFF routes for saved payment methods (list + unbind + autopay toggle).
 *
 * Proxies to rezeis-admin:
 *   GET    /api/internal/user/:userRef/payment-methods
 *   DELETE /api/internal/user/:userRef/payment-methods/:methodId
 *   PATCH  /api/internal/user/:userRef/payment-methods/:methodId
 *
 * Mounted at: /api/v1/payment-methods
 */
import { Router } from 'express';
import type { AdminClient } from '../../lib/admin-client.js';
import type { SessionStore } from '../../lib/session-store.js';
import type { ReiwaConfig } from '../../config.js';
import { createFlexibleSessionMiddleware, type AuthRequest } from '../middleware/session.js';
import { resolveUserIdentity } from '../middleware/user-identity.js';
import { sendSafeError } from '../lib/error-response.js';

export function createPaymentMethodsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/payment-methods — list active saved payment methods
  router.get('/', requireSession, async (req: AuthRequest, res) => {
    try {
      if (!adminClient) {
        res.status(503).json({ message: 'Admin client unavailable' });
        return;
      }
      const result = await adminClient.paymentMethods.list(resolveUserIdentity(req));
      res.json(result ?? { methods: [], total: 0 });
    } catch (e) {
      sendSafeError(req, res, e, 502, 'Failed to load payment methods', 'payment-methods/list');
    }
  });

  // DELETE /api/v1/payment-methods/:methodId — soft-unbind (stop using for autopay)
  router.delete('/:methodId', requireSession, async (req: AuthRequest, res) => {
    try {
      if (!adminClient) {
        res.status(503).json({ message: 'Admin client unavailable' });
        return;
      }
      const methodId = String(req.params['methodId'] ?? '').trim();
      if (!methodId) {
        res.status(400).json({ message: 'methodId is required' });
        return;
      }
      const result = await adminClient.paymentMethods.unbind(
        resolveUserIdentity(req),
        methodId,
      );
      res.json(result);
    } catch (e) {
      sendSafeError(req, res, e, 400, 'Failed to unbind payment method', 'payment-methods/unbind');
    }
  });

  // PATCH /api/v1/payment-methods/:methodId — enable/disable autopay without unbind
  router.patch('/:methodId', requireSession, async (req: AuthRequest, res) => {
    try {
      if (!adminClient) {
        res.status(503).json({ message: 'Admin client unavailable' });
        return;
      }
      const methodId = String(req.params['methodId'] ?? '').trim();
      if (!methodId) {
        res.status(400).json({ message: 'methodId is required' });
        return;
      }
      const raw = (req.body as { autopayEnabled?: unknown } | null)?.autopayEnabled;
      if (typeof raw !== 'boolean') {
        res.status(400).json({ message: 'autopayEnabled (boolean) is required' });
        return;
      }
      const result = await adminClient.paymentMethods.setAutopay(
        resolveUserIdentity(req),
        methodId,
        raw,
      );
      res.json(result);
    } catch (e) {
      sendSafeError(
        req,
        res,
        e,
        400,
        'Failed to update payment method autopay',
        'payment-methods/autopay',
      );
    }
  });

  return router;
}

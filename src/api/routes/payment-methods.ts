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
import { resolveReiwaPublicUrl } from '../../config.js';
import { createFlexibleSessionMiddleware, type AuthRequest } from '../middleware/session.js';
import { resolveUserIdentity } from '../middleware/user-identity.js';
import { sendSafeError } from '../lib/error-response.js';
import { describeUpstreamError } from '../lib/upstream-error.js';
import { createRedisRateLimiter } from '../middleware/rate-limit.js';
import type { WebSessionStore } from '../../infrastructure/redis/session.js';

export function createPaymentMethodsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  webSessionStore: WebSessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore, webSessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // Each setup opens a real YooKassa bind request — gate it per IP so a
  // stuck client or malicious caller can't spam the provider.
  const setupRateLimiter = createRedisRateLimiter(
    webSessionStore?.getRedis() ?? null,
    'paymentMethodSetup',
  );

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

  // POST /api/v1/payment-methods/setup — starts a hosted, zero-amount
  // YooKassa binding. Card details never enter Reiwa or Rezeis.
  router.post('/setup', requireSession, setupRateLimiter, async (req: AuthRequest, res) => {
    try {
      if (!adminClient) {
        res.status(503).json({ message: 'Admin client unavailable' });
        return;
      }
      const consent = (req.body as { consent?: unknown } | null)?.consent;
      if (consent !== true) {
        res.status(400).json({ code: 'PAYMENT_METHOD_SETUP_CONSENT_REQUIRED' });
        return;
      }
      const publicUrl = resolveReiwaPublicUrl(deps.config);
      if (!publicUrl) {
        res.status(503).json({ message: 'Payment method setup is temporarily unavailable' });
        return;
      }
      const result = await adminClient.paymentMethods.startSetup(
        resolveUserIdentity(req),
        {
          returnUrl: `${publicUrl.replace(/\/$/, '')}/settings/payment-methods`,
          consent: true,
        },
        {
          clientIp: req.ip ?? req.socket.remoteAddress ?? null,
          userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
        },
      );
      res.json(result ?? {});
    } catch (e) {
      sendSafeError(req, res, e, 502, 'Failed to start payment method setup', 'payment-methods/setup');
    }
  });

  // GET /api/v1/payment-methods/setup/:setupId — refreshes the YooKassa
  // verification result after its hosted page redirects back to the cabinet.
  router.get('/setup/:setupId', requireSession, async (req: AuthRequest, res) => {
    try {
      if (!adminClient) {
        res.status(503).json({ message: 'Admin client unavailable' });
        return;
      }
      const setupId = String(req.params['setupId'] ?? '').trim();
      if (!setupId) {
        res.status(400).json({ message: 'setupId is required' });
        return;
      }
      const result = await adminClient.paymentMethods.getSetupStatus(
        resolveUserIdentity(req),
        setupId,
      );
      res.json(result ?? {});
    } catch (e) {
      // Only a genuine upstream 404 means "unknown setup". Anything else (gateway
      // 5xx, timeout) is an availability failure — reporting it as 404 would tell
      // the client the binding vanished when the card may actually be bound.
      const upstreamStatus = describeUpstreamError(e).status;
      const status = upstreamStatus === 404 ? 404 : 502;
      const message =
        status === 404 ? 'Payment method setup not found' : 'Failed to load payment method setup';
      sendSafeError(req, res, e, status, message, 'payment-methods/setup-status');
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

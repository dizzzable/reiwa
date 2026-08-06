import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AdminClient } from '../../lib/admin-client.js';
import type { SessionStore } from '../../lib/session-store.js';
import type { ReiwaConfig } from '../../config.js';
import { createFlexibleSessionMiddleware, type AuthRequest } from '../middleware/session.js';
import { resolveUserIdentity } from '../middleware/user-identity.js';
import { sendSafeError } from '../lib/error-response.js';
import { describeUpstreamError } from '../lib/upstream-error.js';

/**
 * A device READ that failed must never leave this router as an empty list.
 *
 * Both list handlers used to answer `200 {"devices":[]}` on any throw —
 * byte-identical to a genuinely empty list. A customer whose slots were full
 * read that as "all slots free", tried to bind another device, and the panel
 * refused with nothing on our side to explain it. rezeis-admin now fails that
 * read loudly (503 outage / not-found, 502 unusable answer, see
 * `panel-device-read.util.ts`); swallowing it here would make that fix inert
 * for the cabinet, which is the only place the customer can see it.
 *
 * Status mapping mirrors upstream so the SPA gets the same taxonomy:
 *   - upstream 502 → 502. The panel answered but not in a way we can trust;
 *     retrying identical bytes cannot help.
 *   - anything else (503, other 5xx, 4xx, network, timeout, a missing admin
 *     client) → 503. We could not check; retrying is the right advice.
 *
 * Detail stays server-side: `sendSafeError` logs the upstream body and returns
 * a generic message, because `UpstreamError.message` embeds the internal
 * `/api/internal/...` path and the raw provider response.
 */
function sendDeviceListFailure(
  req: Request,
  res: Response,
  e: unknown,
  context: string,
): void {
  if (describeUpstreamError(e).status === 502) {
    sendDeviceListUnusable(req, res, e, context);
    return;
  }
  sendSafeError(req, res, e, 503, 'Device list is temporarily unavailable', context);
}

/** 502 half of {@link sendDeviceListFailure}: an answer we cannot trust. */
function sendDeviceListUnusable(
  req: Request,
  res: Response,
  e: unknown,
  context: string,
): void {
  sendSafeError(req, res, e, 502, 'Device list could not be read', context);
}

/** True for a payload we can render as a device list. */
function isDeviceListPayload(result: unknown): result is { devices: unknown[] } {
  return (
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as { devices?: unknown }).devices)
  );
}

/**
 * Runs one device-list read and answers with the payload or an honest failure.
 * Shared by both GET handlers so neither can drift back into a fake empty list.
 */
async function respondWithDeviceList(
  req: Request,
  res: Response,
  context: string,
  read: (() => Promise<unknown>) | null,
): Promise<void> {
  if (read === null) {
    sendDeviceListFailure(req, res, new Error('admin client is not configured'), context);
    return;
  }
  let result: unknown;
  try {
    result = await read();
  } catch (e: unknown) {
    sendDeviceListFailure(req, res, e, context);
    return;
  }
  // A body we cannot read as a list is NOT an empty list. Upstream classifies
  // the same shape failure as 502 (`invalidContract`); match it.
  if (!isDeviceListPayload(result)) {
    sendDeviceListUnusable(
      req,
      res,
      new Error('device list payload has no "devices" array'),
      context,
    );
    return;
  }
  res.json(result);
}

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
    await respondWithDeviceList(
      req,
      res,
      'devices/list',
      adminClient === null
        ? null
        : () => adminClient.devices.list(resolveUserIdentity(req)),
    );
  });

  // GET /api/v1/devices/subscription/:subscriptionId — list devices for a
  // specific subscription (the cabinet shows devices for the selected card).
  router.get('/subscription/:subscriptionId', requireSession, async (req: AuthRequest, res) => {
    const subscriptionId = String(req.params['subscriptionId']);
    await respondWithDeviceList(
      req,
      res,
      'devices/subscription/list',
      adminClient === null
        ? null
        : () =>
            adminClient.devices.listForSubscription(
              resolveUserIdentity(req),
              subscriptionId,
            ),
    );
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
        sendSafeError(req, res, e, 400, "Failed to revoke device", "devices/subscription/delete");
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
        sendSafeError(req, res, e, 400, "Failed to regenerate subscription", "devices/subscription/regenerate");
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
      sendSafeError(req, res, e, 400, "Failed to delete device", "devices/delete");
    }
  });

  return router;
}

import { Router } from 'express';
import { z } from 'zod';

import type { AdminClient } from '../../lib/admin-client.js';
import { sendSafeError } from '../lib/error-response.js';
import { isUpstreamStatus } from '../lib/upstream-error.js';

const quoteRequestSchema = z.strictObject({
  revisionId: z.string().min(1),
  durationDays: z.number().int().positive(),
  currency: z.string().min(1),
  selections: z.array(z.strictObject({
    type: z.enum(['TRAFFIC', 'DEVICES']),
    value: z.number().int().nonnegative(),
  })),
});

function sendConstructorError(req: Parameters<typeof sendSafeError>[0], res: Parameters<typeof sendSafeError>[1], error: unknown): void {
  if (isUpstreamStatus(error, 404)) {
    res.status(404).json({ code: 'disabled', message: 'Tariff constructor is disabled' });
    return;
  }
  if (isUpstreamStatus(error, 409)) {
    res.status(409).json({ code: 'revision_mismatch', message: 'Tariff configuration changed' });
    return;
  }
  if (isUpstreamStatus(error, 422)) {
    res.status(422).json({ code: 'unavailable', message: 'Selection is unavailable' });
    return;
  }
  sendSafeError(req, res, error, 502, 'Tariff constructor temporarily unavailable', 'tariff-constructor');
}

export function createTariffConstructorRouter(deps: { adminClient: AdminClient | null }) {
  const router = Router();

  router.get('/tariff-constructor', async (req, res) => {
    if (!deps.adminClient) {
      res.status(503).json({ code: 'unavailable', message: 'Tariff constructor unavailable' });
      return;
    }
    try {
      res.json(await deps.adminClient.tariffConstructor.getManifest());
    } catch (error: unknown) {
      sendConstructorError(req, res, error);
    }
  });

  router.post('/tariff-constructor/quote', async (req, res) => {
    if (!deps.adminClient) {
      res.status(503).json({ code: 'unavailable', message: 'Tariff constructor unavailable' });
      return;
    }
    const parsed = quoteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'invalid_request', message: 'Invalid quote request' });
      return;
    }
    try {
      res.json(await deps.adminClient.tariffConstructor.quote(parsed.data));
    } catch (error: unknown) {
      sendConstructorError(req, res, error);
    }
  });

  return router;
}

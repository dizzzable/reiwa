/**
 * Edge middleware that enforces the rezeis-admin platform access mode
 * for a specific gate. Mirrors the server-side `AccessModeGuard` so the
 * SPA / Mini App / bot get a fast, user-friendly rejection without
 * paying a round-trip through admin (Property 2 — edge gate ⇔ admin
 * gate).
 *
 * Usage:
 *
 *   router.post(
 *     '/auth/register',
 *     requireMode('register', { hasInvite: (req) => Boolean(req.body?.referralCode) }),
 *     handler,
 *   );
 */
import type { NextFunction, Request, Response } from 'express';

import type { AccessMode } from '../../infrastructure/admin-client/namespaces/system.js';
import { getPolicyCache } from '../../infrastructure/admin-client/policy-cache.js';
import type { AdminClient } from '../../lib/admin-client.js';

export type AccessModeGate =
  | 'register'
  | 'login'
  | 'purchase.new'
  | 'purchase.upgrade'
  | 'purchase.addon'
  | 'purchase.renewal'
  | 'subscription.mutate';

export type AccessModeRejectionCode =
  | 'REGISTRATION_DISABLED'
  | 'PURCHASES_DISABLED'
  | 'INVITE_REQUIRED'
  | 'SERVICE_RESTRICTED';

export interface AccessModeRejection {
  readonly code: AccessModeRejectionCode;
  readonly status: 403 | 503;
  readonly message: string;
}

/**
 * Pure decision function shared with the admin server. Returns `null`
 * when the request passes for the given `(gate, mode, hasInvite)` triple,
 * otherwise a typed rejection.
 */
export function evaluateAccessMode(input: {
  readonly gate: AccessModeGate;
  readonly mode: AccessMode;
  readonly hasInvite?: boolean;
}): AccessModeRejection | null {
  const { gate, mode, hasInvite = false } = input;

  if (mode === 'RESTRICTED') return SERVICE_RESTRICTED;

  switch (gate) {
    case 'register':
      if (mode === 'REG_BLOCKED') return REGISTRATION_DISABLED;
      if (mode === 'INVITED' && !hasInvite) return INVITE_REQUIRED;
      return null;
    case 'login':
      return null;
    case 'purchase.new':
    case 'purchase.upgrade':
    case 'purchase.addon':
      if (mode === 'PURCHASE_BLOCKED') return PURCHASES_DISABLED;
      return null;
    case 'purchase.renewal':
      return null;
    case 'subscription.mutate':
      return null;
    default: {
      const _exhaustive: never = gate;
      return _exhaustive;
    }
  }
}

interface RequireModeOptions {
  /** Reads the `hasInvite` signal from the request (typically a body field). */
  readonly hasInvite?: (req: Request) => boolean;
}

/**
 * Express middleware factory. Reads the cached platform policy and
 * rejects with `{ code, message }` JSON when the gate fails.
 *
 * `gate` may be either a fixed {@link AccessModeGate} value (for routes
 * with a single semantic — `register`, `login`, `purchase.renewal`, etc.)
 * or a function that derives the gate from the request (for routes like
 * `/payments/checkout` where the body's `purchaseType` selects between
 * `purchase.new` / `purchase.upgrade` / `purchase.renewal`).
 */
export function requireMode(
  gate: AccessModeGate | ((req: Request) => AccessModeGate),
  options: RequireModeOptions = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async function requireModeMiddleware(req, res, next) {
    try {
      const adminClient = (req.app.locals['adminClient'] ?? null) as AdminClient | null;
      const cache = getPolicyCache(adminClient);
      const policy = await cache.get();
      const resolvedGate = typeof gate === 'function' ? gate(req) : gate;
      const rejection = evaluateAccessMode({
        gate: resolvedGate,
        mode: policy.accessMode,
        hasInvite: options.hasInvite ? options.hasInvite(req) : undefined,
      });
      if (rejection !== null) {
        res.status(rejection.status).json({
          code: rejection.code,
          message: rejection.message,
        });
        return;
      }
      next();
    } catch {
      // Fail open: never lock users out on a transient cache miss.
      next();
    }
  };
}

const REGISTRATION_DISABLED: AccessModeRejection = {
  code: 'REGISTRATION_DISABLED',
  status: 403,
  message: 'Registration is currently disabled',
};

const PURCHASES_DISABLED: AccessModeRejection = {
  code: 'PURCHASES_DISABLED',
  status: 403,
  message: 'New purchases are temporarily unavailable',
};

const INVITE_REQUIRED: AccessModeRejection = {
  code: 'INVITE_REQUIRED',
  status: 403,
  message: 'Registration is invite-only — a valid referral code is required',
};

const SERVICE_RESTRICTED: AccessModeRejection = {
  code: 'SERVICE_RESTRICTED',
  status: 503,
  message: 'Service is temporarily unavailable',
};

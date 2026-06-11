/**
 * access-mode middleware specs.
 *
 * Two layers are pinned here:
 *
 *   1. `evaluateAccessMode` — the pure decision function shared with the
 *      rezeis-admin `AccessModeGuard`. We exhaustively walk every
 *      `(gate × mode)` pair plus the INVITED `hasInvite` branch. This is
 *      the canonical Property-2 invariant: the edge gate must agree with
 *      the admin gate for the same triple.
 *
 *   2. `requireMode` — the Express factory. We drive it with a stub
 *      `PolicyCache` (via `setPolicyCache`) and synthetic req/res fakes to
 *      assert it rejects with the right `{ status, code }` JSON, derives
 *      the gate from a function form, reads `hasInvite` from the request,
 *      and fails OPEN on a cache throw.
 */
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  evaluateAccessMode,
  requireMode,
  type AccessModeGate,
} from '../../../src/api/middleware/access-mode.js';
import type { AccessMode } from '../../../src/infrastructure/admin-client/namespaces/system.js';
import {
  PolicyCache,
  setPolicyCache,
} from '../../../src/infrastructure/admin-client/policy-cache.js';

const MODES: readonly AccessMode[] = [
  'PUBLIC',
  'INVITED',
  'PURCHASE_BLOCKED',
  'REG_BLOCKED',
  'RESTRICTED',
];

const PURCHASE_GATES: readonly AccessModeGate[] = [
  'purchase.new',
  'purchase.upgrade',
  'purchase.addon',
];

afterEach(() => {
  // The PolicyCache is a process-wide singleton — reset it so specs don't
  // leak a stubbed instance into one another.
  setPolicyCache(null);
});

describe('evaluateAccessMode', () => {
  it('blocks every gate under RESTRICTED with a 503 SERVICE_RESTRICTED', () => {
    const gates: AccessModeGate[] = [
      'register',
      'login',
      'purchase.new',
      'purchase.upgrade',
      'purchase.addon',
      'purchase.renewal',
      'subscription.mutate',
    ];
    for (const gate of gates) {
      const r = evaluateAccessMode({ gate, mode: 'RESTRICTED', hasInvite: true });
      expect(r).not.toBeNull();
      expect(r?.code).toBe('SERVICE_RESTRICTED');
      expect(r?.status).toBe(503);
    }
  });

  it('passes every gate under PUBLIC', () => {
    const gates: AccessModeGate[] = [
      'register',
      'login',
      'purchase.new',
      'purchase.upgrade',
      'purchase.addon',
      'purchase.renewal',
      'subscription.mutate',
    ];
    for (const gate of gates) {
      expect(evaluateAccessMode({ gate, mode: 'PUBLIC' })).toBeNull();
    }
  });

  describe('register gate', () => {
    it('rejects under REG_BLOCKED with 403 REGISTRATION_DISABLED', () => {
      const r = evaluateAccessMode({ gate: 'register', mode: 'REG_BLOCKED' });
      expect(r?.code).toBe('REGISTRATION_DISABLED');
      expect(r?.status).toBe(403);
    });

    it('requires an invite under INVITED', () => {
      const without = evaluateAccessMode({ gate: 'register', mode: 'INVITED', hasInvite: false });
      expect(without?.code).toBe('INVITE_REQUIRED');
      expect(without?.status).toBe(403);

      const withInvite = evaluateAccessMode({
        gate: 'register',
        mode: 'INVITED',
        hasInvite: true,
      });
      expect(withInvite).toBeNull();
    });

    it('passes under PURCHASE_BLOCKED (registration unaffected)', () => {
      expect(evaluateAccessMode({ gate: 'register', mode: 'PURCHASE_BLOCKED' })).toBeNull();
    });
  });

  describe('login gate', () => {
    it('passes under every non-RESTRICTED mode', () => {
      for (const mode of MODES.filter((m) => m !== 'RESTRICTED')) {
        expect(evaluateAccessMode({ gate: 'login', mode })).toBeNull();
      }
    });
  });

  describe('new-purchase gates', () => {
    it('reject under PURCHASE_BLOCKED with 403 PURCHASES_DISABLED', () => {
      for (const gate of PURCHASE_GATES) {
        const r = evaluateAccessMode({ gate, mode: 'PURCHASE_BLOCKED' });
        expect(r?.code).toBe('PURCHASES_DISABLED');
        expect(r?.status).toBe(403);
      }
    });

    it('pass under INVITED / REG_BLOCKED (those modes do not freeze purchases)', () => {
      for (const gate of PURCHASE_GATES) {
        expect(evaluateAccessMode({ gate, mode: 'INVITED' })).toBeNull();
        expect(evaluateAccessMode({ gate, mode: 'REG_BLOCKED' })).toBeNull();
      }
    });
  });

  describe('renewal gate', () => {
    it('stays OPEN under PURCHASE_BLOCKED so customers keep their VPN', () => {
      expect(evaluateAccessMode({ gate: 'purchase.renewal', mode: 'PURCHASE_BLOCKED' })).toBeNull();
    });

    it('is blocked only under RESTRICTED', () => {
      expect(evaluateAccessMode({ gate: 'purchase.renewal', mode: 'RESTRICTED' })?.code).toBe(
        'SERVICE_RESTRICTED',
      );
    });
  });
});

// ── requireMode middleware ────────────────────────────────────────────────────

interface FakeCtx {
  req: Partial<Request>;
  res: Partial<Response> & { statusCode?: number; jsonBody?: unknown };
  nextCalled: boolean;
}

function buildCtx(body: Record<string, unknown> = {}): FakeCtx {
  const res: Partial<Response> & { statusCode?: number; jsonBody?: unknown } = {
    status(code: number): Response {
      res.statusCode = code;
      return res as Response;
    },
    json(payload: unknown): Response {
      res.jsonBody = payload;
      return res as Response;
    },
  };
  const req: Partial<Request> = {
    body,
    app: { locals: { adminClient: null } } as unknown as Request['app'],
  };
  return { req, res, nextCalled: false };
}

/** Stub the singleton with a cache that always resolves a fixed mode. */
function stubMode(mode: AccessMode): void {
  setPolicyCache(
    new PolicyCache(async () => ({
      accessMode: mode,
      rulesRequired: false,
      rulesLink: null,
      channelRequired: false,
      channelLink: null,
      defaultCurrency: 'USD',
    })),
  );
}

describe('requireMode', () => {
  it('calls next() when the gate passes', async () => {
    stubMode('PUBLIC');
    const ctx = buildCtx();
    const next: NextFunction = () => {
      ctx.nextCalled = true;
    };
    await requireMode('register')(ctx.req as Request, ctx.res as Response, next);
    expect(ctx.nextCalled).toBe(true);
    expect(ctx.res.statusCode).toBeUndefined();
  });

  it('rejects with the typed JSON body when the gate fails', async () => {
    stubMode('REG_BLOCKED');
    const ctx = buildCtx();
    const next: NextFunction = () => {
      ctx.nextCalled = true;
    };
    await requireMode('register')(ctx.req as Request, ctx.res as Response, next);
    expect(ctx.nextCalled).toBe(false);
    expect(ctx.res.statusCode).toBe(403);
    expect(ctx.res.jsonBody).toMatchObject({ code: 'REGISTRATION_DISABLED' });
  });

  it('reads hasInvite from the request body under INVITED', async () => {
    stubMode('INVITED');
    const hasInvite = (req: Request): boolean => Boolean((req.body as { ref?: string })?.ref);

    const blocked = buildCtx({});
    await requireMode('register', { hasInvite })(
      blocked.req as Request,
      blocked.res as Response,
      () => {
        blocked.nextCalled = true;
      },
    );
    expect(blocked.nextCalled).toBe(false);
    expect(blocked.res.jsonBody).toMatchObject({ code: 'INVITE_REQUIRED' });

    const allowed = buildCtx({ ref: 'abc' });
    await requireMode('register', { hasInvite })(
      allowed.req as Request,
      allowed.res as Response,
      () => {
        allowed.nextCalled = true;
      },
    );
    expect(allowed.nextCalled).toBe(true);
  });

  it('derives the gate from a function form (purchaseType → gate)', async () => {
    stubMode('PURCHASE_BLOCKED');
    const gateFor = (req: Request): AccessModeGate =>
      (req.body as { purchaseType?: string })?.purchaseType === 'RENEWAL'
        ? 'purchase.renewal'
        : 'purchase.new';

    // RENEWAL stays open under PURCHASE_BLOCKED.
    const renewal = buildCtx({ purchaseType: 'RENEWAL' });
    await requireMode(gateFor)(renewal.req as Request, renewal.res as Response, () => {
      renewal.nextCalled = true;
    });
    expect(renewal.nextCalled).toBe(true);

    // NEW is blocked.
    const fresh = buildCtx({ purchaseType: 'NEW' });
    await requireMode(gateFor)(fresh.req as Request, fresh.res as Response, () => {
      fresh.nextCalled = true;
    });
    expect(fresh.nextCalled).toBe(false);
    expect(fresh.res.jsonBody).toMatchObject({ code: 'PURCHASES_DISABLED' });
  });

  it('fails OPEN when the policy cache throws', async () => {
    setPolicyCache(
      new PolicyCache(async () => {
        throw new Error('admin down with no last-known-good');
      }),
    );
    // No cached value → fallback PUBLIC → gate passes.
    const ctx = buildCtx();
    await requireMode('register')(ctx.req as Request, ctx.res as Response, () => {
      ctx.nextCalled = true;
    });
    expect(ctx.nextCalled).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import {
  BOT_RELAY_DOCUMENT_TIMEOUT_MS,
  BOT_RELAY_TIMEOUT_MS,
  PANEL_RELAY_TIMEOUTS_MS,
} from "../../src/api/routes/webhooks.js";

/**
 * The cabinet must always be the side that gives up first
 * ═══════════════════════════════════════════════════════
 * Two deadlines are stacked on every relayed event. The panel bounds its call
 * TO the cabinet; the cabinet bounds its own call ONWARD to the bot. The outer
 * one has to outlast the inner one.
 *
 * Invert them and the failure is silent and expensive: the panel abandons a hop
 * the cabinet is still serving, records its own timeout as a delivery failure,
 * and `ReiwaRelayQueueService` retries an event that was in fact on its way.
 * The operator gets a second card — or, on a document route, a second upload.
 *
 * This is not a hypothetical ordering. Until this session the panel bounded
 * EVERY route at 10s, including the routes the cabinet gives 30s, so any
 * document slower than ten seconds produced exactly that duplicate. On the
 * backup route it produced duplicate *gigabytes*, because the panel's timeout
 * was classified as retryable and the backup queue grants three attempts.
 *
 * The panel's numbers cannot be imported — separate repositories, separate
 * builds, no shared package — so `PANEL_RELAY_TIMEOUTS_MS` mirrors them by
 * hand. That copy is the weak link, and this file is what makes the weak link
 * fail loudly: change one side without the other and these assertions go red.
 */
describe("bot relay deadlines are ordered across the two repositories", () => {
  it("gives the panel more time than the cabinet on the message route", () => {
    expect(PANEL_RELAY_TIMEOUTS_MS.message).toBeGreaterThan(BOT_RELAY_TIMEOUT_MS);
  });

  it("gives the panel more time than the cabinet on the document route", () => {
    // The tighter of the two margins, and the one that was actually inverted:
    // 10s outer against a 30s inner.
    expect(PANEL_RELAY_TIMEOUTS_MS.document).toBeGreaterThan(BOT_RELAY_DOCUMENT_TIMEOUT_MS);
  });

  it("leaves slack, not a photo finish, on both routes", () => {
    // A margin of one millisecond satisfies "greater than" and still loses the
    // race in practice: the gap has to absorb TLS, both ends of the hop, and
    // the cabinet's own HMAC + zod work, all of which happen BEFORE the
    // cabinet's `AbortSignal.timeout` is even armed. One second is the floor
    // this asserts; the shipped margins are 2s and 5s.
    const MIN_SLACK_MS = 1_000;
    expect(PANEL_RELAY_TIMEOUTS_MS.message - BOT_RELAY_TIMEOUT_MS).toBeGreaterThanOrEqual(
      MIN_SLACK_MS,
    );
    expect(
      PANEL_RELAY_TIMEOUTS_MS.document - BOT_RELAY_DOCUMENT_TIMEOUT_MS,
    ).toBeGreaterThanOrEqual(MIN_SLACK_MS);
  });

  it("keeps the backup route unbounded on BOTH sides", () => {
    // `null` is the whole point on this route and the only value that is safe.
    // A total deadline anywhere on it cuts a legitimate multi-gigabyte upload
    // mid-flight, which becomes a 502, a queue retry, and a duplicate copy of
    // those gigabytes in the operator's topic. The cabinet passes `null` at the
    // `/notify-backup-document` call site; this pins the panel's half of it.
    expect(PANEL_RELAY_TIMEOUTS_MS.backupDocument).toBeNull();
  });

  it("states the panel's numbers rather than deriving them from the cabinet's", () => {
    // Anti-vacuity. If the mirror were ever written as `BOT_RELAY_TIMEOUT_MS +
    // slack`, every assertion above would hold by construction and this file
    // would guard nothing at all — it would be checking arithmetic, not a
    // contract with another repository. Pinning the literals means a panel
    // change that is not mirrored here fails, which is the only reason the
    // mirror is worth having.
    expect(PANEL_RELAY_TIMEOUTS_MS.message).toBe(10_000);
    expect(PANEL_RELAY_TIMEOUTS_MS.document).toBe(35_000);
    expect(BOT_RELAY_TIMEOUT_MS).toBe(8_000);
    expect(BOT_RELAY_DOCUMENT_TIMEOUT_MS).toBe(30_000);
  });
});

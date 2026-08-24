import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { REDIS_CLIENT_OPTIONS } from '../../src/lib/redis-client-options.js';
import { SPA_HEAD_DEADLINE_MS, withHeadDeadline } from '../../src/api/spa-head-deadline.js';
import { sourceFiles, stripComments } from '../support/source-scan.js';

/**
 * WHAT THIS FILE GUARDS, AND WHY IT IS NOT THE OBVIOUS THING.
 *
 * On 2026-08-24 the cabinet's front door stopped answering roughly once a day.
 * `GET /` sat for 60006 ms and was aborted with no status code, while every
 * `/api/v1/*` route kept answering 200/304 in single-digit milliseconds. That
 * asymmetry is the whole diagnosis: the API routes serve from in-process
 * caches, and the SPA document is the one path that reads the operator's
 * branding snapshot out of Redis before it may emit a single byte.
 *
 * The code already had a fallback for that lookup — `try/catch` around it,
 * with the comment "never fail a document over a favicon". It was true about
 * FAILURE and silent about WAITING, and waiting is what happened: an ioredis
 * client with no `commandTimeout`, behind a socket that was ESTABLISHED here
 * and dead on the other end, produced no error for anything to catch.
 *
 * So there are two separate things to hold, and this file holds both:
 *
 *   1. the root cause — no Redis client may be built without a command
 *      deadline, including one added next year by someone who never read this;
 *   2. the second wall — the document must survive an await that never
 *      settles, whatever the next such await turns out to be.
 *
 * Every case below distinguishes "settled late" from "never settled". A test
 * that only proved the fallback fires on REJECTION would have passed against
 * the broken code, because rejection was never the problem.
 */

/** A promise that is never settled by anyone. The production failure, in one value. */
const NEVER = new Promise<string>(() => {});

describe('the SPA document survives a head lookup that never answers', () => {
  it('serves the fallback when the work never settles', async () => {
    // THE PRODUCTION DEFECT, in its smallest form. Before the deadline existed
    // this await was the end of the request: no value, no rejection, no
    // timeout, and a document that never emitted a header.
    let reported = 0;
    const result = await withHeadDeadline(NEVER, 'unbranded', () => { reported += 1; }, 20);

    expect(result).toBe('unbranded');
    expect(reported).toBe(1);
  });

  it('serves the real value when the lookup answers in time', async () => {
    // ANTI-VACUITY. Without this, "always return the fallback" would pass the
    // spec above — and would silently strip the operator's branding from every
    // document on a perfectly healthy system, which is a worse bug than the one
    // being fixed.
    let reported = 0;
    const result = await withHeadDeadline(
      Promise.resolve('branded'),
      'unbranded',
      () => { reported += 1; },
      20,
    );

    expect(result).toBe('branded');
    expect(reported).toBe(0);
  });

  it('serves the fallback when the work rejects, and does not report a deadline', async () => {
    // The behaviour the original `try/catch` had. It must survive, and it must
    // stay DISTINGUISHABLE from a hang: a rejection is an answer, and reporting
    // it as a missed deadline would send the next reader after the wrong cause.
    let reported = 0;
    const result = await withHeadDeadline(
      Promise.reject(new Error('panel said no')),
      'unbranded',
      () => { reported += 1; },
      20,
    );

    expect(result).toBe('unbranded');
    expect(reported).toBe(0);
  });

  it('reports at most once even if the work settles after the deadline', async () => {
    // A lookup that answers at 30ms against a 10ms deadline. The document has
    // already been served; a second resolve would be a `resolve` after
    // `resolve` (harmless) but a second report would put a phantom outage in
    // the log, which is not.
    let reported = 0;
    const late = new Promise<string>((resolve) => {
      setTimeout(() => resolve('branded'), 30);
    });
    const result = await withHeadDeadline(late, 'unbranded', () => { reported += 1; }, 10);

    expect(result).toBe('unbranded');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reported).toBe(1);
  });

  it('defaults to a deadline that suits BOTH supported deployments', () => {
    // The cabinet must run on the same VPS as the panel and on its own. The
    // number has to be comfortably above a healthy round trip in the split
    // case and comfortably below anything a human or a proxy waits on — a
    // value under ~500ms would start stripping branding from a WORKING split
    // deployment, and one over ~5s would be indistinguishable from the hang.
    expect(SPA_HEAD_DEADLINE_MS).toBeGreaterThanOrEqual(500);
    expect(SPA_HEAD_DEADLINE_MS).toBeLessThanOrEqual(5_000);
  });
});



describe('no Redis client can be built without a command deadline', () => {
  it('sets a finite command timeout and a keep-alive on the shared options', () => {
    // `commandTimeout` is the load-bearing one: ioredis leaves it undefined,
    // and undefined means a command written to a dead socket waits forever.
    // `keepAlive` decides how long that socket stays undetected — the OS
    // default is about two hours, long enough to read as "it fixed itself".
    expect(REDIS_CLIENT_OPTIONS.commandTimeout).toBeGreaterThan(0);
    expect(REDIS_CLIENT_OPTIONS.commandTimeout).toBeLessThanOrEqual(10_000);
    expect(REDIS_CLIENT_OPTIONS.keepAlive).toBeGreaterThan(0);
  });

  it('keeps the offline queue ON, deliberately', () => {
    // Every client here is `lazyConnect`, so the first command is issued before
    // the connection exists. With the queue off that command fails on a
    // perfectly healthy start-up. `commandTimeout` already bounds the queued
    // case, so the queue can keep its job without hiding a dead peer forever.
    // Pinned because "turn the offline queue off" is the plausible-looking
    // change that would break boot.
    expect(REDIS_CLIENT_OPTIONS.enableOfflineQueue).toBeUndefined();
  });

  it('spreads the shared options at EVERY construction site in src/', () => {
    // The three known clients are `session-store`, `redis/session` and
    // `bot-config/redis-config-persistence`. This does not name them: the
    // failure mode being guarded is a FOURTH one, added later, built the way
    // the other three used to be. Naming the three would guard the past.
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(/new Redis\(([^)]*)\)/g)) {
        if (!match[1].includes('REDIS_CLIENT_OPTIONS')) {
          offenders.push(`${file}: new Redis(${match[1]})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

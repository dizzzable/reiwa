import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGAL_DOCUMENT_KEYS } from '../src/infrastructure/admin-client/namespaces/legal-documents.js';

/**
 * The list of legal documents exists twice in this repo and once more in the
 * panel, and a mismatch is not a cosmetic drift.
 *
 * ── What breaks ──────────────────────────────────────────────────────────
 *
 * The registration route validates `acceptedLegalDocuments` against the edge's
 * copy — both the member names and the maximum length. If the panel gains a
 * document and this repo does not, then the moment an operator switches that
 * document on, the cabinet ticks a box the edge rejects and EVERY web
 * registration fails validation. Not a missing checkbox: a sign-up outage,
 * caused by publishing a privacy policy.
 *
 * ── What this can and cannot check ───────────────────────────────────────
 *
 * It compares the two copies inside this repo — the edge constant and the
 * browser bundle's, which cannot import it because one is server code. It
 * CANNOT see the panel: that is a separate repo, and no test in either can
 * compare across them. What it buys is that the two halves of the cabinet
 * always agree, so a cross-repo mismatch shows up as one clear symptom (a
 * document the cabinet does not know) rather than two contradictory ones.
 */

function readDeclaredKeys(relativePath: string): readonly string[] {
  const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
  const match = /LEGAL_DOCUMENT_KEYS\s*=\s*\[([^\]]*)\]/.exec(source);
  expect(match, `no LEGAL_DOCUMENT_KEYS array found in ${relativePath}`).not.toBeNull();
  return (match as RegExpExecArray)[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter((entry) => entry.length > 0)
}

describe('legal document keys', () => {
  it('are the same list, in the same order, in the edge and the browser bundle', () => {
    // ORDER matters as well as membership: every surface renders documents in
    // the order its own array declares, and two orders means the registration
    // form and the cabinet's legal page list the same documents differently.
    expect(readDeclaredKeys('web/src/lib/api-client/content.ts')).toEqual([
      ...LEGAL_DOCUMENT_KEYS,
    ])
  })

  it('carries the privacy policy the device signals need somewhere to be declared', () => {
    // Not a tautology restating the constant: it pins the reason the third key
    // was added. The cabinet derives an install id and a device digest, and a
    // service that does that has to be able to SAY so. Removing this key would
    // leave the operator with nowhere to put that statement.
    expect(LEGAL_DOCUMENT_KEYS).toContain('PRIVACY_POLICY')
  })

  it('lets the registration payload carry every one of them at once', () => {
    // The cap used to be a literal `2` beside a literal two-member enum, so a
    // third document would have been refused twice over — once for its name and
    // once for the length. Somebody ticking all three boxes is the ordinary
    // case, not an edge one.
    const source = readFileSync(
      resolve(process.cwd(), 'src/api/routes/auth.ts'),
      'utf8',
    )
    expect(source).toContain('.max(LEGAL_DOCUMENT_KEYS.length)')
    expect(source).not.toMatch(/acceptedLegalDocuments[\s\S]{0,200}\.max\(\d+\)/)
  })
})

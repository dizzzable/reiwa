/**
 * The panel has words for everything the cabinet's guard can refuse.
 *
 * Since 24.09.2026 the cabinet takes a branding save field by field and tells
 * the panel which fields it kept at their previous value, by the guard's key
 * and reason code (`src/infrastructure/public-config/delivery-report.ts`). The
 * branding page turns those into the operator's words
 * (`rezeis-admin/web/src/features/branding/branding-delivery-fields.ts`). A
 * field or a reason added here without words there still shows — as a raw key
 * or a generic "not accepted" — so nothing breaks; this is what makes it
 * visible before an operator sees the raw key.
 *
 * Cross-repository: loads the panel module by absolute path, and is skipped
 * where the sibling checkout is absent (CI checks out the cabinet alone).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PUBLIC_CONFIG_CHECKED_FIELDS } from '../../src/application/ports/public-config-persistence.port.js';
import { PANEL_REPO_PATH, hasPanelRepo } from './panel-modules.js';

interface PanelDeliveryFields {
  readonly BRANDING_DELIVERY_FIELD_LABELS: Readonly<Record<string, { readonly labelKey: string }>>;
  readonly BRANDING_DELIVERY_REASONS: readonly string[];
  readonly brandingDeliveryReasonText: (reason: string) => { readonly key: string };
}

const PANEL_FIELDS = `${PANEL_REPO_PATH}web/src/features/branding/branding-delivery-fields.ts`;

/** Every reason code the guard spells out, read from its source. */
function guardReasons(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/application/ports/public-config-persistence.port.ts', import.meta.url)),
    'utf8',
  );
  const reasons = new Set<string>();
  for (const pattern of [
    /(?:inBranding|inRoot)\(\s*"[^"]+",\s*"([^"]+)"/g,
    /reject\(\s*(?:"[^"]*"|`[^`]*`|[A-Za-z_.[\]"]+),\s*"([^"]+)"/g,
  ]) {
    for (const match of source.matchAll(pattern)) reasons.add(match[1] as string);
  }
  return [...reasons].sort();
}

describe.skipIf(!hasPanelRepo)('the panel names what the cabinet did not take', () => {
  it('has a label for every field the guard judges, and none for a field it does not', async () => {
    const panel = (await import(pathToFileURL(PANEL_FIELDS).href)) as PanelDeliveryFields;
    const labelled = Object.keys(panel.BRANDING_DELIVERY_FIELD_LABELS).sort();

    expect(PUBLIC_CONFIG_CHECKED_FIELDS.length).toBeGreaterThan(40);
    expect(labelled).toEqual([...PUBLIC_CONFIG_CHECKED_FIELDS].sort());
  });

  it('has plain words for every reason the guard gives', async () => {
    const panel = (await import(pathToFileURL(PANEL_FIELDS).href)) as PanelDeliveryFields;
    const reasons = guardReasons();

    // Non-vacuity: the source scan found the guard's reasons at all.
    expect(reasons).toContain('not-a-hex-colour');
    expect(reasons.length).toBeGreaterThan(25);
    // The two reasons that carry their bounds are read apart by prefix.
    const plain = reasons.filter((reason) => !reason.includes('['));
    expect([...panel.BRANDING_DELIVERY_REASONS].sort()).toEqual(plain);
    for (const reason of ['out-of-range[0.05..1]', 'out-of-range[0..24]', 'too-many-entries[max=20]']) {
      expect(panel.brandingDeliveryReasonText(reason).key, reason).not.toBe(
        'brandingPage.deliveryNotice.reasons.unknown',
      );
    }
  });
});

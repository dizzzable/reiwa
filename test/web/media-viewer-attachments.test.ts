import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  collectViewableAttachments,
  indexOfAttachment,
  isViewableAttachment,
} from '../../web/src/features/media-viewer/support-attachments.js';

const source = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../web/src/${relative}`, import.meta.url)), 'utf8');

const url = (attachment: { id: string }): string => `/api/v1/support/files/${attachment.id}`;

const shot = (id: string) => ({ id, filename: `${id}.png`, mimeType: 'image/png' });
const doc = (id: string) => ({ id, filename: `${id}.pdf`, mimeType: 'application/pdf' });

describe('isViewableAttachment', () => {
  it('takes images and leaves everything else to the download chip', () => {
    expect(isViewableAttachment(shot('a'))).toBe(true);
    expect(isViewableAttachment(doc('b'))).toBe(false);
    // Video keeps its chip: routing it into a viewer with no save control would
    // take away the only way to get the file out.
    expect(isViewableAttachment({ id: 'c', filename: 'c.mp4', mimeType: 'video/mp4' })).toBe(false);
  });

  it('survives an attachment whose type the server did not send', () => {
    expect(isViewableAttachment({ id: 'd', filename: 'd', mimeType: undefined as never })).toBe(
      false,
    );
  });
});

describe('collectViewableAttachments', () => {
  it('gathers across the whole thread, in reading order', () => {
    // The point of the feature: the second screenshot is in a later reply, and
    // paging has to reach it.
    const items = collectViewableAttachments(
      [{ attachments: [shot('one')] }, { attachments: [] }, { attachments: [shot('two')] }],
      url,
    );
    expect(items.map((item) => item.id)).toEqual(['one', 'two']);
    expect(items[0]).toMatchObject({ kind: 'image', url: '/api/v1/support/files/one' });
  });

  it('handles messages with no attachments at all', () => {
    expect(collectViewableAttachments([{}, { attachments: null }], url)).toEqual([]);
    expect(collectViewableAttachments(null, url)).toEqual([]);
    expect(collectViewableAttachments(undefined, url)).toEqual([]);
  });
});

describe('indexOfAttachment', () => {
  it('finds a screenshot that sits after a non-viewable attachment', () => {
    // The bug this exists to prevent: counting positions in the RENDERED thread
    // instead of in the filtered list. The pdf below is rendered as a chip and
    // skipped by the viewer, so position-counting would open 'first' when the
    // person tapped 'second'.
    const items = collectViewableAttachments(
      [{ attachments: [shot('first'), doc('paper'), shot('second')] }],
      url,
    );
    expect(indexOfAttachment(items, 'second')).toBe(1);
  });

  it('reports -1 for an attachment the viewer does not show', () => {
    const items = collectViewableAttachments([{ attachments: [shot('first'), doc('paper')] }], url);
    expect(indexOfAttachment(items, 'paper')).toBe(-1);
    expect(indexOfAttachment(items, 'nothing-like-this')).toBe(-1);
  });
});

describe('the support pages use this collector', () => {
  // Without these, the module above can be perfectly correct and simply never
  // reached — the failure mode this codebase has hit more than once.
  const signedIn = source('features/support/support-page.tsx');
  const guest = source('features/support/guest-support-page.tsx');

  it('opens attachments in the viewer instead of a new tab', () => {
    // A new tab is exactly what does not work inside the Telegram mini app.
    for (const page of [signedIn, guest]) {
      expect(page).toContain('indexOfAttachment(viewable');
      expect(page).toContain('viewer.element');
    }
    expect(signedIn).not.toContain('<a href={url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl">');
    expect(guest).not.toContain('<a href={url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl">');
  });

  it('stops cropping the preview a person gets of their own screenshot', () => {
    for (const page of [signedIn, guest]) {
      expect(page).toContain('cursor-zoom-in rounded-xl object-contain');
      expect(page).not.toContain('max-w-full rounded-xl object-cover');
    }
  });

  it('collects the thread, not one message', () => {
    for (const page of [signedIn, guest]) {
      expect(page).toContain('collectViewableAttachments(');
      expect(page).toMatch(/collectViewableAttachments\(\s*(props\.)?ticket[?.]*\.messages/);
    }
  });
});

describe('the FAQ grid opens the viewer', () => {
  const faq = source('features/settings/faq-page.tsx');

  it('pages through the answer media, skipping formats it cannot show', () => {
    expect(faq).toContain('viewer.open(viewable, at)');
    expect(faq).toContain('if (kind === "unsupported") return [];');
  });

  it('gives video its own expand control rather than hijacking play/pause', () => {
    expect(faq).toContain('mediaViewer.expand');
  });
});

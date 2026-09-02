import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * EVERY LAZY IMAGE RESERVES ITS BOX BEFORE THE BYTES ARRIVE.
 *
 * A `loading="lazy"` image with no width, height or aspect ratio is laid out
 * as a 0×0 box until it loads and then snaps to its real size, shoving
 * everything below it down the page. Chrome reported thirteen of them on one
 * screen; the ones that mattered were a support thread jumping under the
 * reader and the landing page growing a step at a time.
 *
 * The rule is per image, and the shapes differ because the causes do:
 *
 *   • a size we KNOW (an emoji, an avatar) sets both dimensions outright;
 *   • an operator's upload, whose size arrives with the bytes, reserves an
 *     `aspect-video` slot and is contained inside it;
 *   • a chat attachment reserves a fixed-height strip on its container, so
 *     the bubble is the same height whatever lands in it.
 *
 * The count at the bottom is the anti-vacuity guard AND the review prompt: a
 * new lazy image fails this file until somebody says which of the three it is.
 */

const WEB_SRC = fileURLToPath(new URL('../../web/src/', import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), 'utf8');
}

/** Every `.tsx` under `web/src`, so the census below cannot miss a directory. */
function everyComponentFile(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...everyComponentFile(path));
      continue;
    }
    if (entry.name.endsWith('.tsx')) found.push(path);
  }
  return found;
}

describe('lazy images reserve their layout box', () => {
  it('sizes an emoji and an avatar outright, because their size is known', () => {
    // Both dimensions in the class list: the glyph is 1.15em square and the
    // testimonial avatar is a 40px circle, whatever file is behind them.
    expect(read('components/ui/emoji-text.tsx')).toContain(
      'inline-block h-[1.15em] w-[1.15em]',
    );
    expect(read('features/landing/sections/misc.tsx')).toContain(
      'h-10 w-10 rounded-full',
    );
  });

  it('reserves an aspect-video slot for an upload whose size arrives with it', () => {
    // The FAQ answer and the landing step both render a file the operator
    // chose, so the page cannot know its shape in advance. `object-contain`
    // is what keeps the reservation from cropping a picture that is not 16/9.
    const faq = read('features/settings/faq-media-element.tsx');
    expect(faq).toContain('aspect-video max-h-80 w-full object-contain');
    expect(faq).toContain('aspect-video max-h-80 w-full bg-black object-contain');

    expect(read('features/landing/sections/how-it-works.tsx')).toContain(
      'aspect-video w-full rounded-xl border border-[color:var(--ls-border)] object-contain',
    );
  });

  it('reserves a fixed-height strip for a support attachment, on the container', () => {
    // The reservation cannot live on the image here: it is `w-auto`, so only
    // the button can hold a height the thread can count on. Both support
    // pages render the same preview and must agree.
    for (const page of ['features/support/support-page.tsx', 'features/support/guest-support-page.tsx']) {
      const source = read(page);
      expect(source, page).toContain('className="block h-64 overflow-hidden rounded-xl"');
      expect(source, page).toContain('h-full w-auto max-w-full cursor-zoom-in rounded-xl object-contain');
      expect(source, page).not.toContain('max-h-64 w-auto max-w-full');
    }
  });

  it('gives a partner logo a minimum width, so a row of them does not reflow', () => {
    // Height alone was reserved here, which left each logo zero wide until it
    // loaded and shifted its neighbours sideways along the strip.
    expect(read('features/landing/sections/misc.tsx')).toContain(
      'h-8 w-auto min-w-16 object-contain sm:h-10 sm:min-w-20',
    );
  });

  it('knows about every lazy image in the tree, so a new one has to be decided', () => {
    const sites = everyComponentFile(WEB_SRC).flatMap((file) => {
      const occurrences = readFileSync(file, 'utf8').match(/loading="lazy"/g) ?? [];
      return occurrences.map(() => file.slice(WEB_SRC.length).replace(/\\/g, '/'));
    });

    expect(sites.slice().sort()).toEqual([
      'components/ui/emoji-text.tsx',
      'features/landing/sections/how-it-works.tsx',
      'features/landing/sections/misc.tsx',
      'features/landing/sections/misc.tsx',
      'features/settings/faq-media-element.tsx',
      'features/support/guest-support-page.tsx',
      'features/support/support-page.tsx',
    ]);
  });
});

describe('the build emits no module preload hints', () => {
  it('turns them off, because this service worker discards every one of them', () => {
    // `sw.ts` claims the page mid-load, so a hint fetched before the claim can
    // never be matched to the module request made after it. Chrome discarded
    // all of them and said so ~130 times per load, burying real errors.
    const viteConfig = readFileSync(new URL('../../web/vite.config.ts', import.meta.url), 'utf8');
    expect(viteConfig).toContain('modulePreload: false');

    const serviceWorker = readFileSync(new URL('../../web/src/sw.ts', import.meta.url), 'utf8');
    expect(serviceWorker).toContain('self.clients.claim()');
    expect(serviceWorker).toContain('self.skipWaiting()');
  });
});

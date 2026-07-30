import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const telegramSdkLoader = readFileSync(
  new URL('../../web/public/telegram-webapp-loader.js', import.meta.url),
  'utf8',
);
const reporter = readFileSync(new URL('../../web/src/lib/client-error-reporter.ts', import.meta.url), 'utf8');
const telegramWidget = readFileSync(
  new URL('../../web/src/features/auth/external-auth-buttons.tsx', import.meta.url),
  'utf8',
);
const turnstile = readFileSync(
  new URL('../../web/src/features/support/guest-support-page.tsx', import.meta.url),
  'utf8',
);

describe('client error reporting policy', () => {
  it('loads third-party scripts anonymously so their runtime errors retain diagnostics', () => {
    expect(indexHtml).toContain('<script defer src="/telegram-webapp-loader.js"></script>');
    expect(indexHtml).not.toContain(
      '<script defer src="https://telegram.org/js/telegram-web-app.js"',
    );
    expect(telegramSdkLoader.indexOf('script.crossOrigin = "anonymous"')).toBeLessThan(
      telegramSdkLoader.indexOf(
        'script.src = "https://telegram.org/js/telegram-web-app.js"',
      ),
    );
    expect(telegramWidget.indexOf("script.crossOrigin = 'anonymous'")).toBeLessThan(
      telegramWidget.indexOf("script.src = 'https://telegram.org/js/telegram-widget.js?22'"),
    );
    expect(turnstile.indexOf("script.crossOrigin = 'anonymous'")).toBeLessThan(
      turnstile.indexOf("script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'"),
    );
  });

  it('forwards the complete ErrorEvent location to the server-side firehose', () => {
    expect(reporter).toContain('filename: event.filename');
    expect(reporter).toContain('lineno: event.lineno');
    expect(reporter).toContain('colno: event.colno');
    expect(reporter).toContain('errorName: getErrorName(error)');
  });

  it('drops only opaque cross-origin Script error noise', () => {
    expect(reporter).toContain('function isOpaqueCrossOriginScriptError(event: ErrorEvent): boolean');
    expect(reporter).toContain('if (isOpaqueCrossOriginScriptError(event)) return');
    expect(reporter).toContain('!normalizeString(event.filename, 2_000)');
  });
});

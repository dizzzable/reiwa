import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config/app.config.js';
import { resolveReiwaPublicUrl } from '../../src/core/config/url-resolver.js';

describe('production security configuration', () => {
  const sharedSecret = 's'.repeat(32);

  it('rejects production startup without a public or explicit CORS origin', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        REZEIS_INTERNAL_SHARED_SECRET: sharedSecret,
      }),
    ).toThrow(/REIWA_CORS_ORIGIN/);
  });

  it('accepts REIWA_DOMAIN as the production CORS origin fallback', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      REIWA_DOMAIN: 'app.example.com',
      REZEIS_INTERNAL_SHARED_SECRET: sharedSecret,
    });

    expect(config.REIWA_DOMAIN).toBe('app.example.com');
    expect(config.REIWA_CORS_ORIGIN).toBeNull();
  });

  it('treats an empty explicit CORS origin as unset and keeps the domain fallback', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      REIWA_CORS_ORIGIN: '   ',
      REIWA_DOMAIN: 'app.example.com',
      REZEIS_INTERNAL_SHARED_SECRET: sharedSecret,
    });

    expect(config.REIWA_CORS_ORIGIN).toBeNull();
    expect(resolveReiwaPublicUrl(config)).toBe('https://app.example.com');
  });

  it('accepts an explicit production CORS origin override', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      REIWA_CORS_ORIGIN: 'https://frontend.example.com',
      REZEIS_INTERNAL_SHARED_SECRET: sharedSecret,
    });

    expect(config.REIWA_CORS_ORIGIN).toBe('https://frontend.example.com');
  });

  it('normalizes a trailing slash on an explicit CORS origin', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      REIWA_CORS_ORIGIN: 'https://frontend.example.com/',
      REZEIS_INTERNAL_SHARED_SECRET: sharedSecret,
    });

    expect(config.REIWA_CORS_ORIGIN).toBe('https://frontend.example.com');
  });

  it.each([
    '*',
    'frontend.example.com',
    'https://frontend.example.com/app',
    'https://user:password@frontend.example.com',
    'https://frontend.example.com?tenant=one',
  ])('rejects an invalid explicit CORS origin: %s', (origin) => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        REIWA_CORS_ORIGIN: origin,
        REZEIS_INTERNAL_SHARED_SECRET: sharedSecret,
      }),
    ).toThrow(/REIWA_CORS_ORIGIN/);
  });

  it('resolves the documented loopback domain as HTTP', () => {
    const config = loadConfig({
      REIWA_DOMAIN: '127.0.0.1:5000',
    });

    expect(resolveReiwaPublicUrl(config)).toBe('http://127.0.0.1:5000');
  });

  it('continues to accept the deprecated public URL fallback', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      REIWA_PUBLIC_WEB_URL: 'https://legacy.example.com',
      REZEIS_INTERNAL_SHARED_SECRET: sharedSecret,
    });

    expect(config.REIWA_PUBLIC_WEB_URL).toBe('https://legacy.example.com');
  });
});

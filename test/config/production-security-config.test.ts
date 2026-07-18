import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config/app.config.js';

describe('production security configuration', () => {
  it('rejects production startup without explicit security configuration', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/REIWA_CORS_ORIGIN/);
  });
  it('accepts configured production security boundaries', () => {
    expect(loadConfig({ NODE_ENV: 'production', REIWA_CORS_ORIGIN: 'https://app.example.com', REZEIS_INTERNAL_SHARED_SECRET: 's'.repeat(32) }).REIWA_CORS_ORIGIN).toBe('https://app.example.com');
  });
});

/**
 * The version of one group of the panel's settings, computed the same way on
 * both sides of the wire.
 *
 * The panel answers `POST /api/internal/config-versions` with one version per
 * group (`rezeis-admin/src/modules/bot-config/config-versions/`), computed from
 * exactly what the group's internal route serves. reiwa computes the same thing
 * from the copy it holds, and a group whose two versions differ is re-read. So
 * the version has to be a function of the BYTES THE WIRE CARRIES and nothing
 * else: not of the panel's objects (Dates, `undefined` fields, key order) and
 * not of reiwa's mapped objects.
 *
 * Hence: through `JSON.stringify` first — what `res.json` sends and the
 * transport's `JSON.parse` reads back — then a canonical form with every
 * object's keys sorted, so the order a service happened to build an object in
 * cannot make two equal answers look different. SHA-256, first 32 hex digits.
 *
 * THE PANEL HAS A COPY OF THIS FILE (`config-version-hash.ts`). Both sides pin
 * the same test vector (`test/infrastructure/config-versions/config-version.test.ts`
 * here, `test/config-version-hash.spec.ts` there); change one and its vector goes
 * red before the two can disagree in production, where a disagreement would read
 * as "every group changed" on every poll.
 */
import { createHash } from 'node:crypto';

/**
 * The groups the panel versions, named by the internal route each copies. The
 * two legal-document keys are one route in two languages: the panel resolves
 * the locale upstream, so each language is its own answer.
 */
export const CONFIG_VERSION_KEYS = {
  /** `GET /api/internal/branding/public-config` — theme, locales, currency. */
  publicConfig: 'publicConfig',
  /** `GET /api/internal/bot-config` — buttons, texts, screens, emoji. */
  botConfig: 'botConfig',
  /** `GET /api/internal/landing-config/effective`. */
  landing: 'landing',
  /** `GET /api/internal/connect-page/effective`. */
  connectPage: 'connectPage',
  /** `GET /api/internal/settings/platform-policy` — access mode, channel, rules. */
  platformPolicy: 'platformPolicy',
  /** `GET /api/internal/legal-documents?locale=ru`. */
  legalDocumentsRu: 'legalDocuments.ru',
  /** `GET /api/internal/legal-documents?locale=en`. */
  legalDocumentsEn: 'legalDocuments.en',
  /** `GET /api/internal/custom-emoji/packs` — the cabinet feed's packs. */
  customEmojiPacks: 'customEmojiPacks',
  /** `GET /api/internal/support/guest/config` — guest chat on/off and captcha keys. */
  guestSupport: 'guestSupport',
} as const;

export type ConfigVersionKey = (typeof CONFIG_VERSION_KEYS)[keyof typeof CONFIG_VERSION_KEYS];

/**
 * The legal-documents key for a locale, by the panel's own rule
 * (`parseLocale` in `internal-legal-documents.controller.ts`): anything that is
 * not an explicit `en` reads as the primary language.
 */
export function legalDocumentsVersionKey(locale: string): ConfigVersionKey {
  return locale.trim().toLowerCase() === 'en'
    ? CONFIG_VERSION_KEYS.legalDocumentsEn
    : CONFIG_VERSION_KEYS.legalDocumentsRu;
}

/**
 * A JSON value written with every object's keys sorted. Arrays keep their
 * order — it is part of what the operator configured.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // `undefined` inside an array is what `JSON.stringify` writes as `null`.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * The response header a public settings route names the version of the body it
 * served in — the value `/api/v1/config-versions` reports as held — so the
 * SPA's version watcher can tell a copy the browser's or the service worker's
 * cache answered with from the current one (`web/src/lib/config-versions.ts`).
 */
export const CONFIG_VERSION_HEADER = 'X-Config-Version';

/** The version of a payload as the wire carries it. */
export function configVersionOf(payload: unknown): string {
  const wire: unknown = JSON.parse(JSON.stringify(payload) ?? 'null');
  return createHash('sha256').update(canonicalJson(wire), 'utf8').digest('hex').slice(0, 32);
}

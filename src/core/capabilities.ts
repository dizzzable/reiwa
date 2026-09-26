/**
 * What this cabinet can do, told to the panel on every call it makes.
 *
 * The panel and the cabinet are updated separately, so for a while either half
 * can be the older one. A panel that knows what the cabinet in front of it can
 * SHOW holds back only what that cabinet would show wrongly. Today that is one
 * offer: the traffic top-up «до сброса». A cabinet without the reset wording
 * sells it as «Действует до <дата>», dated by the phone's clock.
 *
 * ── The wire: the contract with the panel (pair design D1 §6.1) ─────────────
 *
 *   x-reiwa-client:       surface=api; version=0.9.7.54; commit=0123456789ab; instance=reiwa
 *   x-reiwa-capabilities: web.addon-reset-end,web.lifetime-subscription,…
 *
 * HEADERS, never body fields. The panel validates bodies with
 * `forbidNonWhitelisted`, so an older panel answers 400 to a field it has not
 * learned, and that 400 fails the whole call, not one feature. An older panel
 * simply does not read an unknown header. `x-reiwa-hint-modes` travels the
 * same way for the same reason (`admin-client/namespaces/user-hints.ts`).
 *
 * `AdminTransport` puts both headers on every request, stream and binary
 * fetch, AFTER the caller's own headers, so no caller can speak for the
 * process. The headers only ever let the panel show or sell MORE to the caller
 * that sent them, and the bearer token already authorises the call, so the
 * HMAC does not cover them.
 *
 * ── Who declares what ────────────────────────────────────────────────────────
 *
 *  - reiwa-api declares `web.*` and `api.*`. It serves the web app, and the web
 *    app's code is what a `web.*` capability is about.
 *  - reiwa-bot declares `bot.*`.
 *  - The worker declares nothing.
 *
 * ── Rules for an id ──────────────────────────────────────────────────────────
 *
 *  - `<area>.<name>`. The area is the part of the cabinet that implements it;
 *    the format is `CAPABILITY_ID_PATTERN`, at most 48 characters, exact case.
 *  - Its meaning never changes. A changed meaning is a new id with `.v2`.
 *  - A feature one half needs from the other gets ONE id in BOTH registries,
 *    in the same pair of releases. The panel's registry is
 *    `rezeis-admin/src/modules/reiwa-peers/cabinet-capabilities.ts`, and no test
 *    here can see it: the pair's end-to-end run is what compares the two.
 *    The panel turns the behaviour on only for a cabinet that declares the id,
 *    and otherwise does what its previous release did.
 *  - An id leaves only when the panel's supported floor passes its `since`.
 */
import { hostname } from 'node:os';

import { REIWA_BUILD_INFO } from './version.js';

/** A process of this cabinet that calls the panel. */
export type ReiwaSurface = 'api' | 'bot' | 'worker';

/** The part of the cabinet a capability lives in: the prefix of its id. */
export type CapabilityArea = 'web' | 'api' | 'bot';

export interface CabinetCapability {
  /** `<area>.<name>`, see the rules in the header. */
  readonly id: string;
  /** The first cabinet release that implements it. */
  readonly since: string;
  /** The module that implements it, from the repository root. */
  readonly implementedBy: string;
}

/**
 * The format of a capability id, shared with the panel. `panel.*` is the panel's
 * own area: it declares those in the version poll's answer
 * (`config-versions/panel-capabilities.ts`), and this cabinet never does.
 */
export const CAPABILITY_ID_PATTERN = /^(web|api|bot|panel)\.[a-z0-9]+(-[a-z0-9]+)*(\.v[2-9]\d*)?$/;
export const CAPABILITY_ID_MAX_LENGTH = 48;

/**
 * Everything this cabinet declares. Rows are added, never edited: see the rules
 * in the header. Every row below arrived in 0.9.7.53, the release before the
 * headers existed, so the panel also infers them for a 0.9.7.53 cabinet that
 * polls without the headers.
 */
export const CABINET_CAPABILITIES: readonly CabinetCapability[] = Object.freeze([
  // «Докупка трафика до сброса»: the add-on page says the reset ends the
  // purchase, dates it on the operator's clock and warns under 24 h. The one
  // capability the panel gates a SALE on: without it the offer is withheld.
  {
    id: 'web.addon-reset-end',
    since: '0.9.7.53',
    implementedBy: 'web/src/features/addons/add-on-end.ts',
  },
  // A subscription with no end date is neither renewed nor upgraded by a
  // purchase, and the page says why instead of offering a dead button.
  {
    id: 'web.lifetime-subscription',
    since: '0.9.7.53',
    implementedBy: 'web/src/features/renewal/lifetime-renewal.ts',
  },
  // The bell opens «Поддержка», not «Доп. опции», for «Докупка не применена».
  {
    id: 'web.bell-addon-not-applied',
    since: '0.9.7.53',
    implementedBy: 'web/src/lib/notification-target.ts',
  },
  // «Главная» and the other subscription dates follow the panel's «Часовой
  // пояс» (`displayTimeZone`) instead of the phone's calendar.
  {
    id: 'web.panel-timezone-dates',
    since: '0.9.7.53',
    implementedBy: 'web/src/lib/operator-time-zone-provider.tsx',
  },
  // The API tells the panel which appearance fields it did not take, for
  // «Кабинет не принял часть оформления» on «WEB Reiwa».
  {
    id: 'api.appearance-report',
    since: '0.9.7.53',
    implementedBy: 'src/infrastructure/public-config/delivery-report.ts',
  },
  // The API process polls the settings versions every ~20 s, the safety net
  // under the settings webhook (wired in `api/main.ts`).
  {
    id: 'api.config-version-poll',
    since: '0.9.7.53',
    implementedBy: 'src/infrastructure/config-versions/poller.ts',
  },
  // The bot process polls them too (wired in `bot/main.ts`).
  {
    id: 'bot.config-version-poll',
    since: '0.9.7.53',
    implementedBy: 'src/infrastructure/config-versions/poller.ts',
  },
  // A press on a button the bot no longer knows shows «Меню обновилось» and
  // the current menu instead of silence.
  {
    id: 'bot.stale-button-menu',
    since: '0.9.7.53',
    implementedBy: 'src/bot/pages/stale-button.ts',
  },
]);

/** The areas each process speaks for. The API serves the web app, so it speaks for `web` too. */
const AREAS_OF: Readonly<Record<ReiwaSurface, readonly CapabilityArea[]>> = Object.freeze({
  api: Object.freeze(['web', 'api'] as const),
  bot: Object.freeze(['bot'] as const),
  worker: Object.freeze([] as const),
});

function areaOf(id: string): string {
  return id.slice(0, id.indexOf('.'));
}

/** The ids `surface` declares, in registry order. */
export function declaredCapabilities(surface: ReiwaSurface): readonly string[] {
  const areas: readonly string[] = AREAS_OF[surface];
  return CABINET_CAPABILITIES.filter((capability) => areas.includes(areaOf(capability.id))).map(
    (capability) => capability.id,
  );
}

/** Whether `value` is a capability id in the shared format. */
export function isCapabilityId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CAPABILITY_ID_MAX_LENGTH && CAPABILITY_ID_PATTERN.test(value);
}

// ── The two headers ──────────────────────────────────────────────────────────

export const REIWA_CLIENT_HEADER = 'x-reiwa-client';
export const REIWA_CAPABILITIES_HEADER = 'x-reiwa-capabilities';

/**
 * What the panel reads from each header, at most. The panel drops what lies
 * beyond, so a registry past these limits would lose ids without a sound;
 * `test/capabilities.registry.test.ts` keeps it inside them.
 */
export const CLIENT_HEADER_MAX_LENGTH = 256;
export const CAPABILITIES_HEADER_MAX_LENGTH = 2048;
export const CAPABILITIES_HEADER_MAX_NAMES = 64;

/** Who is calling the panel: one process of this cabinet. */
export interface ReiwaClientIdentity {
  readonly surface: ReiwaSurface;
  /** The running release, `REIWA_BUILD_INFO.version`. */
  readonly version: string;
  /** The build's commit, 12 characters, or `unknown`. */
  readonly commit: string;
  /**
   * The container's hostname: `reiwa` or `reiwa-bot` in `docker-compose.yml`.
   * A restart in place keeps it, so the panel replaces that process's entry
   * instead of adding a second one.
   */
  readonly instance: string;
  readonly capabilities: readonly string[];
}

function hostnameOrUnknown(): string {
  try {
    return hostname();
  } catch {
    return 'unknown';
  }
}

/** The identity of this process, as `surface`. */
export function reiwaClientIdentity(surface: ReiwaSurface, instance: string = hostnameOrUnknown()): ReiwaClientIdentity {
  return {
    surface,
    version: REIWA_BUILD_INFO.version,
    commit: REIWA_BUILD_INFO.commit,
    instance,
    capabilities: declaredCapabilities(surface),
  };
}

/** The longest value `x-reiwa-client` carries per key: four keys stay inside 256 characters. */
const CLIENT_VALUE_MAX_LENGTH = 64;

/**
 * One value of `x-reiwa-client`, reduced to characters that are safe in a
 * header and cannot be read as a separator (`;`, `=`, `,`).
 *
 * This is not cosmetic. undici REFUSES a request whose header value holds a
 * control character or any character outside ASCII (`UND_ERR_INVALID_ARG`,
 * checked on undici 8.10). A development machine named «ПК-Дизайн», or a
 * `REIWA_VERSION` with a stray newline, would otherwise fail every call to the
 * panel, not only this header.
 */
function clientValue(value: string): string {
  const safe = value.replace(/[^\w.+-]+/g, '_').slice(0, CLIENT_VALUE_MAX_LENGTH);
  return /[A-Za-z0-9]/.test(safe) ? safe : 'unknown';
}

/** The two headers for `identity`, exactly as the panel reads them. */
export function formatIdentityHeaders(identity: ReiwaClientIdentity): Readonly<Record<string, string>> {
  const client = [
    `surface=${clientValue(identity.surface)}`,
    `version=${clientValue(identity.version)}`,
    `commit=${clientValue(identity.commit)}`,
    `instance=${clientValue(identity.instance)}`,
  ].join('; ');
  return Object.freeze({
    [REIWA_CLIENT_HEADER]: client,
    // Sent even when empty, from the worker: "declares nothing" is a claim of
    // its own. Only ids in the shared format go out.
    [REIWA_CAPABILITIES_HEADER]: identity.capabilities.filter(isCapabilityId).join(','),
  });
}

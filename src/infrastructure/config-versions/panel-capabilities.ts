/**
 * What the panel says about itself, and where the cabinet keeps it.
 *
 * The other direction of `core/capabilities.ts` (pair design D1 §6.6). A panel
 * 0.9.7.71 or newer adds `panel: { version, capabilities }` to its answer to
 * the version poll. The capabilities are `panel.*` ids: what that panel can do
 * for a cabinet.
 *
 * NOTHING IN THIS CABINET ASKS YET. The carrier ships first because a signal
 * has to exist on the OLDER side before anything can depend on it: without it,
 * a panel that does not say what it can do looks exactly like a panel that
 * can do nothing. The first feature that needs a newer panel hides itself
 * unless `can('panel.<id>')` says yes. The detections that exist today (a 404
 * on a route, a missing field) stay exactly as they are.
 *
 * ── What is kept (`redis/keys.ts` `panelCapabilitiesKey`) ───────────────────
 *
 * One small JSON value with no TTL, written after every answered poll of
 * reiwa-api and of reiwa-bot:
 *  - `declared`: the answer carried the block. Its version and its `panel.*`
 *    ids are kept; anything else in the list is dropped.
 *  - `legacy`: the panel said nothing about itself. Either it answered without
 *    the block (panel 0.9.7.70, the first with the poll), or it answered the
 *    poll itself with 404 (a panel older than 0.9.7.70). Written OVER whatever
 *    was there, so a panel rolled back to an older release never keeps the
 *    capabilities of the newer one.
 * A poll that fails any other way changes nothing: no answer, a 5xx, or an
 * answer without versions says nothing about what the panel is.
 *
 * Both processes write the same key and the last writer wins. They talk to the
 * same panel, so they differ only for the moment a panel restarts on a new
 * release, and the next poll settles it.
 *
 * Best-effort both ways, like `latest.ts`: a write that fails is a log line,
 * a read that fails is "nothing known", and "nothing known" is "no".
 */
import type { Redis } from 'ioredis';

import type { LoggerPort } from '../../application/ports/logger.port.js';
import { isCapabilityId } from '../../core/capabilities.js';
import { panelCapabilitiesKey } from '../redis/keys.js';

/** What one poll heard the panel say about itself. */
export type PanelView =
  | {
      readonly kind: 'declared';
      /** The panel's release, or `null` when it sent none in the known format. */
      readonly version: string | null;
      /** Its `panel.*` ids, deduplicated, in the order it sent them. */
      readonly capabilities: readonly string[];
    }
  | {
      readonly kind: 'legacy';
      /** `no-block`: it answered the poll without the block. `no-route`: it answered the poll with 404. */
      readonly why: 'no-block' | 'no-route';
    };

export const PANEL_LEGACY_NO_BLOCK: PanelView = Object.freeze({ kind: 'legacy', why: 'no-block' });
export const PANEL_LEGACY_NO_ROUTE: PanelView = Object.freeze({ kind: 'legacy', why: 'no-route' });

/** What the key holds. */
export interface KnownPanel {
  readonly kind: 'declared' | 'legacy';
  /** Always `null` for `legacy`. */
  readonly version: string | null;
  /** Always empty for `legacy`. */
  readonly capabilities: readonly string[];
  /** Epoch ms of the answer it came from. */
  readonly at: number;
}

/** A panel release as the panel writes its own: `0.9.7.71`, `v0.9.7.71`, `0.9.7.71-rc.1`. */
const PANEL_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/;
const PANEL_VERSION_MAX_LENGTH = 32;
/** The most ids kept from one answer: the panel's own bound on what it reads from a cabinet. */
const PANEL_CAPABILITIES_MAX = 64;
const PANEL_AREA = 'panel.';

function isPanelVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PANEL_VERSION_MAX_LENGTH && PANEL_VERSION_PATTERN.test(value);
}

/** The `panel.*` ids out of a list the panel sent; anything else is dropped. */
function panelCapabilitiesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const kept: string[] = [];
  for (const item of value) {
    if (kept.length >= PANEL_CAPABILITIES_MAX) break;
    if (isCapabilityId(item) && item.startsWith(PANEL_AREA) && !kept.includes(item)) kept.push(item);
  }
  return kept;
}

/**
 * What an ANSWERED poll says about the panel. An answer without the block is
 * `legacy`: the panel was asked, and said nothing about itself.
 */
export function panelOf(answer: unknown): PanelView {
  if (typeof answer !== 'object' || answer === null) return PANEL_LEGACY_NO_BLOCK;
  const panel = (answer as { panel?: unknown }).panel;
  if (typeof panel !== 'object' || panel === null || Array.isArray(panel)) return PANEL_LEGACY_NO_BLOCK;
  const { version, capabilities } = panel as { version?: unknown; capabilities?: unknown };
  return {
    kind: 'declared',
    version: isPanelVersion(version) ? version : null,
    capabilities: panelCapabilitiesOf(capabilities),
  };
}

/** Whether the panel, as last heard, declared `id`. Nothing known is "no". */
export function panelCan(known: KnownPanel | null, id: string): boolean {
  return known !== null && known.kind === 'declared' && known.capabilities.includes(id);
}

export interface PanelCapabilitiesPort {
  /** Keep what a poll heard, over whatever was kept. Never throws. */
  record(panel: PanelView, at: number): Promise<void>;
  /** What is kept; `null` when nothing is, or it cannot be read. Never throws. */
  read(): Promise<KnownPanel | null>;
  /** `panelCan` over what is kept. Never throws. */
  can(id: string): Promise<boolean>;
}

/** Without Redis: nothing is kept, so the panel can do nothing new. */
export const NOOP_PANEL_CAPABILITIES: PanelCapabilitiesPort = {
  record: async () => undefined,
  read: async () => null,
  can: async () => false,
};

function knownOf(panel: PanelView, at: number): KnownPanel {
  return panel.kind === 'declared'
    ? { kind: 'declared', version: panel.version, capabilities: [...panel.capabilities], at }
    : { kind: 'legacy', version: null, capabilities: [], at };
}

/** The key's value, or `null` when it is not what `record` writes. */
function parseKnown(raw: string): KnownPanel | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { kind, version, capabilities, at } = parsed as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  if (kind === 'legacy') return { kind: 'legacy', version: null, capabilities: [], at };
  if (kind !== 'declared') return null;
  const kept = version === null ? null : isPanelVersion(version) ? version : undefined;
  if (kept === undefined) return null;
  return { kind: 'declared', version: kept, capabilities: panelCapabilitiesOf(capabilities), at };
}

type PanelRedis = Pick<Redis, 'get' | 'set'>;

export class RedisPanelCapabilities implements PanelCapabilitiesPort {
  private readonly redis: PanelRedis;
  private readonly logger: LoggerPort | undefined;

  public constructor(options: { readonly redis: PanelRedis; readonly logger?: LoggerPort }) {
    this.redis = options.redis;
    this.logger = options.logger;
  }

  public async record(panel: PanelView, at: number): Promise<void> {
    try {
      // A plain SET with no expiry: it replaces the value AND any TTL.
      await this.redis.set(panelCapabilitiesKey(), JSON.stringify(knownOf(panel, at)));
    } catch (err: unknown) {
      this.logger?.warn({ err }, 'panel capabilities: write failed');
    }
  }

  public async read(): Promise<KnownPanel | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(panelCapabilitiesKey());
    } catch (err: unknown) {
      this.logger?.debug({ err }, 'panel capabilities: read failed; nothing is known');
      return null;
    }
    return raw === null ? null : parseKnown(raw);
  }

  public async can(id: string): Promise<boolean> {
    return panelCan(await this.read(), id);
  }
}

/** One line per change, so the log shows it once and not every 20 s. */
function summaryOf(panel: PanelView): string {
  return panel.kind === 'declared'
    ? `declared|${panel.version ?? ''}|${panel.capabilities.join(',')}`
    : `legacy|${panel.why}`;
}

/**
 * The version poll's `onPanel` for one process: keeps every view the poll hears
 * in `store`, and says in the log when it changed — once per change.
 */
export function panelRecorder(
  store: PanelCapabilitiesPort,
  options: { readonly consumer: 'api' | 'bot'; readonly logger?: LoggerPort },
): (panel: PanelView, at: number) => void {
  let last: string | null = null;
  return (panel, at) => {
    const summary = summaryOf(panel);
    if (summary !== last) {
      last = summary;
      const { consumer, logger } = options;
      if (panel.kind === 'declared') {
        logger?.info(
          { consumer, panelVersion: panel.version, capabilities: panel.capabilities },
          'panel capabilities: the panel says what it can do',
        );
      } else if (panel.why === 'no-block') {
        logger?.info(
          { consumer },
          'panel capabilities: the panel does not say what it can do (a panel older than 0.9.7.71); kept as legacy',
        );
      } else {
        logger?.info(
          { consumer },
          'panel capabilities: the panel has no version poll (a panel older than 0.9.7.70); kept as legacy',
        );
      }
    }
    void store.record(panel, at);
  };
}

/**
 * Open pages pick up a settings change within a minute — the owner's rule of
 * 24.09.2026: «Открытые страницы обновляются в течение минуты».
 *
 * Nothing used to tell an open page that the operator saved something. The
 * cabinet, the Mini App, the landing and the sign-in page kept what they had
 * loaded until they were reloaded or hidden and shown again — and even then
 * the browser's own cache (`max-age=60`, `stale-while-revalidate=300` on these
 * routes) and the service worker (the landing, 24 h) could answer with the copy
 * from before the save (W8 report D3).
 *
 * `/api/v1/config-versions` answers, from the API process's memory and never
 * cached, which version of each settings group the cabinet holds. This watcher:
 *
 *   - asks every minute while the page is visible, and at once (at most every
 *     ten seconds) when it is shown again — `visibilitychange` to visible, and
 *     `pageshow`, which is the only signal a thawed WebKit page gives. No timer
 *     runs while the page is hidden; a failing ask backs off quietly;
 *   - the first answer only records what the cabinet holds. A later answer
 *     that moves a group from one version to ANOTHER (never to or from
 *     "nothing held") refetches that group's queries — the queries the pages
 *     read, so the pages redraw from the new data, and nothing else moves: no
 *     reload, no form reset, no scroll;
 *   - once a group's version is known, every read of it carries `?v=<version>`
 *     (`configVersionRequest`). The routes ignore the query, but it is a URL
 *     neither the browser's cache nor the service worker has seen, so the old
 *     copy cannot answer — and a plain read cannot put it back afterwards;
 *   - where the route names the version of the body it served
 *     (`X-Config-Version` on `/public-config`, `/landing`, `/connect-page`), a
 *     body older than what the cabinet holds — a copy the browser cache or the
 *     service worker answered with just after a save, or on a fresh load
 *     before the first answer — is refetched as soon as it is noticed
 *     (`noteServed`).
 *
 * A group nobody on the page reads costs nothing: refetching queries that do
 * not exist does nothing, and the next read of the group carries the version.
 */
import type { QueryClient } from "@tanstack/react-query";

/** The settings groups the SPA reads, by the name `/config-versions` gives them. */
export type WatchedConfigGroup =
  | "publicConfig"
  | "landing"
  | "connectPage"
  | "customEmojiPacks"
  | "platformPolicy"
  | "guestSupport";

/**
 * Every React Query key that reads each group — `/api/v1/branding` is part of
 * `publicConfig` on the server, but nothing in the SPA reads it.
 */
export const WATCHED_CONFIG_GROUPS: Readonly<Record<WatchedConfigGroup, readonly (readonly string[])[]>> = {
  /** `/public-config` — `BrandingProvider` (and through it the localStorage first-paint copy). */
  publicConfig: [["public-config"]],
  /** `/landing` — the landing page and the `/` entry router. */
  landing: [["landing"]],
  /** `/connect-page` — the connect screen, its door on the dashboard, the trampoline. */
  connectPage: [["connect-page"]],
  /** `/custom-emoji/packs` — the notification feed. */
  customEmojiPacks: [["custom-emoji-packs"]],
  /** `/platform-policy` — access mode, the claim gate, link recovery. */
  platformPolicy: [["platform-policy"]],
  /** `/support/guest/config` — the guest chat's link and page. */
  guestSupport: [["guest-support-config"]],
};

const GROUPS = Object.keys(WATCHED_CONFIG_GROUPS) as WatchedConfigGroup[];

/** The query parameter a versioned read carries. The server routes ignore it. */
export const CONFIG_VERSION_PARAM = "v";

/** The response header naming the version of the body served (`/public-config`, `/landing`, `/connect-page`). */
export const CONFIG_VERSION_HEADER = "x-config-version";

export const CONFIG_VERSION_POLL_INTERVAL_MS = 60_000;
/** A return to the page asks at once — but not more often than this. */
export const CONFIG_VERSION_RETURN_THROTTLE_MS = 10_000;
/** Failed asks back off to this. */
export const CONFIG_VERSION_MAX_BACKOFF_MS = 10 * 60_000;

export interface ConfigVersionWatcherDeps {
  /** `GET /api/v1/config-versions` — `{ versions: { <group>: <version> | null } }`. */
  readonly fetchVersions: () => Promise<unknown>;
  /**
   * Refetch every query of a group; resolves to whether it succeeded (a query
   * that ended in error is a failure, and is tried again at the next ask).
   */
  readonly refetchGroup: (group: WatchedConfigGroup) => Promise<boolean>;
}

interface GroupState {
  /** The latest version the cabinet said it holds. */
  known?: string;
  /** The version the page's copy is taken to be. */
  current?: string;
  /** The `known` version a refetch last succeeded for — never refetched for twice. */
  settled?: string;
  refetching: boolean;
  /** Bumped by every `noteServed`, so a refetch can tell whether its body named itself. */
  notes: number;
}

/** The versions out of the answer; a value that is not a version is "nothing held". */
function versionsOf(answer: unknown): Readonly<Record<string, string>> | null {
  const versions = (answer as { versions?: unknown } | null | undefined)?.versions;
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(versions as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

export class ConfigVersionWatcher {
  private readonly groups = new Map<WatchedConfigGroup, GroupState>();
  private deps: ConfigVersionWatcherDeps | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private asking: Promise<void> | null = null;
  private lastAskAt = Number.NEGATIVE_INFINITY;
  /** Failed asks in a row. */
  private failures = 0;

  public constructor(
    private readonly options: {
      readonly intervalMs?: number;
      readonly returnThrottleMs?: number;
      readonly maxBackoffMs?: number;
      readonly now?: () => number;
    } = {},
  ) {}

  /** The version a read of `group` should carry — the latest the cabinet said it holds. */
  public versionOf(group: WatchedConfigGroup): string | undefined {
    return this.state(group).known;
  }

  /**
   * A body of `group` arrived and named its version. If the cabinet already
   * holds a newer one — the browser's cache answered with an old copy — the
   * group is refetched now rather than at the next ask.
   */
  public noteServed(group: WatchedConfigGroup, version: string | null | undefined): void {
    if (typeof version !== "string" || version.length === 0) return;
    const state = this.state(group);
    state.notes += 1;
    state.current = version;
    this.reconcile(group);
  }

  /** Start watching: now, if the page is visible, then every interval. Idempotent. */
  public start(deps: ConfigVersionWatcherDeps): void {
    this.deps = deps;
    if (this.running) return;
    this.running = true;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("pageshow", this.onPageShow);
    this.onReturn();
  }

  /** Stop: no timer and no listener survive. The versions learned are kept. */
  public stop(): void {
    this.running = false;
    this.clearTimer();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("pageshow", this.onPageShow);
  }

  /** One ask. Never rejects; a failure is counted and backs the next one off. */
  public ask(): Promise<void> {
    if (this.asking !== null) return this.asking;
    const deps = this.deps;
    if (deps === null) return Promise.resolve();
    this.lastAskAt = this.now();
    const asking = (async () => {
      try {
        const versions = versionsOf(await deps.fetchVersions());
        if (versions === null) throw new Error("no versions in the answer");
        this.failures = 0;
        this.apply(versions);
      } catch {
        // Quiet on purpose: a 404 from an older cabinet API, a 5xx, a dropped
        // connection — the page keeps what it has and asks again later.
        this.failures += 1;
      }
    })().finally(() => {
      if (this.asking === asking) this.asking = null;
    });
    this.asking = asking;
    return asking;
  }

  private apply(versions: Readonly<Record<string, string>>): void {
    for (const group of GROUPS) {
      const version = versions[group];
      // Nothing held (or a group this API does not version): nothing to act on,
      // and nothing to forget — `null` between two versions is not a change.
      if (version === undefined) continue;
      const state = this.state(group);
      const first = state.known === undefined;
      state.known = version;
      // The first answer only records — unless the page's copy named an older
      // version of itself before it (`noteServed`).
      if (first && state.current === undefined) state.current = version;
      this.reconcile(group);
    }
  }

  /** Refetch a group whose copy is not the version the cabinet holds. */
  private reconcile(group: WatchedConfigGroup): void {
    const state = this.state(group);
    const known = state.known;
    if (
      known === undefined ||
      state.current === known ||
      state.settled === known ||
      state.refetching ||
      this.deps === null
    ) {
      return;
    }
    const refetchGroup = this.deps.refetchGroup;
    const notesBefore = state.notes;
    state.refetching = true;
    void Promise.resolve()
      .then(() => refetchGroup(group))
      .catch(() => false)
      .then((ok) => {
        state.refetching = false;
        if (!ok) return; // kept stale; the next ask tries again
        // Never refetched for this version twice: a body that names a version
        // other than the one asked for (the cabinet moved on meanwhile) waits
        // for the next ask to say so, instead of looping.
        state.settled = known;
        if (state.notes === notesBefore) state.current = known;
      });
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") this.onReturn();
    else this.clearTimer();
  };

  private readonly onPageShow = (): void => {
    this.onReturn();
  };

  /** Shown (again): ask now unless an ask is recent; either way keep one timer. */
  private onReturn(): void {
    if (!this.running || document.visibilityState !== "visible") return;
    const since = this.now() - this.lastAskAt;
    if (since < (this.options.returnThrottleMs ?? CONFIG_VERSION_RETURN_THROTTLE_MS)) {
      if (this.timer === null) this.schedule(Math.max(0, this.nextDelay() - since));
      return;
    }
    void this.tick();
  }

  private async tick(): Promise<void> {
    this.clearTimer();
    await this.ask();
    if (this.running && document.visibilityState === "visible") this.schedule(this.nextDelay());
  }

  private nextDelay(): number {
    const interval = this.options.intervalMs ?? CONFIG_VERSION_POLL_INTERVAL_MS;
    if (this.failures === 0) return interval;
    return Math.min(interval * 2 ** this.failures, this.options.maxBackoffMs ?? CONFIG_VERSION_MAX_BACKOFF_MS);
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private state(group: WatchedConfigGroup): GroupState {
    let state = this.groups.get(group);
    if (state === undefined) {
      state = { refetching: false, notes: 0 };
      this.groups.set(group, state);
    }
    return state;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** The page's one watcher: the reads below consult it, `ConfigVersionWatcherMount` runs it. */
export const configVersionWatcher = new ConfigVersionWatcher();

/**
 * Refetch every query that reads `group`, through its own query function —
 * which now carries the group's version, so neither the browser cache nor the
 * service worker can answer. A key no page has read is skipped; a query that
 * ended in error fails the group, which the watcher then tries again at its
 * next ask.
 *
 * A read already in flight is let land FIRST. `refetchQueries` restarts a read
 * that has data, but JOINS one that has none yet — React Query dedupes a first
 * load — and that first load may be the very read that brought the old copy
 * (the browser cache answered it, and its body named the old version on the
 * way out). Joining it would settle on the old copy. Cancelling it instead
 * would reject whoever awaits it — the `/` entry router awaits the landing's
 * first read and sends a visitor to sign-in on any failure.
 */
export async function refetchConfigGroup(
  queryClient: QueryClient,
  group: WatchedConfigGroup,
): Promise<boolean> {
  const keys = WATCHED_CONFIG_GROUPS[group];
  await Promise.all(
    keys.map(async (queryKey) => {
      const query = queryClient.getQueryCache().find({ queryKey, exact: true });
      if (query?.state.fetchStatus === "fetching") await query.promise?.catch(() => undefined);
      await queryClient.refetchQueries({ queryKey, exact: true });
    }),
  );
  return keys.every((queryKey) => queryClient.getQueryState(queryKey)?.status !== "error");
}

/**
 * The request config a read of `group` goes out with: `?v=<version>` once the
 * cabinet has said which version it holds, else nothing (a plain read).
 */
export function configVersionRequest(
  group: WatchedConfigGroup,
): { readonly params: Readonly<Record<string, string>> } | undefined {
  const version = configVersionWatcher.versionOf(group);
  return version === undefined ? undefined : { params: { [CONFIG_VERSION_PARAM]: version } };
}

/** The version a response names in `X-Config-Version`, if it names one. */
export function servedConfigVersion(headers: unknown): string | undefined {
  if (typeof headers !== "object" || headers === null) return undefined;
  const record = headers as { get?: unknown } & Record<string, unknown>;
  const value =
    typeof record.get === "function"
      ? (record.get as (name: string) => unknown).call(headers, CONFIG_VERSION_HEADER)
      : record[CONFIG_VERSION_HEADER];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

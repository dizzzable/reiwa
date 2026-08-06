/**
 * The ONE place that decides what a device list looks like when the read did
 * not succeed.
 *
 * The cabinet used to render a failed read as the friendly "no devices yet"
 * card: `data` came back undefined, `devices` fell back to `[]`, and the
 * customer read a panel outage as "all my slots are free". rezeis-admin now
 * fails that read (503 / 502) and reiwa's BFF forwards the failure, so the
 * cabinet can finally tell the two apart — but only if every reader branches
 * on the error instead of on `devices.length`.
 *
 * The rules, deliberately shared by the devices page, the dashboard list and
 * the subscription card:
 *
 *   - a failed read NEVER shows the empty state. "We could not check" and
 *     "you have none" are different sentences and the customer acts on them
 *     differently.
 *   - a failed read with no cached rows yields NO count. `deviceCount` is
 *     `null`, not 0 — any number invented here is the same lie in a smaller
 *     space, and a "0 + a flag" payload is one existing callers render as
 *     "no devices".
 *   - a failed REFRESH over rows we already hold keeps showing those rows and
 *     their count, flagged by the error card (same as `resolveFaqViewState`).
 *     They were true when we read them and the flag says they may be stale.
 *   - the empty state stays reachable: a successful read of an empty list is
 *     still the friendly card, unchanged.
 */
import type { DevicesResponse, HwidDevice } from "@/types/api";

export interface DevicesViewState {
  /** Rows to render. Empty while a first read is failing or in flight. */
  readonly devices: HwidDevice[];
  /** Show the "could not load, try again" card. */
  readonly showLoadError: boolean;
  /** Show the friendly "no devices yet" card. Never true on a failed read. */
  readonly showEmptyState: boolean;
  /**
   * Count safe to display, or `null` when the list is unknown. Callers MUST
   * render `null` as words ("unavailable"), never as a number.
   */
  readonly deviceCount: number | null;
}

export function resolveDevicesViewState(
  data: DevicesResponse | undefined,
  isError: boolean,
): DevicesViewState {
  const devices = data?.devices ?? [];
  const hasRows = data !== undefined;

  return {
    devices,
    showLoadError: isError,
    // `data !== undefined` keeps the empty card off the screen while the very
    // first read is still in flight; `!isError` keeps it off a failed one.
    showEmptyState: !isError && hasRows && devices.length === 0,
    deviceCount: hasRows
      ? (data?.total ?? devices.length)
      : isError
        ? null
        : 0,
  };
}

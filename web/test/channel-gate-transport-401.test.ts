import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A 401 FROM THE CHANNEL GATE MUST REACH THE GATE.
 *
 * The shared transport answers a 401 on any request outside its benign list
 * with `window.location.replace("/sign-in")`, and it does so BEFORE the caller's
 * catch runs. For the channel gate that would invert its contract — a check
 * that cannot be made is supposed to let the user in — into a password form
 * inside Telegram.
 *
 * Driven through the real transport and the real API functions; only the
 * adapter (the network) and `window.location` are doubles. jsdom cannot serve
 * here: its `location.replace` is unforgeable and does not navigate, so a
 * bounce would be invisible — this file runs in the node environment with a
 * location it can read back. Each case gets a fresh module, because the
 * transport bounces at most once per document.
 */

const replace = vi.fn();

/** The network, answering every request with the session guard's 401. */
const unauthorized: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  throw new AxiosError("Request failed with status code 401", AxiosError.ERR_BAD_REQUEST, config, null, {
    status: 401,
    statusText: "Unauthorized",
    headers: {},
    config,
    data: { message: "Unauthorized" },
  });
};

async function freshModules() {
  vi.resetModules();
  const { apiClient } = await import("@/lib/api-client/transport");
  apiClient.defaults.adapter = unauthorized;
  const gate = await import("@/lib/api-client/channel-gate");
  const session = await import("@/lib/api-client/session");
  return { gate, session };
}

beforeEach(() => {
  replace.mockReset();
  // A cabinet route, not one of the transport's public pages.
  vi.stubGlobal("window", { location: { pathname: "/dashboard", replace } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a 401 on the Mini App's channel gate", () => {
  it("still bounces any other cabinet request to the sign-in form — the control for the cases below", async () => {
    const { session } = await freshModules();

    await expect(session.getPlatformPolicy()).rejects.toMatchObject({ response: { status: 401 } });

    expect(replace, "the double cannot see a bounce, so the cases below prove nothing").toHaveBeenCalledWith("/sign-in");
  });

  it("is handed back to the gate from GET /channel-gate, without a bounce", async () => {
    const { gate } = await freshModules();

    await expect(gate.getChannelGate()).rejects.toMatchObject({ response: { status: 401 } });

    expect(replace, "a failed first check sent a Mini App user to a password form").not.toHaveBeenCalled();
  });

  it("is handed back to the gate from POST /channel-gate/check, without a bounce", async () => {
    const { gate } = await freshModules();

    await expect(gate.checkChannelGate()).rejects.toMatchObject({ response: { status: 401 } });

    expect(replace, "«Я подписался» sent a Mini App user to a password form").not.toHaveBeenCalled();
  });
});

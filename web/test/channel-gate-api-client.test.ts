import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkChannelGate,
  getChannelGate,
  readChannelGateAnswer,
  readChannelGateFailure,
} from "@/lib/api-client/channel-gate";
import { apiClient } from "@/lib/api-client/transport";

/**
 * THE MINI APP'S CHANNEL GATE, AS IT GOES OVER THE WIRE.
 *
 * Two calls against the contract the API serves — `GET /channel-gate` and
 * `POST /channel-gate/check` with an empty JSON body — both through the shared
 * axios instance, which is what carries the session cookie; the CSRF guard
 * reads the `Origin` the browser attaches, so nothing else is added.
 *
 * Then the two ways a reply is read. The ANSWER: nothing but a real
 * `not-subscribed` may block, and nothing but an http(s) link may reach the join
 * button. The FAILURE: a 401 and a 429 are what the gate acts on, and a 429's
 * wait is read from the body, then the header, then a fallback. Each refusal
 * below sits next to the case it must not swallow, so a reader that refuses
 * everything cannot pass.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getChannelGate", () => {
  it("reads GET /channel-gate through the shared client and hands back status and joinUrl", async () => {
    const get = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: { status: "not-subscribed", joinUrl: "https://t.me/reiwa_news" } });

    await expect(getChannelGate()).resolves.toEqual({
      status: "not-subscribed",
      joinUrl: "https://t.me/reiwa_news",
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]).toEqual(["/channel-gate", undefined]);
  });

  it("hands the caller's abort signal to the request", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: { status: "off", joinUrl: null } });
    const abandon = new AbortController();

    await getChannelGate({ signal: abandon.signal });

    expect(get.mock.calls[0]).toEqual(["/channel-gate", { signal: abandon.signal }]);
  });

  it("reads a malformed body through the answer reader instead of passing it on", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({ data: "<html>502 Bad Gateway</html>" });

    await expect(getChannelGate()).resolves.toEqual({ status: "unverified", joinUrl: null });
  });
});

describe("checkChannelGate", () => {
  it("POSTs /channel-gate/check with an empty JSON object through the shared client", async () => {
    const post = vi
      .spyOn(apiClient, "post")
      .mockResolvedValue({ data: { status: "subscribed", joinUrl: null } });

    await expect(checkChannelGate()).resolves.toEqual({ status: "subscribed", joinUrl: null });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual(["/channel-gate/check", {}, undefined]);
  });

  it("hands the caller's abort signal to the request, so a check can be given a budget", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { status: "subscribed", joinUrl: null } });
    const abandon = new AbortController();

    await checkChannelGate({ signal: abandon.signal });

    expect(post.mock.calls[0]).toEqual(["/channel-gate/check", {}, { signal: abandon.signal }]);
  });

  it("reads a malformed body through the answer reader instead of passing it on", async () => {
    vi.spyOn(apiClient, "post").mockResolvedValue({ data: { status: "blocked", joinUrl: "javascript:alert(1)" } });

    await expect(checkChannelGate()).resolves.toEqual({ status: "unverified", joinUrl: null });
  });
});

describe("the answer is read so that only a real not-subscribed blocks", () => {
  it.each(["off", "subscribed", "not-subscribed", "unverified"] as const)(
    "keeps the status %s as the API sent it",
    (status) => {
      expect(readChannelGateAnswer({ status, joinUrl: null }).status).toBe(status);
    },
  );

  it.each([
    ["a status this build has never heard of", { status: "blocked", joinUrl: null }],
    ["a status in another case", { status: "NOT-SUBSCRIBED", joinUrl: null }],
    ["no status at all", { joinUrl: null }],
    ["a body that is not an object", "<html>proxy error</html>"],
    ["no body", null],
  ])("reads %s as unverified", (_label, raw) => {
    expect(readChannelGateAnswer(raw)).toEqual({ status: "unverified", joinUrl: null });
  });
});

describe("the join link reaches the button only as http or https", () => {
  it.each(["https://t.me/reiwa_news", "https://t.me/+AbCdEf123", "http://t.me/reiwa_news"])(
    "keeps %s exactly as sent",
    (joinUrl) => {
      expect(readChannelGateAnswer({ status: "not-subscribed", joinUrl }).joinUrl).toBe(joinUrl);
    },
  );

  it.each([
    // No way out of a Mini App opens these: the SDK refuses them, and without it
    // Telegram for Android shows an error page. The server sends https instead.
    ["a tg:// resolve link", "tg://resolve?domain=reiwa_news"],
    ["a tg:// join link", "tg://join?invite=AbCdEf123"],
    ["a javascript: address", "javascript:alert(document.cookie)"],
    ["a vbscript: address", "vbscript:msgbox(1)"],
    ["a file: address", "file:///etc/passwd"],
    ["an intent: address", "intent://t.me/reiwa_news#Intent;scheme=https;end"],
    ["a data: address", "data:text/html,<script>alert(1)</script>"],
    ["a relative path", "/dashboard"],
    ["a bare channel name", "reiwa_news"],
    ["an empty string", ""],
    ["a number", 42],
  ])("drops %s", (_label, joinUrl) => {
    const answer = readChannelGateAnswer({ status: "not-subscribed", joinUrl });
    expect(answer).toEqual({ status: "not-subscribed", joinUrl: null });
  });
});

/** A rejection as axios produces it, headers and all. */
function rejection(status: number, data: unknown, headers: AxiosHeaders | Record<string, string> = {}): AxiosError {
  const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  return new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, {
    status,
    statusText: "",
    headers,
    config,
    data,
  });
}

describe("a failure is read into what the gate acts on", () => {
  it("reads a 401 as a session that is gone", () => {
    expect(readChannelGateFailure(rejection(401, { message: "Unauthorized" }))).toEqual({ kind: "unauthorized" });
  });

  it("takes a 429's wait from the body first", () => {
    const error = rejection(429, { message: "Too many requests", retryAfter: 42 }, new AxiosHeaders({ "Retry-After": "7" }));
    expect(readChannelGateFailure(error)).toEqual({ kind: "rate-limited", retryAfterSeconds: 42 });
  });

  it("takes a 429's wait from the Retry-After header when the body has none, whatever its case", () => {
    expect(readChannelGateFailure(rejection(429, {}, new AxiosHeaders({ "Retry-After": "37" })))).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 37,
    });
    expect(readChannelGateFailure(rejection(429, "Too Many Requests", { "retry-after": "12" }))).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 12,
    });
  });

  it.each([
    ["a word in the body and a negative header", { retryAfter: "soon" }, { "Retry-After": "-5" }],
    ["a zero in the body", { retryAfter: 0 }, {}],
    ["a negative number in the body", { retryAfter: -5 }, {}],
    ["a number that is not finite", { retryAfter: Number.POSITIVE_INFINITY }, {}],
    ["no body and no header", null, {}],
  ])("does not take %s for a wait, and falls back to a minute", (_label, data, headers) => {
    const error = rejection(429, data, new AxiosHeaders(headers as Record<string, string>));
    expect(readChannelGateFailure(error)).toEqual({ kind: "rate-limited", retryAfterSeconds: 60 });
  });

  it("rounds a fractional wait up, so the button is never back early", () => {
    expect(readChannelGateFailure(rejection(429, { retryAfter: 2.1 }))).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 3,
    });
  });

  it.each([
    ["a 500", rejection(500, { message: "boom" })],
    ["a 403 from the CSRF guard", rejection(403, { message: "Forbidden: origin not allowed" })],
    ["an abandoned request", new AxiosError("canceled", AxiosError.ERR_CANCELED)],
    ["a dropped connection", new AxiosError("Network Error", AxiosError.ERR_NETWORK)],
    ["something that is not an axios error at all", new TypeError("x is undefined")],
    ["a thrown string", "boom"],
  ])("reads %s as another failure", (_label, error) => {
    expect(readChannelGateFailure(error)).toEqual({ kind: "other" });
  });
});

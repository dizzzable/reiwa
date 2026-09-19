// @vitest-environment jsdom

/**
 * A push clicked while the cabinet is open.
 *
 * The service worker focuses the open window and posts `{ type: 'NAVIGATE',
 * url }`. Nothing listened, so the click brought the window forward and left it
 * on whatever page it was showing — the renewal reminder did not open renewal,
 * and «Не получилось подключиться?» did not open the connect page.
 *
 * The URL arrives out of a push payload and is handed to the router, so it is
 * held to the rule every other hop here applies to a destination it did not
 * build: a same-origin PATH, nothing else. The cases at the bottom are the
 * shapes that must never move the page.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SW_NAVIGATE_MESSAGE,
  readServiceWorkerNavigation,
  useServiceWorkerNavigate,
} from "../src/lib/sw-navigate";

const OWN = "https://cabinet.example.test";

describe("what a NAVIGATE message may ask for", () => {
  const ask = (url: unknown, origin: string = OWN, type: unknown = SW_NAVIGATE_MESSAGE) =>
    readServiceWorkerNavigation({ data: { type, url }, origin }, OWN);

  it("takes a path of our own, query and all", () => {
    expect(ask("/dashboard?connect=help&subscriptionId=cmsub001")).toBe(
      "/dashboard?connect=help&subscriptionId=cmsub001",
    );
    expect(ask("/renew")).toBe("/renew");
  });

  it("ignores a message from another origin, or from none", () => {
    expect(ask("/renew", "https://evil.example")).toBeNull();
    expect(ask("/renew", "")).toBeNull();
  });

  it("ignores an absolute URL, even one naming this origin", () => {
    expect(ask("https://evil.example/phish")).toBeNull();
    expect(ask(`${OWN}/renew`)).toBeNull();
  });

  it("ignores the shapes that parse as another origin or run as script", () => {
    for (const url of [
      "//evil.example/phish",
      "/\\evil.example/phish",
      "/\t/evil.example",
      "javascript:alert(1)",
      "renew",
      "",
      42,
      null,
    ]) {
      expect(ask(url), String(url)).toBeNull();
    }
  });

  it("ignores every other message the worker sends", () => {
    expect(ask("/renew", OWN, "PUSH_RESYNC_FAILED")).toBeNull();
    expect(readServiceWorkerNavigation({ data: null, origin: OWN }, OWN)).toBeNull();
    expect(readServiceWorkerNavigation({ data: "NAVIGATE", origin: OWN }, OWN)).toBeNull();
  });
});

describe("the listener, inside a router", () => {
  let container: HTMLDivElement;
  let root: Root;
  let worker: EventTarget;
  /** What the hook registered and unregistered, argument by argument. */
  let added: { readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> } };
  let removed: { readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> } };

  function Probe() {
    useServiceWorkerNavigate();
    const location = useLocation();
    return <span data-testid="where">{`${location.pathname}${location.search}`}</span>;
  }

  function where(): string {
    return container.querySelector("[data-testid='where']")?.textContent ?? "";
  }

  function post(data: unknown, origin = window.location.origin): void {
    act(() => {
      worker.dispatchEvent(new MessageEvent("message", { data, origin }));
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    worker = new EventTarget();
    added = vi.spyOn(worker, "addEventListener");
    removed = vi.spyOn(worker, "removeEventListener");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/settings"]}>
          <Routes>
            <Route path="*" element={<Probe />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(navigator, "serviceWorker");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("moves the router to the path the worker names", () => {
    expect(where()).toBe("/settings");
    post({ type: SW_NAVIGATE_MESSAGE, url: "/dashboard?connect=help&subscriptionId=cmsub001" });
    expect(where()).toBe("/dashboard?connect=help&subscriptionId=cmsub001");
  });

  it("stays put for a foreign origin, an absolute URL or a protocol-relative one", () => {
    post({ type: SW_NAVIGATE_MESSAGE, url: "/renew" }, "https://evil.example");
    post({ type: SW_NAVIGATE_MESSAGE, url: `${window.location.origin}/renew` });
    post({ type: SW_NAVIGATE_MESSAGE, url: "//evil.example/phish" });
    expect(where()).toBe("/settings");
    // Anti-vacuity: the same listener DOES move for a path, so "stayed put"
    // above is the filter's doing and not a listener that never ran.
    post({ type: SW_NAVIGATE_MESSAGE, url: "/renew" });
    expect(where()).toBe("/renew");
  });

  it("listens once, and stops when the shell goes away", () => {
    const registrations = added.mock.calls.filter((call) => call[0] === "message");
    expect(registrations).toHaveLength(1);
    const handler = registrations[0]?.[1];
    act(() => root.unmount());
    root = createRoot(container);
    expect(
      removed.mock.calls.some((call) => call[0] === "message" && call[1] === handler),
      "the listener outlived the shell and would push a dead router",
    ).toBe(true);
  });
});

describe("a browser without service workers", () => {
  function Bare() {
    useServiceWorkerNavigate();
    return <span>ok</span>;
  }

  function mount(): { host: HTMLDivElement; tree: Root } {
    const host = document.createElement("div");
    const tree = createRoot(host);
    act(() => {
      tree.render(
        <MemoryRouter>
          <Bare />
        </MemoryRouter>,
      );
    });
    return { host, tree };
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    vi.unstubAllGlobals();
  });

  it("mounts and does nothing when there is none", () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    const { host, tree } = mount();
    expect(host.textContent).toBe("ok");
    act(() => tree.unmount());
  });

  it("mounts and does nothing for half of one", () => {
    // A webview exposing the container without `addEventListener`. A throw in
    // the effect would take the whole shell down with it — and the tree with
    // it, which is what this reads.
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {} });
    const { host, tree } = mount();
    expect(host.textContent).toBe("ok");
    act(() => tree.unmount());
  });
});

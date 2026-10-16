import { describe, expect, it } from "vitest";

import { readCatalog, readConnectScreenMode, type ConnectApp } from "../src/features/connect/connect-catalog";
import {
  INITIAL_WALK,
  initialPlacement,
  planApp,
  stepNumber,
  subscriptionReadiness,
  walkReducer,
  type WalkState,
} from "../src/features/connect/wizard/wizard-model";
import { connectScreenFor } from "../src/features/connect/connect-route";

/**
 * The guided connect walk, without a screen.
 *
 * The walk reads the SAME catalog the page with every instruction renders, and
 * asks it three questions by button kind — where to get the app, how the
 * subscription gets into it, what to do next. These pin the answers, because a
 * wrong one is silent: a store link shown after the subscription is already
 * added sends the customer back to a store, and nothing errors.
 */

function app(steps: ConnectApp["steps"]): ConnectApp {
  return { id: "happ", name: "Happ", iconKey: null, featured: true, steps };
}

const STORE = { kind: "external" as const, label: { ru: "App Store" }, url: "https://apps.test/happ" };
const APK = { kind: "external" as const, label: { ru: "APK" }, url: "https://github.test/happ.apk" };
const ADD = {
  kind: "deepLink" as const,
  label: { ru: "Добавить" },
  template: "happ://add/{{SUBSCRIPTION_LINK}}",
  encode: "raw" as const,
};
const COPY = { kind: "copyLink" as const, label: { ru: "Скопировать" } };

function step(buttons: ConnectApp["steps"][number]["buttons"], body: string | null = null) {
  return { title: { ru: "Шаг" }, body: body === null ? null : { ru: body }, iconKey: null, iconColor: null, buttons };
}

describe("planApp reads an app the way the walk uses it", () => {
  it("takes the downloads from before the hand-over, each address once", () => {
    const plan = planApp(
      app([step([STORE, APK]), step([ADD, STORE]), step([], "Нажмите большую кнопку"), step([APK])]),
    );
    expect(plan.downloads.map((button) => button.url)).toEqual([STORE.url, APK.url]);
  });

  it("does not offer a store link that comes after the subscription is added", () => {
    const later = { kind: "external" as const, label: { ru: "Открыть" }, url: "https://later.test" };
    const plan = planApp(app([step([STORE]), step([COPY]), step([later])]));
    expect(plan.downloads.map((button) => button.url)).toEqual([STORE.url]);
  });

  it("finds the one-tap hand-over, and what to do after it", () => {
    const plan = planApp(app([step([STORE]), step([ADD]), step([], "Включите VPN")]));
    expect(plan.addLink?.template).toBe(ADD.template);
    expect(plan.enableStep?.body).toEqual({ ru: "Включите VPN" });
  });

  it("knows an app that only copies has no one-tap hand-over", () => {
    const plan = planApp(app([step([STORE]), step([COPY], "Импорт из буфера")]));
    expect(plan.addLink).toBeNull();
    expect(plan.addStep?.body).toEqual({ ru: "Импорт из буфера" });
    expect(plan.enableStep).toBeNull();
  });
});

describe("what the choice screen says about a subscription", () => {
  const base = { status: "ACTIVE", hasLink: true, used: null, limit: 3 } as const;

  it("sends an expired one to renewal and a linkless one to wait", () => {
    expect(subscriptionReadiness({ ...base, status: "EXPIRED" }).kind).toBe("expired");
    expect(subscriptionReadiness({ ...base, hasLink: false }).kind).toBe("pending");
  });

  it("counts free slots only when the device list is known, and says nothing when it is not", () => {
    expect(subscriptionReadiness({ ...base, used: null })).toEqual({ kind: "plain" });
    expect(subscriptionReadiness({ ...base, used: 0 })).toEqual({ kind: "first" });
    expect(subscriptionReadiness({ ...base, used: 1 })).toEqual({ kind: "free", free: 2 });
    expect(subscriptionReadiness({ ...base, used: 3 })).toEqual({ kind: "full" });
  });

  it("reads a limit of zero as no limit, which is what the panel sends for one", () => {
    expect(subscriptionReadiness({ ...base, limit: 0, used: 4 })).toEqual({ kind: "plain" });
  });
});

describe("where the walk starts", () => {
  const row = (id: string, status = "ACTIVE", url: string | null = "https://s.test/" + id) => ({
    id,
    status,
    url,
    deviceLimit: 3,
  });

  it("always asks which subscription when there are two, even from a card's own button", () => {
    // «Лучше дать выбор… так ему будет проще понять, какую он подключает».
    expect(initialPlacement([row("a"), row("b")], "b")).toEqual({ step: "select", focus: 1, chosenId: null });
  });

  it("opens the choice on the first one that can be connected when no card was named", () => {
    expect(initialPlacement([row("a", "EXPIRED"), row("b")], null)?.focus).toBe(1);
  });

  it("goes straight to the start with one subscription that works", () => {
    expect(initialPlacement([row("a")], null)).toEqual({ step: "start", focus: 0, chosenId: "a" });
  });

  it("still shows the choice for a single expired one — that is where «Продлить» is", () => {
    expect(initialPlacement([row("a", "EXPIRED")], null)?.step).toBe("select");
  });

  it("has nowhere to start with no subscriptions", () => {
    expect(initialPlacement([], null)).toBeNull();
  });
});

describe("the walk's history", () => {
  const at = (step: WalkState["step"]): WalkState => ({ ...INITIAL_WALK, step });

  it("moves forward, remembers the way, and goes back along it", () => {
    let walk = walkReducer(INITIAL_WALK, { type: "go", from: "start", to: "device" });
    walk = walkReducer(walk, { type: "go", from: "device", to: "app" });
    expect(walk.step).toBe("app");
    expect(walk.history).toEqual(["start", "device"]);
    walk = walkReducer(walk, { type: "back" });
    expect(walk).toMatchObject({ step: "device", direction: -1, history: ["start"] });
  });

  it("drops a move from a step the walk has already left", () => {
    // The finish fires from a timer; a customer who pressed «Назад» in that
    // second must not be thrown forward from wherever they went.
    const walk = at("add");
    expect(walkReducer(walk, { type: "go", from: "enable", to: "done" })).toBe(walk);
  });

  it("counts every move, so a second stay on a step is a new one", () => {
    const first = walkReducer(at("add"), { type: "go", from: "add", to: "enable" });
    const away = walkReducer(first, { type: "back" });
    const again = walkReducer(away, { type: "go", from: "add", to: "enable" });
    expect(again.visit).toBeGreaterThan(first.visit);
  });

  it("starts over without a way back on «Сменить» and «Подключить ещё устройство»", () => {
    const walk = walkReducer(at("done"), { type: "restart", to: "device", direction: 1 });
    expect(walk).toMatchObject({ step: "device", history: [] });
  });

  it("numbers only the four middle steps", () => {
    expect(["select", "start", "device", "app", "add", "enable", "done"].map((s) => stepNumber(s as never))).toEqual([
      0, 0, 1, 2, 3, 4, 0,
    ]);
  });
});

describe("which screen «Подключить» opens", () => {
  const catalog = {
    connectScreenEnabled: true,
    platforms: [
      {
        id: "ios",
        title: { ru: "iOS" },
        apps: [{ id: "happ", name: "Happ", featured: true, steps: [step([STORE]), step([ADD])] }],
      },
    ],
    icons: {},
  };

  it("is the page with every instruction unless the panel says otherwise", () => {
    expect(readConnectScreenMode(catalog)).toBe("screen");
    expect(connectScreenFor(catalog, null)).toBe("page");
  });

  it("is the walk when the panel says so and the catalog can build it", () => {
    expect(readCatalog({ ...catalog, connectScreenMode: "interactive" })).not.toBeNull();
    expect(connectScreenFor({ ...catalog, connectScreenMode: "interactive" }, null)).toBe("wizard");
  });

  it("falls back to the page when the catalog cannot build the walk", () => {
    // The page still hands the link over with no catalog; the walk is made of it.
    expect(connectScreenFor({ connectScreenEnabled: true, connectScreenMode: "interactive", platforms: [] }, null)).toBe(
      "page",
    );
    expect(connectScreenFor(null, null)).toBe("page");
  });

  it("opens the page when the walk's own help asks for it", () => {
    expect(connectScreenFor({ ...catalog, connectScreenMode: "interactive" }, "page")).toBe("page");
  });

  it("reads a mode it does not know as the page", () => {
    expect(readConnectScreenMode({ connectScreenMode: "carousel" })).toBe("screen");
    expect(readConnectScreenMode("interactive")).toBe("screen");
  });
});

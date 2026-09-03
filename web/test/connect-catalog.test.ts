import { describe, expect, it } from "vitest";

import {
  buildDeepLink,
  chooseApp,
  line,
  readCatalog,
  type ConnectButton,
  type ConnectPlatform,
} from "../src/features/connect/connect-catalog";
import { detectPlatform } from "../src/features/connect/platform-detect";

/**
 * What the connect screen is built on.
 *
 * Two jobs, and each is a place where getting it slightly wrong is invisible:
 * substituting the subscription link into a deep link (wrong, and the app opens
 * and adds nothing), and reading a payload from an image that deploys on its
 * own schedule (wrong, and a cabinet one release behind renders a button it
 * does not understand).
 */

const SUB_URL = "https://sub.example.test/abc?token=1&x=2#frag";

const deepLink = (template: string, encode: "raw" | "component"): ConnectButton => ({
  kind: "deepLink",
  label: { en: "Add" },
  template,
  encode,
});

describe("substituting the subscription link", () => {
  it("puts it into a path exactly as it is", () => {
    expect(buildDeepLink(deepLink("happ://add/{{SUBSCRIPTION_LINK}}", "raw"), SUB_URL)).toBe(
      `happ://add/${SUB_URL}`,
    );
  });

  it("percent-encodes it into a query parameter", () => {
    // THE DEFECT. Raw, the `?`, `&` and `#` in the subscription URL end the
    // parameter early: Clash receives a truncated address, opens, and adds
    // nothing — which everybody reports as "the button does nothing".
    const href = buildDeepLink(
      deepLink("clash://install-config?url={{SUBSCRIPTION_LINK}}", "component"),
      SUB_URL,
    );

    expect(href).toBe(`clash://install-config?url=${encodeURIComponent(SUB_URL)}`);
    expect(href).not.toContain("&x=2");
    expect(href).not.toContain("#frag");
  });

  it("takes the rule from the panel instead of re-deriving it", () => {
    // The panel decides at save time and ships the answer. If the cabinet
    // decided too, the two copies of the rule would be free to drift — and a
    // drift here is invisible until customers complain.
    expect(buildDeepLink(deepLink("x://y?url={{SUBSCRIPTION_LINK}}", "raw"), "A B")).toBe(
      "x://y?url=A B",
    );
    expect(buildDeepLink(deepLink("x://y/{{SUBSCRIPTION_LINK}}", "component"), "A B")).toBe(
      "x://y/A%20B",
    );
  });

  it("builds nothing without a link to build from", () => {
    expect(buildDeepLink(deepLink("happ://add/{{SUBSCRIPTION_LINK}}", "raw"), "")).toBeNull();
    expect(buildDeepLink({ kind: "copyLink", label: { en: "Copy" } }, SUB_URL)).toBeNull();
  });
});

describe("reading a payload from an image that deploys separately", () => {
  const catalog = {
    platforms: [
      {
        id: "ios",
        title: { en: "iOS" },
        iconKey: null,
        apps: [
          {
            id: "happ",
            name: "Happ",
            iconKey: null,
            featured: true,
            steps: [
              {
                title: { en: "Add" },
                body: null,
                iconKey: null,
                buttons: [
                  { kind: "deepLink", label: { en: "Add" }, template: "happ://add/{{SUBSCRIPTION_LINK}}", encode: "raw" },
                ],
              },
            ],
          },
        ],
      },
    ],
    icons: { happ: '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>' },
    showConnectionKeys: false,
  };

  it("reads a catalog it understands", () => {
    const read = readCatalog(catalog);

    expect(read?.platforms).toHaveLength(1);
    expect(read?.platforms[0].apps[0].steps[0].buttons).toHaveLength(1);
    expect(read?.icons.happ).toContain("<svg");
  });

  it("answers null for the panel being unreachable", () => {
    // The edge serves `null` during a panel outage. The screen has one degraded
    // mode, not two.
    expect(readCatalog(null)).toBeNull();
    expect(readCatalog(undefined)).toBeNull();
    expect(readCatalog("nope")).toBeNull();
  });

  it("drops a deep link with no encoding rather than guessing one", () => {
    // A button from a panel older than this contract. Guessing `raw` would ship
    // the truncation bug to whoever uses Clash.
    const read = readCatalog({
      ...catalog,
      platforms: [
        {
          ...catalog.platforms[0],
          apps: [
            {
              ...catalog.platforms[0].apps[0],
              steps: [
                {
                  ...catalog.platforms[0].apps[0].steps[0],
                  buttons: [
                    { kind: "deepLink", label: { en: "Add" }, template: "x://{{SUBSCRIPTION_LINK}}" },
                    { kind: "copyLink", label: { en: "Copy" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const buttons = read?.platforms[0].apps[0].steps[0].buttons ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].kind).toBe("copyLink");
  });

  it("drops a button kind it does not know", () => {
    const read = readCatalog({
      ...catalog,
      platforms: [
        {
          ...catalog.platforms[0],
          apps: [
            {
              ...catalog.platforms[0].apps[0],
              steps: [
                {
                  ...catalog.platforms[0].apps[0].steps[0],
                  buttons: [
                    { kind: "qrCode", label: { en: "QR" } },
                    { kind: "copyLink", label: { en: "Copy" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(read?.platforms[0].apps[0].steps[0].buttons).toHaveLength(1);
  });

  it("refuses a scheme that would execute, whatever the panel said", () => {
    // The panel refuses these on save. The cabinet refuses them again, because
    // "the other side checked" is not a property this side can observe.
    for (const template of ["javascript:x({{SUBSCRIPTION_LINK}})", "data:text/html,{{SUBSCRIPTION_LINK}}"]) {
      const read = readCatalog({
        ...catalog,
        platforms: [
          {
            ...catalog.platforms[0],
            apps: [
              {
                ...catalog.platforms[0].apps[0],
                steps: [
                  {
                    ...catalog.platforms[0].apps[0].steps[0],
                    buttons: [
                      { kind: "deepLink", label: { en: "Go" }, template, encode: "raw" },
                      { kind: "copyLink", label: { en: "Copy" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });

      expect(read?.platforms[0].apps[0].steps[0].buttons.map((b) => b.kind)).toEqual(["copyLink"]);
    }
  });

  it("drops a store button that is not an http link", () => {
    const read = readCatalog({
      ...catalog,
      platforms: [
        {
          ...catalog.platforms[0],
          apps: [
            {
              ...catalog.platforms[0].apps[0],
              steps: [
                {
                  ...catalog.platforms[0].apps[0].steps[0],
                  buttons: [{ kind: "external", label: { en: "Store" }, url: "itms://x" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(read?.platforms[0].apps[0].steps[0].buttons).toHaveLength(0);
  });
});

describe("which app the screen opens on", () => {
  const platform = (apps: Array<{ id: string; featured: boolean }>): ConnectPlatform => ({
    id: "ios",
    title: { en: "iOS" },
    iconKey: null,
    apps: apps.map((a) => ({ ...a, name: a.id, iconKey: null, steps: [] })),
  });

  it("opens on the app this person used last", () => {
    const chosen = chooseApp(platform([{ id: "happ", featured: true }, { id: "streisand", featured: false }]), "streisand");

    expect(chosen.id).toBe("streisand");
  });

  it("falls back to the recommended one, then to the first", () => {
    const apps = platform([{ id: "happ", featured: false }, { id: "streisand", featured: true }]);

    expect(chooseApp(apps, null).id).toBe("streisand");
    expect(chooseApp(apps, "deleted-app").id).toBe("streisand");
    expect(chooseApp(platform([{ id: "a", featured: false }]), null).id).toBe("a");
  });
});

describe("which platform the screen opens on", () => {
  const detect = (userAgent: string, maxTouchPoints = 0, platform = "") =>
    detectPlatform({ userAgent, maxTouchPoints, platform });

  it("reads the ordinary ones", () => {
    expect(detect("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("ios");
    expect(detect("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
    expect(detect("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detect("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
    expect(detect("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });

  it("tells an iPad from a Mac, which the user agent alone cannot", () => {
    // iPadOS reports the desktop Safari UA deliberately. Read as a Mac, the
    // screen offers desktop builds that will not install.
    const iPadUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15";

    expect(detect(iPadUa, 5)).toBe("ios");
    expect(detect(iPadUa, 0)).toBe("macos");
  });

  it("does not let a TV fall through to the phone", () => {
    // Every Android TV is also an Android, so order decides this.
    expect(detect("Mozilla/5.0 (Linux; Android 12; BRAVIA 4K GB TV)")).toBe("androidtv");
    expect(detect("Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7233)")).toBe("androidtv");
    expect(detect("AppleTV6,2/11.1")).toBe("appletv");
  });

  it("answers null rather than guessing when it has nothing", () => {
    // Null is a real answer: the screen shows the platform picker, which is one
    // tap, instead of opening confidently on the wrong apps.
    expect(detect("")).toBeNull();
    expect(detect("SomeCrawler/1.0")).toBeNull();
  });
});

describe("the language a line is shown in", () => {
  it("falls back instead of blanking", () => {
    // A half-translated catalog is a normal state for an operator to be in.
    expect(line({ ru: "Добавить", en: "Add" }, "ru")).toBe("Добавить");
    expect(line({ en: "Add" }, "ru")).toBe("Add");
    expect(line({ ru: "Добавить" }, "de")).toBe("Добавить");
    expect(line(null, "ru")).toBe("");
  });
});

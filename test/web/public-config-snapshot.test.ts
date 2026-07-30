import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readPublicConfigSnapshot,
  writePublicConfigSnapshot,
} from "../../web/src/lib/public-config-snapshot.js";
import { DEFAULT_PUBLIC_CONFIG } from "../../web/src/types/branding.js";

const STORAGE_KEY = "reiwa_public_config_snapshot_v1";

class FakeStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function installWindow(localStorage: Pick<Storage, "getItem" | "setItem">): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });
}

describe("public config snapshot", () => {
  beforeEach(() => {
    installWindow(new FakeStorage());
  });

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("round-trips a valid public config through local storage", () => {
    const storage = new FakeStorage();
    installWindow(storage);

    writePublicConfigSnapshot(DEFAULT_PUBLIC_CONFIG);

    expect(storage.getItem(STORAGE_KEY)).toBe(JSON.stringify(DEFAULT_PUBLIC_CONFIG));
    expect(readPublicConfigSnapshot()).toEqual(DEFAULT_PUBLIC_CONFIG);
  });

  it("round-trips valid plan card accent and texture URLs through local storage", () => {
    const storage = new FakeStorage();
    installWindow(storage);

    const config = {
      ...DEFAULT_PUBLIC_CONFIG,
      branding: {
        ...DEFAULT_PUBLIC_CONFIG.branding,
        planCardStyles: {
          starter: {
            accent: "#ff8844",
            textureUrl: "/uploads/branding/starter-texture.webp",
          },
          premium: {
            textureUrl: "https://cdn.example.com/branding/premium-texture.webp",
          },
        },
      },
    };

    writePublicConfigSnapshot(config);

    expect(readPublicConfigSnapshot()).toEqual(config);
  });

  it("ignores malformed stored data", () => {
    const storage = new FakeStorage();
    storage.setItem(STORAGE_KEY, "{ this is not JSON");
    installWindow(storage);

    expect(readPublicConfigSnapshot()).toBeNull();
  });

  it.each([
    [
      "a default locale that cannot be selected",
      { ...DEFAULT_PUBLIC_CONFIG, defaultLocale: "de" },
    ],
    [
      "a malformed nested card effect slot",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        branding: {
          ...DEFAULT_PUBLIC_CONFIG.branding,
          cardEffectsByIndex: [
            { cardEffect: "aurora", cardEffectProps: {}, cardEffectOpacity: "opaque" },
          ],
        },
      },
    ],
    [
      "a malformed custom icon",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        customIcons: [{ id: "signal", name: "Signal", url: 42, color: null }],
      },
    ],
    [
      "a malformed app background texture",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        branding: {
          ...DEFAULT_PUBLIC_CONFIG.branding,
          appBackground: {
            ...DEFAULT_PUBLIC_CONFIG.branding.appBackground!,
            texture: {
              ...DEFAULT_PUBLIC_CONFIG.branding.appBackground!.texture,
              opacity: "transparent",
            },
          },
        },
      },
    ],
    [
      "a malformed navigation item",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        branding: {
          ...DEFAULT_PUBLIC_CONFIG.branding,
          navItems: [{ id: "plans", visible: "yes" }],
        },
      },
    ],
    [
      "a malformed plan card accent",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        branding: {
          ...DEFAULT_PUBLIC_CONFIG.branding,
          planCardStyles: {
            starter: { accent: "rgb(255, 0, 0)" },
          },
        },
      },
    ],
    [
      "an unsafe plan card texture URL",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        branding: {
          ...DEFAULT_PUBLIC_CONFIG.branding,
          planCardStyles: {
            starter: { textureUrl: "javascript:alert(1)" },
          },
        },
      },
    ],
    [
      "an external card CSS image",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        branding: {
          ...DEFAULT_PUBLIC_CONFIG.branding,
          cardGradient: 'url("https://attacker.invalid/card.png")',
        },
      },
    ],
    [
      "an external card pattern CSS image",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        branding: {
          ...DEFAULT_PUBLIC_CONFIG.branding,
          cardPattern:
            'linear-gradient(#fff, #000), url("https://attacker.invalid/pattern.png")',
        },
      },
    ],
    [
      "an external app background CSS image",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        branding: {
          ...DEFAULT_PUBLIC_CONFIG.branding,
          appBackground: {
            ...DEFAULT_PUBLIC_CONFIG.branding.appBackground!,
            gradient: 'url("https://attacker.invalid/background.png")',
          },
        },
      },
    ],
    [
      "an external plan card CSS image",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        branding: {
          ...DEFAULT_PUBLIC_CONFIG.branding,
          planCardStyles: {
            starter: { gradient: 'url("https://attacker.invalid/plan.png")' },
          },
        },
      },
    ],
    [
      "malformed exact corner geometry",
      {
        ...DEFAULT_PUBLIC_CONFIG,
        branding: {
          ...DEFAULT_PUBLIC_CONFIG.branding,
          cornerRadii: { cardPx: 49, itemPx: 12, pillPx: 9999 },
        },
      },
    ],
  ])("ignores %s", (_label, malformed) => {
    const storage = new FakeStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(malformed));
    installWindow(storage);

    expect(readPublicConfigSnapshot()).toBeNull();
  });

  it("never throws when storage access fails", () => {
    const readFailure: Pick<Storage, "getItem" | "setItem"> = {
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {},
    };
    installWindow(readFailure);

    expect(() => readPublicConfigSnapshot()).not.toThrow();

    const writeFailure: Pick<Storage, "getItem" | "setItem"> = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("storage quota exceeded");
      },
    };
    installWindow(writeFailure);

    expect(() => writePublicConfigSnapshot(DEFAULT_PUBLIC_CONFIG)).not.toThrow();
  });
});

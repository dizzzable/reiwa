// @vitest-environment jsdom

/**
 * The first frame a NEW visitor sees is the operator's, never the built-in «Reiwa».
 *
 * The owner, 01.11.2026: a friend opened the cabinet for the first time and
 * «увидел reiwa а не мое название». A returning visitor never sees it — the
 * browser keeps a copy of the operator config — so it reached exactly the
 * people an operator least wants to show it to.
 *
 * Two carriers close it: the copy the API writes into the document
 * (`#reiwa-public-config`, `src/api/document-public-config.ts`), and — when
 * the server itself had nothing to write — a neutral boot screen instead of
 * the stock identity, for at most `BOOT_SCREEN_MAX_MS`.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getReiwaPublicConfig: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "ru", changeLanguage: vi.fn().mockResolvedValue(undefined) },
  }),
}));
vi.mock("@/lib/client-error-reporter", () => ({ reportClientError: vi.fn() }));

import { BrandingProvider, useBranding } from "@/lib/branding-provider";
import { BOOT_RETRY_INTERVAL_MS, BOOT_SCREEN_MAX_MS } from "@/lib/branding-provider-policy";
import { readDocumentPublicConfig } from "@/lib/public-config-snapshot";
import { DEFAULT_PUBLIC_CONFIG, type PublicConfig } from "@/types/branding";
import { DOCUMENT_PUBLIC_CONFIG_MAX_LENGTH } from "../../src/application/ports/public-config-persistence.port";

const OPERATOR_CONFIG: PublicConfig = {
  ...DEFAULT_PUBLIC_CONFIG,
  branding: {
    ...DEFAULT_PUBLIC_CONFIG.branding,
    brandName: "Northern Lights",
    primary: "#6750a4",
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

function BrandName(): ReactNode {
  return <p data-brand-name="">{useBranding().branding.brandName}</p>;
}

function mount(): void {
  client = new QueryClient();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client!}>
        <BrandingProvider>
          <BrandName />
        </BrandingProvider>
      </QueryClientProvider>,
    );
  });
}

/** The copy the API writes into the document's head. */
function carry(text: string): void {
  const element = document.createElement("script");
  element.id = "reiwa-public-config";
  element.type = "application/json";
  element.textContent = text;
  document.head.append(element);
}

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

function shown(): string {
  return container?.querySelector("[data-brand-name]")?.textContent ?? "";
}

function booting(): boolean {
  return container?.querySelector("[data-branding-boot]") !== null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  window.localStorage.clear();
  document.getElementById("reiwa-public-config")?.remove();
  document.title = "";
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  client?.clear();
  client = null;
  document.getElementById("reiwa-public-config")?.remove();
  api.getReiwaPublicConfig.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the first frame of a first visit", () => {
  it("is the operator's, from the copy the document carries, while the bootstrap request is still out", () => {
    api.getReiwaPublicConfig.mockReturnValue(new Promise(() => undefined));
    carry(JSON.stringify(OPERATOR_CONFIG));

    mount();

    expect(booting()).toBe(false);
    expect(shown()).toBe("Northern Lights");
  });

  it("with no copy anywhere, is a neutral screen — no «Reiwa», not even in the tab — until the config lands", async () => {
    let answer: (config: PublicConfig) => void = () => undefined;
    api.getReiwaPublicConfig.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    mount();

    expect(booting()).toBe(true);
    expect(container?.textContent ?? "").not.toContain("Reiwa");
    expect(document.title).toBe("");

    answer(OPERATOR_CONFIG);
    await elapse(0);

    expect(booting()).toBe(false);
    expect(shown()).toBe("Northern Lights");
    expect(document.title).toBe("Northern Lights");
  });

  it("asks again every BOOT_RETRY_INTERVAL_MS while the neutral screen is up", async () => {
    api.getReiwaPublicConfig.mockRejectedValue(new Error("public-config unavailable"));

    mount();
    await elapse(0);
    const first = api.getReiwaPublicConfig.mock.calls.length;
    await elapse(BOOT_RETRY_INTERVAL_MS * 2);

    expect(api.getReiwaPublicConfig.mock.calls.length).toBeGreaterThanOrEqual(first + 2);
    expect(booting()).toBe(true);
  });

  it("gives up waiting after BOOT_SCREEN_MAX_MS: a working cabinet in the stock identity beats a spinner forever", async () => {
    api.getReiwaPublicConfig.mockRejectedValue(new Error("public-config unavailable"));

    mount();
    await elapse(BOOT_SCREEN_MAX_MS);

    expect(booting()).toBe(false);
    expect(shown()).toBe(DEFAULT_PUBLIC_CONFIG.branding.brandName);
  });
});

describe("readDocumentPublicConfig", () => {
  it("reads the document's copy, and nothing from a broken or oversized one", () => {
    expect(readDocumentPublicConfig()).toBeNull();

    carry(JSON.stringify(OPERATOR_CONFIG));
    expect(readDocumentPublicConfig()?.branding.brandName).toBe("Northern Lights");

    document.getElementById("reiwa-public-config")?.remove();
    carry("{not json");
    expect(readDocumentPublicConfig()).toBeNull();

    document.getElementById("reiwa-public-config")?.remove();
    carry(JSON.stringify({ ...OPERATOR_CONFIG, padding: "x".repeat(DOCUMENT_PUBLIC_CONFIG_MAX_LENGTH) }));
    expect(readDocumentPublicConfig()).toBeNull();
  });
});

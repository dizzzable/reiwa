// @vitest-environment jsdom

/**
 * The tab title the app sets after boot is the one the API served the document
 * with (`src/api/document-title.ts`): «Заголовок веб-страницы», then «Название
 * проекта», then «Название бренда». Rendered through the real
 * `BrandingProvider`; `test/web/document-title-parity.test.ts` holds the rule
 * itself equal to the API's.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getReiwaPublicConfig: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "ru", changeLanguage: vi.fn().mockResolvedValue(undefined) },
  }),
}));
vi.mock("@/lib/public-config-snapshot", () => ({
  readPublicConfigSnapshot: () => null,
  writePublicConfigSnapshot: vi.fn(),
}));
vi.mock("@/lib/client-error-reporter", () => ({ reportClientError: vi.fn() }));

import { BrandingProvider } from "@/lib/branding-provider";
import { DEFAULT_PUBLIC_CONFIG, type PublicConfig } from "@/types/branding";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

function operator(brandName: string, webTitle: string | null, projectName: string | null): PublicConfig {
  return {
    ...DEFAULT_PUBLIC_CONFIG,
    branding: { ...DEFAULT_PUBLIC_CONFIG.branding, brandName },
    platformBranding: { webTitle, projectName },
  };
}

async function mountWith(config: PublicConfig): Promise<void> {
  api.getReiwaPublicConfig.mockResolvedValue(config);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client!}>
        <BrandingProvider>{null}</BrandingProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(api.getReiwaPublicConfig).toHaveBeenCalled());
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // What the API serves an operator with no name of their own.
  document.title = "Reiwa";
  window.localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  client?.clear();
  client = null;
  api.getReiwaPublicConfig.mockReset();
  vi.unstubAllGlobals();
});

describe("the tab title after boot", () => {
  it("is «Заголовок веб-страницы» when the operator set one", async () => {
    await mountWith(operator("Winger VPN", "Winger — быстрый VPN", "Winger"));
    await vi.waitFor(() => expect(document.title).toBe("Winger — быстрый VPN"));
  });

  it("is «Название проекта» without one", async () => {
    await mountWith(operator("Winger VPN", null, "Winger"));
    await vi.waitFor(() => expect(document.title).toBe("Winger"));
  });

  it("is the brand name with neither — folded the way the served title is", async () => {
    await mountWith(operator("  Winger \n VPN  ", "   ", null));
    await vi.waitFor(() => expect(document.title).toBe("Winger VPN"));
  });
});

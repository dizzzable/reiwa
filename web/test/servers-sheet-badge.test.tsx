// @vitest-environment jsdom

/**
 * The badge under a server's name — the one visible change of the release that
 * split the name from the label.
 *
 * VPN clients draw a host as its remark in large type with `serverDescription`
 * in a chip underneath ("Germany - 1" over "ОСНОВНОЙ | СЕРВЕР"), and the panel
 * sends the two apart so this screen can do the same. Nothing checked that it
 * does: the badge could be dropped, fed the name, or folded back into the status
 * line, and every suite stayed green. So this holds three things:
 *
 *   1. a server with a description draws exactly that text in one chip;
 *   2. the chip has a line of its own, after the name and before the status —
 *      sharing the status line made the rows of one list different heights;
 *   3. a server with no description — `null`, empty, or a panel older than the
 *      field — draws no chip, and all three draw the same row.
 *
 * Rendered at rest (`useReducedMotion` → true), as the other sheet tests are.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SubscriberServer } from "@/lib/api-client/servers";

const api = vi.hoisted(() => ({ getSubscriptionServers: vi.fn() }));
vi.mock("@/lib/api-client/servers", () => api);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "ru" },
  }),
}));

vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));

vi.mock("@/components/reactbits/originkit/Globe", () => ({
  default: () => <div data-testid="globe-canvas" />,
}));

import { ServersSheet } from "@/features/servers/servers-sheet";
import { resolveGlobePreferences } from "@/components/reactbits/originkit/globe-preferences";

const server = (row: Omit<SubscriberServer, "flag" | "countryCode" | "status" | "uptimeSeconds">): SubscriberServer => ({
  kind: "server",
  flag: null,
  countryCode: "DE",
  status: "online",
  uptimeSeconds: 604_800,
  ...row,
});

/** Two badges that differ, so a chip fed anything but its own row's text shows. */
const ROWS: readonly SubscriberServer[] = [
  server({ id: "de", name: "🇩🇪 Germany - 1", description: "ОСНОВНОЙ | СЕРВЕР" }),
  server({ id: "pl", name: "Poland - 1", description: "LTE | СЕРВЕР" }),
  server({ id: "lv", name: "Latvia - 1", description: null }),
  server({ id: "fi", name: "Finland - 1", description: "" }),
  // A panel older than the field sends no key at all.
  server({ id: "nl", name: "Netherlands - 1" }),
];

const BADGE = '[data-testid="server-badge"]';

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.clearAllMocks();
});

async function renderSheet(servers: readonly SubscriberServer[]): Promise<HTMLElement> {
  api.getSubscriptionServers.mockResolvedValue({ servers, recommendedServerId: null });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ServersSheet
          subscriptionId="sub-1"
          preferences={resolveGlobePreferences(null)}
          onClose={() => undefined}
        />
      </QueryClientProvider>,
    );
  });
  // A macrotask rather than a microtask: react-query settles across one.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  return dialog as HTMLElement;
}

/** The list item whose name line reads exactly `name`. */
function rowNamed(dialog: HTMLElement, name: string): { item: HTMLElement; name: HTMLElement; status: HTMLElement } {
  const nameLine = [...dialog.querySelectorAll<HTMLElement>("ul li p")].find(
    (line) => line.textContent === name,
  );
  expect(nameLine, `no row named ${name}`).toBeDefined();
  const item = (nameLine as HTMLElement).closest("li") as HTMLElement;
  const status = [...item.querySelectorAll<HTMLElement>("p")].find((line) =>
    (line.textContent ?? "").startsWith("servers.status."),
  );
  expect(status, `${name}: no status line`).toBeDefined();
  return { item, name: nameLine as HTMLElement, status: status as HTMLElement };
}

/** Tag names in document order — the shape of a row, without its text. */
function shapeOf(item: HTMLElement): string {
  return [item, ...item.querySelectorAll("*")].map((element) => element.tagName).join(">");
}

describe("the badge on a server row", () => {
  it("draws the description in one chip, on its own line between the name and the status", async () => {
    const dialog = await renderSheet(ROWS);
    for (const [name, text] of [
      ["Germany - 1", "ОСНОВНОЙ | СЕРВЕР"],
      ["Poland - 1", "LTE | СЕРВЕР"],
    ] as const) {
      const row = rowNamed(dialog, name);
      const badges = row.item.querySelectorAll<HTMLElement>(BADGE);
      expect(badges, `${name}: chips`).toHaveLength(1);
      const badge = badges[0] as HTMLElement;
      expect(badge.textContent, `${name}: chip text`).toBe(text);
      // Its own line: in neither the name line nor the status line…
      expect(row.name.contains(badge), `${name}: chip inside the name line`).toBe(false);
      expect(row.status.contains(badge), `${name}: chip inside the status line`).toBe(false);
      // …and between them.
      expect(row.name.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING, `${name}: chip above the name`).toBeTruthy();
      expect(badge.compareDocumentPosition(row.status) & Node.DOCUMENT_POSITION_FOLLOWING, `${name}: chip below the status`).toBeTruthy();
    }
  });

  it("draws no chip when there is no description, and the same row whichever way there is none", async () => {
    const dialog = await renderSheet(ROWS);
    // The anchor: the list really has chips to find, so "none here" below is
    // about these rows and not about a sheet that drew none at all.
    expect(dialog.querySelectorAll(BADGE)).toHaveLength(2);
    const bare = ["Latvia - 1", "Finland - 1", "Netherlands - 1"].map((name) => rowNamed(dialog, name));
    for (const row of bare) {
      const label = row.name.textContent ?? "";
      expect(row.item.querySelectorAll(BADGE), `${label}: a chip`).toHaveLength(0);
      expect(row.item.textContent, `${label}: another row's badge`).not.toMatch(/СЕРВЕР/);
    }
    // `null`, `""` and a missing key are one row shape — and one element
    // shorter than a row with a chip, which is the chip and nothing else.
    const shapes = new Set(bare.map((row) => shapeOf(row.item)));
    expect(shapes.size).toBe(1);
    const withChip = shapeOf(rowNamed(dialog, "Germany - 1").item);
    expect(withChip).not.toBe([...shapes][0]);
  });
});

// @vitest-environment jsdom

/**
 * Section headers in the servers list: drawn as headings, and counted nowhere.
 *
 * Remnawave has no separator. Operators fake one with an ordinary host whose
 * remark is a heading — "⬇️ Все | Локации ⬇️" — and VPN apps draw it as a row
 * reading "n/a". Once the operator tags such a host in Remnawave, the panel
 * sends it as `kind: "separator"`, and this screen owes it four things:
 *
 *   1. it is a heading, not a server card — no box, flag tile, badge, status
 *      dot or status line;
 *   2. it looks like this list's own "available servers" label;
 *   3. it is not a server: not in the count, not on the planet, and a list of
 *      nothing else is the empty state;
 *   4. a list WITHOUT headers is untouched, whether its rows say `server`, say
 *      nothing (a panel older than the field) or say something this build has
 *      never heard of.
 *
 * Rendered at rest (`useReducedMotion` → true): the entrance is decoration
 * with its own contract in `servers-sheet-motion.test.ts`, and a half-finished
 * animation would put timing into the markup the last test compares.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SubscriberServer } from "@/lib/api-client/servers";

const api = vi.hoisted(() => ({ getSubscriptionServers: vi.fn() }));
vi.mock("@/lib/api-client/servers", () => api);

// The count is part of what is under test, so the stand-in keeps it.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options !== undefined && "count" in options ? `${key}#${String(options.count)}` : key,
    i18n: { language: "ru" },
  }),
}));

vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));

// The planet is WebGL; what matters here is the markers it is handed, so the
// stand-in writes them into the page where a test can read them back.
vi.mock("@/components/reactbits/originkit/Globe", () => ({
  default: (props: { markerConfig?: { markers?: unknown[] } }) => (
    <div
      data-testid="globe-canvas"
      data-markers={JSON.stringify(props.markerConfig?.markers ?? [])}
    />
  ),
}));

import { ServersSheet } from "@/features/servers/servers-sheet";
import { countryPoint } from "@/features/servers/country-points";
import { resolveGlobePreferences } from "@/components/reactbits/originkit/globe-preferences";

/**
 * What a header row carries that it should not.
 *
 * The panel sends a header with every server field empty. Here they are filled
 * in — a flag, a country the planet can place, a badge, "online", an uptime —
 * so that each "the header has no X" below fails when a header is drawn as a
 * server, instead of passing because there was no X to draw.
 */
const HEADER_FIELDS = {
  description: "РАЗДЕЛИТЕЛЬ | НЕ СЕРВЕР",
  flag: "🇳🇱",
  countryCode: "NL",
  status: "online",
  uptimeSeconds: 86_400,
} as const;

const ROWS: readonly SubscriberServer[] = [
  { id: "sep-auto", kind: "separator", name: "🇪🇺 Автовыбор", ...HEADER_FIELDS },
  {
    id: "auto",
    kind: "server",
    name: "Smart 🇪🇺",
    description: null,
    flag: "🇪🇺",
    countryCode: "EU",
    status: "online",
    uptimeSeconds: 3_600,
  },
  {
    id: "sep-locations",
    kind: "separator",
    name: "⬇️ Все | Локации ⬇️",
    ...HEADER_FIELDS,
    countryCode: "FI",
  },
  {
    id: "de",
    kind: "server",
    name: "🇩🇪 Germany - 1",
    description: "ОСНОВНОЙ | СЕРВЕР",
    flag: "🇩🇪",
    countryCode: "DE",
    status: "online",
    uptimeSeconds: 604_800,
  },
  {
    id: "lv",
    kind: "server",
    name: "Latvia - 1",
    description: null,
    flag: null,
    countryCode: "LV",
    status: "offline",
    uptimeSeconds: null,
  },
];

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.clearAllMocks();
});

async function renderSheet(servers: readonly SubscriberServer[]): Promise<HTMLElement> {
  api.getSubscriptionServers.mockResolvedValue({ servers, recommendedServerId: "de" });
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

function markersOf(dialog: HTMLElement): unknown {
  const canvas = dialog.querySelector<HTMLElement>('[data-testid="globe-canvas"]');
  expect(canvas, "the planet did not render").not.toBeNull();
  return JSON.parse((canvas as HTMLElement).dataset.markers ?? "null");
}

function pointOf(code: string): { lat: number; lng: number } {
  const point = countryPoint(code);
  expect(point, `no point for ${code}`).not.toBeNull();
  const [lat, lng] = point as readonly [number, number];
  return { lat, lng };
}

describe("a section header in the servers list", () => {
  it("is a heading, with nothing of a server card", async () => {
    const dialog = await renderSheet(ROWS);
    const headings = [...dialog.querySelectorAll("ul h4")];
    // In the operator's order, with the flag taken off the text the same way it
    // is taken off a server's name.
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Автовыбор",
      "⬇️ Все | Локации ⬇️",
    ]);
    for (const heading of headings) {
      const label = heading.textContent ?? "";
      const row = heading.closest("li");
      expect(row, `${label}: not a list item`).not.toBeNull();
      const item = row as HTMLElement;
      // A flag tile is an image or the lettered badge standing in for one; the
      // badge and the status dot are spans too. A heading row holds none.
      expect(item.querySelectorAll("img, span"), `${label}: a flag tile, badge or status dot`).toHaveLength(0);
      expect(item.textContent, `${label}: a status line`).not.toContain("servers.status");
      expect(item.textContent, `${label}: an uptime`).not.toContain("servers.uptime");
      expect(item.textContent, `${label}: a badge`).not.toContain("РАЗДЕЛИТЕЛЬ");
      expect(item.className, `${label}: boxed like a card`).not.toMatch(/\b(border|rounded|bg-)/);
    }
    // The servers between them are still cards, status line and all.
    expect(dialog.querySelectorAll("ul li")).toHaveLength(ROWS.length);
    expect(dialog.textContent).toContain("servers.status.offline");
  });

  it("is set in the type of the list's own label", async () => {
    // "Small, muted, a subheading between the cards" is the look the list's
    // label already has, so the header is held to the label itself rather
    // than to a copy of its classes: restyle one and this asks for the other.
    const dialog = await renderSheet(ROWS);
    const label = dialog.querySelector<HTMLElement>("section h3");
    const heading = dialog.querySelector<HTMLElement>("ul h4");
    expect(label, "the list has no label").not.toBeNull();
    expect(heading, "no header was drawn").not.toBeNull();
    // Spacing is where each sits, not how it reads.
    const type = [...(label as HTMLElement).classList].filter((name) => !/^-?m[trblxy]?-/.test(name));
    expect(type.length).toBeGreaterThan(0);
    for (const name of type) {
      expect(
        (heading as HTMLElement).classList.contains(name),
        `the header is missing the label's \`${name}\``,
      ).toBe(true);
    }
  });

  it("is not counted as a server", async () => {
    const dialog = await renderSheet(ROWS);
    // Five rows, three servers.
    expect(dialog.querySelector("header p")?.textContent).toBe("servers.subtitle#3");
  });

  it("puts nothing on the planet", async () => {
    // Both headers carry a country the planet can place, so a header that was
    // not skipped would show up here as a marker.
    expect(countryPoint("NL")).not.toBeNull();
    expect(countryPoint("FI")).not.toBeNull();
    const dialog = await renderSheet(ROWS);
    // `auto` is flagged EU, which has no point: two markers, not three.
    expect(markersOf(dialog)).toEqual([pointOf("DE"), pointOf("LV")]);
  });

  it("leaves the empty state standing when no server is left beside it", async () => {
    // The panel drops a header with nothing under it, so this takes a panel
    // that did not. Even then the screen must not print "0 servers" over a
    // column of headings.
    const dialog = await renderSheet(ROWS.filter((row) => row.kind === "separator"));
    expect(dialog.querySelector("ul")).toBeNull();
    expect(dialog.textContent).toContain("servers.empty");
    expect(dialog.querySelector("header p")?.textContent).toBe("servers.subtitle#0");
  });
});

describe("a list with no section headers", () => {
  it("draws the same screen whether its rows say `server`, say nothing, or say something unknown", async () => {
    // A panel older than the field sends no `kind`; this cabinet's own BFF
    // sends `server`; a kind invented later must change nothing either. All
    // three are the list as it was before headers existed, character for
    // character.
    const servers = ROWS.filter((row) => row.kind !== "separator");
    const withoutKind = servers.map(({ kind: _kind, ...row }) => row);
    const unknownKind = servers.map((row) => ({ ...row, kind: "pinned" }) as unknown as SubscriberServer);

    const asServer = (await renderSheet(servers)).outerHTML;
    const asOlderPanel = (await renderSheet(withoutKind)).outerHTML;
    const asUnknown = (await renderSheet(unknownKind)).outerHTML;

    expect(asServer).toContain("servers.subtitle#3");
    expect(asOlderPanel).toBe(asServer);
    expect(asUnknown).toBe(asServer);
  });
});

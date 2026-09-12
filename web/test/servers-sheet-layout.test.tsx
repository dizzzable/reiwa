// @vitest-environment jsdom

/**
 * The servers screen: a planet ABOVE a list, not on top of one.
 *
 * WHAT THIS GUARDS, and what it cannot. jsdom has no layout engine, so nothing
 * here can measure a box. What it can hold is the STRUCTURE that made the
 * overlap possible, and that is where the defect actually lived:
 *
 * The scroller was `fixed inset-0 flex flex-col overflow-y-auto`. A definite
 * height plus flex means that once the content grows past the viewport — which
 * fourteen servers does — flex SHRINKS the children to fit instead of letting
 * the container scroll. The globe box asks for `height: min(46vh, 360px)` and
 * holds a child at `height: 100%`, and a percentage height resolves against the
 * containing block's SPECIFIED height, not the height flex shrank it to. So the
 * box collapsed, the rows moved up into the space it gave back, and the canvas
 * carried on drawing its full 360px straight over them. On a phone and on a
 * desktop alike.
 *
 * Two rules follow, and both are checkable without layout:
 *
 *   1. no ancestor between the globe box and the dialog may be a flex
 *      container — block boxes do not shrink;
 *   2. the globe box must come BEFORE the list in document order, because that
 *      is what "planet first, list under it" means once nothing overlaps.
 *
 * A third is about the other half of the report: on a desktop every row ran the
 * full width of the screen, so the content must sit in a bounded column.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getSubscriptionServers: vi.fn() }));
vi.mock("@/lib/api-client/servers", () => api);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "ru" },
  }),
}));

// The three planets each drag `three` behind them and none of it says anything
// about layout. What matters is that SOMETHING occupies the globe box.
vi.mock("@/components/reactbits/originkit/Globe", () => ({
  default: () => <div data-testid="globe-canvas" style={{ height: "100%" }} />,
}));
vi.mock("@/components/reactbits/originkit/GlobeMesh", () => ({
  default: () => <div data-testid="globe-canvas" style={{ height: "100%" }} />,
}));
vi.mock("@/components/reactbits/originkit/DitherGlobe", () => ({
  default: () => <div data-testid="globe-canvas" style={{ height: "100%" }} />,
}));

import { ServersSheet } from "@/features/servers/servers-sheet";
import { resolveGlobePreferences } from "@/components/reactbits/originkit/globe-preferences";

const SERVERS = Array.from({ length: 14 }, (_, index) => ({
  id: `host-${index}`,
  name: `🇩🇪 Germany 0${index}`,
  flag: "🇩🇪",
  countryCode: "DE",
  status: "online" as const,
  uptimeSeconds: 604_800,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.getSubscriptionServers.mockResolvedValue({
    servers: SERVERS,
    recommendedServerId: "host-3",
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderSheet(): Promise<HTMLElement> {
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
  // Let the query resolve, so the list really does hold fourteen rows — the
  // amount of content that triggered the shrink in the first place. A macrotask
  // rather than a microtask: react-query settles across one.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  return dialog as HTMLElement;
}

/**
 * The box this screen gives the planet, found through the planet itself.
 *
 * Found structurally — the ancestor of the planet that is a direct child of the
 * content column — rather than by counting parents or by reading its height.
 * The real globe adds a root div of its own and the stand-in here does not, so
 * a fixed distance breaks on a component this file is not testing; and jsdom
 * does not keep a `min()` height, so the declaration cannot be read back.
 */
function globeBox(dialog: HTMLElement): HTMLElement {
  const canvas = dialog.querySelector<HTMLElement>('[data-testid="globe-canvas"]');
  expect(canvas, "the planet did not render at all").not.toBeNull();
  const column = dialog.firstElementChild;
  expect(column, "the dialog has no content column").not.toBeNull();
  let node: HTMLElement = canvas as HTMLElement;
  while (node.parentElement !== null && node.parentElement !== column) {
    node = node.parentElement;
  }
  expect(node.parentElement, "the planet is not inside the content column").toBe(column);
  return node;
}

describe("the servers screen holds its planet above its list", () => {
  it("renders the planet and all fourteen rows", async () => {
    const dialog = await renderSheet();
    expect(dialog.querySelector('[data-testid="globe-canvas"]')).not.toBeNull();
    expect(dialog.querySelectorAll("li")).toHaveLength(14);
  });

  it("draws each server's flag as an image, not as an emoji", async () => {
    // Windows has no glyph for a regional-indicator pair, so `🇩🇪` renders
    // there as the letters "DE" — the desktop report this replaced. A row must
    // carry a real file; see `country-flag.test.tsx` for the fallback.
    const dialog = await renderSheet();
    const row = dialog.querySelector("li");
    expect(row).not.toBeNull();
    const flag = (row as HTMLElement).querySelector("img");
    expect(flag, "the row draws no flag image").not.toBeNull();
    expect((flag as HTMLImageElement).getAttribute("src")).toMatch(/flags\/de\.svg$/);
    // And the emoji is not ALSO printed beside it: the operator's name carries
    // one, and on Windows it arrives as two stray letters in front of the name.
    expect(dialog.textContent ?? "").not.toContain("🇩🇪");
  });

  it("puts the planet BEFORE the list in document order", async () => {
    // "Планета сначала, а под ней список." With nothing overlapping, document
    // order is what decides which is on top of the screen.
    const dialog = await renderSheet();
    const globe = globeBox(dialog);
    const list = dialog.querySelector("ul");
    expect(list).not.toBeNull();
    const position = globe.compareDocumentPosition(list as Node);
    expect(
      position & Node.DOCUMENT_POSITION_FOLLOWING,
      "the list must follow the planet, not precede it",
    ).toBeTruthy();
  });

  it("keeps every ancestor of the planet out of flex layout", async () => {
    // THE REGRESSION. A flex ancestor with a definite height shrinks this box,
    // and the canvas inside — sized by a percentage of the box's SPECIFIED
    // height — goes on painting at full size over whatever moved up into the
    // space. Block boxes do not shrink; the scroller scrolls instead.
    const dialog = await renderSheet();
    let node: HTMLElement | null = globeBox(dialog);
    const offenders: string[] = [];
    while (node !== null && node !== dialog.parentElement) {
      if (node.classList.contains("flex") || node.classList.contains("inline-flex")) {
        offenders.push(node.className);
      }
      node = node.parentElement;
    }
    expect(
      offenders,
      `a flex ancestor can shrink the planet's box: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });

  it("refuses to be shrunk even if an ancestor ever becomes flex again", async () => {
    const dialog = await renderSheet();
    expect(globeBox(dialog).classList.contains("shrink-0")).toBe(true);
  });

  it("holds its content in a bounded column instead of the whole screen", async () => {
    // The other half of the report: on a desktop every row stretched across
    // the full width. `max-w-[46rem]` is the column `stealth-layout` uses.
    const dialog = await renderSheet();
    const row = dialog.querySelector("li");
    expect(row).not.toBeNull();
    let node: HTMLElement | null = row as HTMLElement;
    let bounded = false;
    while (node !== null && node !== dialog.parentElement) {
      if ([...node.classList].some((name) => name.startsWith("max-w-"))) bounded = true;
      node = node.parentElement;
    }
    expect(bounded, "nothing between a row and the dialog bounds its width").toBe(true);
  });

  it("lets the screen scroll rather than squeezing what is on it", async () => {
    const dialog = await renderSheet();
    // The scroller is the dialog itself, and it must still be one: block flow
    // only helps because the overflow is allowed to become scroll.
    expect(dialog.classList.contains("overflow-y-auto")).toBe(true);
    expect(dialog.classList.contains("flex")).toBe(false);
  });
});

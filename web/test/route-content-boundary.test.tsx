// @vitest-environment jsdom

import { act, lazy, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RouteContentBoundary } from "../src/components/layout/route-content-boundary";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let mounted: { root: Root; container: HTMLDivElement } | null = null;

afterEach(() => {
  if (mounted) {
    act(() => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  act(() => root.render(element));
  return container;
}

describe("RouteContentBoundary", () => {
  it("keeps navigation visible while a cold route chunk is loading", async () => {
    let resolveRoute: (() => void) | undefined;
    const LazyRoute = lazy(
      () =>
        new Promise<{ default: () => ReactElement }>((resolve) => {
          resolveRoute = () => resolve({ default: () => <main>Destination</main> });
        }),
    );
    const container = render(
      <>
        <nav>Navigation</nav>
        <RouteContentBoundary>
          <LazyRoute />
        </RouteContentBoundary>
      </>,
    );

    expect(container.querySelector("nav")?.textContent).toBe("Navigation");
    expect(container.querySelector("[data-route-content-loading]")).not.toBeNull();

    await act(async () => {
      resolveRoute?.();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("main")?.textContent).toBe("Destination");
    expect(container.querySelector("nav")?.textContent).toBe("Navigation");
  });
});

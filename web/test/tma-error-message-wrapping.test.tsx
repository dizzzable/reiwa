// @vitest-environment jsdom

/**
 * THE /tma BOOTSTRAP ERROR MESSAGE MUST BREAK AN UNBREAKABLE TOKEN.
 *
 * `tma-bootstrap-page.tsx` draws its failure text with `whitespace-pre-line`,
 * and the BFF may extend that text with a `[dev]` block: `resolveBootstrapError`
 * appends `\n\n[dev] ${body.debug}`, and the server fills `debug` with up to
 * 500 characters of the raw upstream body (`debug: upstream 403:
 * ${body.slice(0, 500)}` in `src/api/routes/auth.ts`). Upstream bodies are
 * JSON, so a single unbreakable "word" of a few hundred characters is the
 * ORDINARY case on this branch, not an edge one.
 *
 * That word decides the width of the card. The error card is a flex item of a
 * `flex flex-col items-center` column, so its width is shrink-to-fit —
 * `min(max(min-content, available), max-content)` — and with no in-word wrap
 * opportunity the token IS the min-content width. Measured in Chrome at 375px
 * (a 309px content column after the root's `px-8`), with the 231-character
 * JSON body used below — well inside the server's 500-character cut: the card
 * resolves to 742px inside that 309px column. The page root's
 * `overflow-x-hidden` then clips it, so the defect presents as text cut off at
 * the right edge with no scrollbar to reach it.
 *
 * WHY `overflow-wrap: anywhere` AND NOT `break-words`. These are not
 * interchangeable here, and picking the wrong one looks like a fix while
 * changing nothing at all. Both create the same soft wrap opportunities for
 * LINE breaking, but CSS Text 3 §5.5 says the ones introduced by `break-word`
 * are NOT counted when computing min-content intrinsic size, while the ones
 * introduced by `anywhere` ARE. The box here is sized BY its min-content, so
 * only `anywhere` moves it. Measured in Chrome on the layout above with the
 * same token:
 *
 *   (nothing)                     card 742px in a 309px column — overflows
 *   overflow-wrap: break-word     card 742px — byte-identical, no effect
 *   overflow-wrap: anywhere       card 309px — fits
 *   word-break: break-all         card 309px — fits, but see below
 *
 * `break-all` also fits, and this file accepts it, because it does make the
 * token contribute a small min-content width — which is the property under
 * test. It is not what the page ships: `break-all` breaks between any two
 * characters even when ordinary break opportunities exist, so it would also
 * chop the human-readable first line of the message mid-word. `anywhere`
 * only reaches inside a word when there is no other way to fit it.
 *
 * WHY THIS FILE ASSERTS RESOLVED STYLE AND NOT A MEASUREMENT. jsdom has no
 * layout engine: every rect, `scrollWidth` and `clientWidth` is 0 here, so
 * "is the card wider than its column" cannot be measured, and a test that
 * pretended to measure it would be comparing zero with zero and passing on
 * the unfixed code. This repo has a documented history of exactly that. What
 * CAN be established without layout is the property that decides the answer,
 * resolved through a real cascade rather than read off a class-name string.
 *
 * WHY THE CASCADE IS REBUILT INSTEAD OF READING `index.css`. The neighbouring
 * `out-of-shell-scroller.test.tsx` injects the authored `web/src/index.css`,
 * which is enough for IT because `#root`, `.scroll-area` and `.h-dvh` are
 * hand-written rules in that file. The property this file is about lives in a
 * Tailwind-generated utility, which is in no authored file at all — so the
 * utilities are compiled here, by Tailwind itself, from the class names the
 * page actually rendered. That is what keeps the assertion honest: it never
 * sees a class name, only the declarations that class name compiles to, so
 * `wrap-anywhere`, the arbitrary `[overflow-wrap:anywhere]`, an inherited
 * value from an ancestor, and a hand-written rule added to `index.css` all
 * pass, while `break-words` — which compiles to the value that does nothing
 * here — fails.
 *
 * Only `tailwindcss/utilities.css` is compiled, not the full `@import
 * "tailwindcss"`. The full entry wraps everything in `@layer` blocks, and
 * jsdom's CSS parser does not descend into those: the sheet loads, matches
 * nothing, and every assertion below would resolve to `normal` whether the
 * page is fixed or not. The premise test in the first `describe` exists to
 * catch that class of harness rot, so this file cannot quietly become a test
 * that fails (or passes) for a reason unrelated to the page.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── The failure this page is about ───────────────────────────────────────────
// A realistic upstream body: one JSON object, no spaces, so the whole thing is
// a single unbreakable word as far as line breaking is concerned. 231
// characters — under half of what `body.slice(0, 500)` may hand the client, so
// the case below is a modest one, not a contrived worst case.
const UPSTREAM_BODY =
  '{"message":"Forbidden","statusCode":403,"path":"/api/auth/telegram",' +
  '"requestId":"a1b2c3d4e5f60718293a4b5c6d7e8f90","details":{"reason":' +
  '"signature_mismatch","hash":"9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b' +
  '4a39281706f5e4d3c2b1a0"}}';

/** The longest run with no line-break opportunity in the rendered message. */
function longestUnbreakableRun(text: string): string {
  let longest = "";
  for (const run of text.split(/\s+/)) {
    if (run.length > longest.length) longest = run;
  }
  return longest;
}

// ── Doubles ──────────────────────────────────────────────────────────────────
// The page component is the real one, and so is every element it renders —
// the node this file inspects is the node it actually ships.

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));

vi.mock("lucide-react", () => ({
  Loader2: () => <svg />,
  Shield: () => <svg />,
  Zap: () => <svg />,
}));

// `motion/react`: the animation props are not DOM attributes, and forwarding
// them would make React warn on every element. The stub keeps the tag and the
// props that reach the cascade, which is all this file reads.
vi.mock("motion/react", () => {
  const LAYOUT_PROPS = new Set(["className", "style", "id", "role"]);
  const host = (tag: string) =>
    function MotionStub(props: Record<string, unknown>) {
      const forwarded: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(props)) {
        if (name === "children") continue;
        if (LAYOUT_PROPS.has(name) || name.startsWith("aria-") || name.startsWith("data-")) {
          forwarded[name] = value;
        }
      }
      return createElement(tag, forwarded, (props as { children?: ReactNode }).children);
    };
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: new Proxy({} as Record<string, unknown>, {
      get: (_target, tag) => (typeof tag === "string" ? host(tag) : undefined),
    }),
  };
});

// One `navigate` for the process: the page lists it in an effect dependency
// array, and a fresh function each render would re-run that effect forever.
vi.mock("react-router", () => {
  const navigate = vi.fn();
  return { useNavigate: () => navigate };
});

vi.mock("@tanstack/react-query", () => {
  const queryClient = {
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(async () => undefined),
    // No existing session, so the page falls through to the initData bootstrap.
    fetchQuery: vi.fn(async () => null),
  };
  return { useQueryClient: () => queryClient };
});

// The refusal that produces the long message. Shape matches `isAxiosErrorLike`
// (a `response.status` number), and `debug` is what `resolveBootstrapError`
// appends after `\n\n[dev] `. Status 403 rather than 401 so the page does not
// also try to forget the launch payload.
vi.mock("@/lib/api-client", () => ({
  bootstrapTelegram: vi.fn(async () => {
    throw {
      response: {
        status: 403,
        data: { message: "Access denied", debug: `upstream 403: ${UPSTREAM_BODY}` },
      },
    };
  }),
}));

vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  fetchSessionOrNull: vi.fn(async () => null),
}));

// A launch WITH a payload: without one the page short-circuits to the short
// "open in Telegram" message and never reaches the branch under test.
vi.mock("@/hooks/use-telegram-webapp", () => ({
  useTelegramWebApp: () => ({ initData: "user=%7B%22id%22%3A1%7D&hash=deadbeef", isReady: true, telegram: null }),
}));

vi.mock("@/lib/telegram-launch-params", () => ({
  readTelegramLaunchInitData: () => "user=%7B%22id%22%3A1%7D&hash=deadbeef",
  forgetTelegramLaunchPayload: vi.fn(),
}));

vi.mock("@/lib/next-destination", () => ({ readNextDestination: () => null }));

vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Reiwa", tagline: "", primary: "#22c55e" } }),
}));
vi.mock("@/components/ui/entry-brand-tile", () => ({ EntryBrandTile: () => <div /> }));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => <div /> }));

import TmaBootstrapPage from "@/features/auth/tma-bootstrap-page";

// jsdom replaces the global `URL`, so a `new URL(…, import.meta.url)` handed to
// `node:fs` is rejected here — the neighbouring jsdom specs use `fileURLToPath`
// for the same reason.
const HERE = dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);

// React 19 refuses to treat `act()` as a real act scope without this.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The shipped hand-written stylesheet, minus its `@import` lines (Tailwind and
 * the font faces — jsdom resolves neither and would log a parse warning each).
 * It carries no wrapping rule today; it is injected so that a fix written as a
 * hand-written rule there, rather than as a utility, would also pass.
 */
const AUTHORED_STYLESHEET = readFileSync(join(HERE, "..", "src", "index.css"), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("@import"))
  .join("\n");

/**
 * A class the page does not use and this file never asserts about, compiled
 * alongside the page's own so the premise test has something to check that no
 * change to the page can move. Kept out of `MIN_CONTENT_AWARE` reach on
 * purpose — it must be able to fail for exactly one reason: a dead harness.
 */
const HARNESS_CONTROL_CLASS = "list-decimal";
const HARNESS_CONTROL_DECLARATION = ["list-style-type", "decimal"] as const;

/**
 * Compile the Tailwind utilities for a set of class names, exactly as the
 * build would, and return flat CSS jsdom can match.
 *
 * `tailwindcss/utilities.css` and not `tailwindcss`: see the head of the file.
 */
async function compileUtilities(candidates: readonly string[]): Promise<string> {
  const compiler = await compile('@import "tailwindcss/utilities.css";', {
    base: join(HERE, ".."),
    loadStylesheet: async (id: string, base: string) => {
      const path = id.startsWith(".")
        ? resolve(base, id)
        : nodeRequire.resolve(id.endsWith(".css") ? id : `${id}/index.css`);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
    loadModule: async () => {
      throw new Error("the utilities entry pulls in no JS plugin");
    },
  });
  return compiler.build([...candidates, HARNESS_CONTROL_CLASS]);
}

/** Every class name present anywhere in a rendered subtree. */
function classCandidates(root: Element): string[] {
  const seen = new Set<string>();
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const token of el.classList) seen.add(token);
  }
  return [...seen];
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  document.head.innerHTML = "";
});

/**
 * Render `/tma`, let it fail, and put the real cascade behind what it drew.
 *
 * The two stylesheets go in separate `<style>` elements on purpose: jsdom's
 * CSS parser can abandon a sheet it cannot read, and one sheet must not be
 * able to take the other down with it.
 */
async function renderFailedBootstrap(): Promise<HTMLElement> {
  host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<TmaBootstrapPage />);
  });
  // The page decides what to draw from an async effect: the session probe, then
  // the rejected bootstrap. Without settling it would be asserted on its
  // first-paint spinner, which has no message node at all.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  const rendered = host.firstElementChild;
  if (!(rendered instanceof window.HTMLElement)) {
    throw new Error("/tma rendered no element at all");
  }

  const authored = document.createElement("style");
  authored.textContent = AUTHORED_STYLESHEET;
  const utilities = document.createElement("style");
  utilities.textContent = await compileUtilities(classCandidates(rendered));
  document.head.append(authored, utilities);

  return rendered;
}

/** The node carrying the bootstrap failure text, found by its text, not its class. */
function messageNode(page: HTMLElement): HTMLElement {
  for (const el of page.querySelectorAll("*")) {
    if (!(el instanceof window.HTMLElement)) continue;
    if (el.children.length > 0) continue;
    if (el.textContent?.includes(UPSTREAM_BODY)) return el;
  }
  throw new Error(
    "/tma never rendered the upstream body. The page is not on its error " +
      "branch, or the `[dev]` block stopped being forwarded — either way the " +
      "assertion below would be about nothing.",
  );
}

interface InWordWrapping {
  /**
   * Do the resolved values introduce a break opportunity INSIDE an unbreakable
   * word that also counts toward min-content intrinsic size? That second half
   * is the whole question: it is what sizes the shrink-to-fit card.
   */
  readonly breaksLongTokens: boolean;
  /** Does the resolved `white-space` permit wrapping at all? */
  readonly allowsWrapping: boolean;
  /** Verbatim resolved values, for the failure message. */
  readonly resolved: string;
}

function inWordWrapping(el: Element): InWordWrapping {
  const style = window.getComputedStyle(el);
  const overflowWrap = style.getPropertyValue("overflow-wrap").trim();
  // The legacy alias. jsdom keeps the two separate, and a fix written with the
  // old spelling would resolve here instead.
  const wordWrap = style.getPropertyValue("word-wrap").trim();
  const wordBreak = style.getPropertyValue("word-break").trim();
  const whiteSpace = style.getPropertyValue("white-space").trim();

  // `overflow-wrap: break-word` is deliberately absent: its break opportunities
  // do not contribute to min-content size, so it leaves this card exactly as
  // wide as it was (measured: 742px both with and without it).
  const MIN_CONTENT_AWARE = new Set(["anywhere"]);
  // `word-break: break-word` is the deprecated spelling of
  // "`word-break: normal` + `overflow-wrap: anywhere`", so it qualifies too.
  const WORD_BREAK_AWARE = new Set(["break-all", "break-word"]);
  // `pre` and `nowrap` suppress wrapping outright, which would make everything
  // above moot. `pre-line` — what the page ships — wraps.
  const NO_WRAP = new Set(["pre", "nowrap"]);

  return {
    breaksLongTokens:
      MIN_CONTENT_AWARE.has(overflowWrap) ||
      MIN_CONTENT_AWARE.has(wordWrap) ||
      WORD_BREAK_AWARE.has(wordBreak),
    allowsWrapping: whiteSpace !== "" && !NO_WRAP.has(whiteSpace),
    resolved:
      `overflow-wrap:${overflowWrap || "—"} word-wrap:${wordWrap || "—"} ` +
      `word-break:${wordBreak || "—"} white-space:${whiteSpace || "—"}`,
  };
}

describe("the compiled cascade is live — the premise the case below rests on", () => {
  it("resolves a compiled Tailwind utility through getComputedStyle", async () => {
    await renderFailedBootstrap();
    // A control element, so this says nothing about the page: it fails only if
    // compile-and-inject stopped working.
    const control = document.createElement("div");
    control.className = HARNESS_CONTROL_CLASS;
    document.body.append(control);
    const [property, value] = HARNESS_CONTROL_DECLARATION;
    const resolved = window.getComputedStyle(control).getPropertyValue(property).trim();
    control.remove();
    expect(
      resolved,
      `\`.${HARNESS_CONTROL_CLASS}\` was compiled into the injected sheet but ` +
        "did not reach getComputedStyle. The cascade harness is dead — most " +
        "likely the utilities entry started emitting `@layer` blocks, which " +
        "jsdom does not descend into. Every value the next test reads would " +
        "then resolve to its initial value no matter what the page ships, so " +
        "fix the harness before trusting a red OR a green from it.",
    ).toBe(value);
  });
});

describe("/tma keeps a long [dev] token inside the card", () => {
  it("breaks the unbreakable upstream body instead of overflowing", async () => {
    const page = await renderFailedBootstrap();
    const node = messageNode(page);
    const token = longestUnbreakableRun(node.textContent ?? "");
    const wrapping = inWordWrapping(node);

    expect(
      { breaksLongTokens: wrapping.breaksLongTokens, allowsWrapping: wrapping.allowsWrapping },
      `The /tma failure message resolved to { ${wrapping.resolved} } and its ` +
        `longest unbreakable run is ${token.length} characters. With no ` +
        "in-word break opportunity that run IS the min-content width of the " +
        "text, and the error card is a shrink-to-fit flex item, so the card " +
        "takes the token's width: measured in Chrome at 375px, 742px of card " +
        "inside a 309px column, clipped by the root's `overflow-x-hidden` " +
        "with no scrollbar to reach the rest. The server truncates the " +
        "upstream body at 500 characters, so this is the ordinary size of the " +
        "`[dev]` block, not a worst case.\n" +
        "NOTE `break-words` does NOT satisfy this and is not an oversight: " +
        "`overflow-wrap: break-word` break opportunities are excluded from " +
        "min-content intrinsic size (CSS Text 3 §5.5), so it leaves the card " +
        "at 742px — measured, byte-identical to no rule at all. " +
        "`overflow-wrap: anywhere` is the value whose opportunities count.",
    ).toEqual({ breaksLongTokens: true, allowsWrapping: true });
  });
});

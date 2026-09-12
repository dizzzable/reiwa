// @vitest-environment jsdom

/**
 * The outline the legal reader builds out of the operator's PLAIN TEXT, and
 * the two lines in the reader that decide whether anything is drawn at all.
 *
 * The page ships in the pre-login bundle, which keeps a sanitizer out on
 * purpose, so nothing may interpret markup. The only structure available is
 * the numbering the operator already types — which means the parser has to be
 * right about what IS numbering and, more importantly, what merely looks like
 * it. A tariff paragraph that opens "50.5 ГБ" is a sentence, not clause 50.5,
 * and getting that wrong turns the middle of an offer into nonsense.
 *
 * The page cases at the foot mount the real `LegalPage`. jsdom is the right
 * environment for them for a reason that is not incidental: it has no
 * `Element.prototype.scrollTo`, which is the exact hole the reader's
 * scroll-to-top guards against.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { anchorOf, outlineOf } from "@/features/legal/legal-document-outline";

describe("outlineOf", () => {
  it("reads a numbered section as a heading and its clauses as clauses", () => {
    const blocks = outlineOf(
      ["1. Стороны и акцепт", "", "1.1. Исполнитель: кто-то.", "", "1.2. Акцептом признаётся."].join(
        "\n",
      ),
    );

    expect(blocks).toEqual([
      { kind: "section", number: "1", text: "Стороны и акцепт" },
      { kind: "clause", number: "1.1", depth: 2, text: "Исполнитель: кто-то." },
      { kind: "clause", number: "1.2", depth: 2, text: "Акцептом признаётся." },
    ]);
  });

  it("indents a sub-clause deeper than its parent", () => {
    const [block] = outlineOf("4.10.2. Повторная попытка списания.");

    expect(block).toEqual({
      kind: "clause",
      number: "4.10.2",
      depth: 3,
      text: "Повторная попытка списания.",
    });
  });

  it("does NOT read a decimal in a sentence as a clause number", () => {
    // The whole reason the trailing dot is mandatory. Without it this
    // paragraph becomes clause 50.5 of nothing, sitting in the numbered
    // column, and the reader sees a document that does not exist.
    const blocks = outlineOf("50.5 ГБ трафика включено в тариф.");

    expect(blocks).toEqual([{ kind: "paragraph", text: "50.5 ГБ трафика включено в тариф." }]);
  });

  it("splits a heading from the clause pasted directly under it", () => {
    // Real operator text rarely has a blank line in every right place. One
    // missing line used to collapse a whole section into a single grey
    // paragraph, which is most of what made the old page unreadable.
    const blocks = outlineOf("2. Термины\n2.1. Сервис — это сервис.\n2.2. Тариф — это тариф.");

    expect(blocks.map((block) => block.kind)).toEqual(["section", "clause", "clause"]);
    expect(blocks[0]).toMatchObject({ number: "2", text: "Термины" });
    expect(blocks[2]).toMatchObject({ number: "2.2" });
  });

  it("returns plain paragraphs for a document that numbers nothing", () => {
    const blocks = outlineOf("Мы уважаем вашу приватность.\n\nМы не продаём данные.");

    expect(blocks).toEqual([
      { kind: "paragraph", text: "Мы уважаем вашу приватность." },
      { kind: "paragraph", text: "Мы не продаём данные." },
    ]);
  });

  it("keeps a soft line break inside one block instead of splitting on it", () => {
    // An address or a hand-made list. Splitting here would scatter one
    // clause across three, each carrying the first one's number.
    const [block] = outlineOf("1.1. Реквизиты:\nИНН 000\nАдрес: где-то");

    expect(block).toMatchObject({
      kind: "clause",
      number: "1.1",
      text: "Реквизиты:\nИНН 000\nАдрес: где-то",
    });
  });

  it("survives the line endings a pasted document actually arrives with", () => {
    // The input this case used to assert on — `1. Первый\r\n\r\n1.1. Пункт.` —
    // comes back as `["section", "clause"]` WITH the CRLF normalisation and
    // `["section", "clause"]` without it, because the "heading with its clause
    // pasted under it" rescue two cases above puts it back together by hand.
    // It guarded nothing. Two ordinary paragraphs have no such rescue:
    // `BLANK_LINE` is `\n[ \t]*\n+`, which does not match `\r\n\r\n`, so with
    // the normalisation deleted the whole document comes back as ONE block —
    // the undifferentiated grey wall this reader exists to replace. An
    // operator pasting from Word or Notepad hands the panel exactly this.
    expect(outlineOf("Абзац один.\r\n\r\nАбзац два.")).toEqual([
      { kind: "paragraph", text: "Абзац один." },
      { kind: "paragraph", text: "Абзац два." },
    ]);
    // The lone CR is the other half of `\r\n?` and fails the same way.
    expect(outlineOf("Первый.\r\rВторой.").map((block) => block.kind)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    // And a CRLF break INSIDE a block reaches the page as the `\n` that
    // `whitespace-pre-line` knows how to draw, not as a stray carriage return.
    expect(outlineOf("1.1. Реквизиты:\r\nИНН 000")).toEqual([
      { kind: "clause", number: "1.1", depth: 2, text: "Реквизиты:\nИНН 000" },
    ]);
  });

  it("ignores trailing and repeated blank lines rather than emitting empty blocks", () => {
    expect(outlineOf("\n\n\nОдин абзац.\n\n\n\n")).toEqual([
      { kind: "paragraph", text: "Один абзац." },
    ]);
  });
});

describe("anchorOf", () => {
  it("gives each document the kebab fragment the links point at", () => {
    expect(anchorOf("PRIVACY_POLICY")).toBe("doc-privacy-policy");
    expect(anchorOf("OFFER")).toBe("doc-offer");
  });

  it("is derived, so a document the panel learns to serve gets one for free", () => {
    expect(anchorOf("SOMETHING_NEW_ENTIRELY")).toBe("doc-something-new-entirely");
  });
});

// ── The reader itself ───────────────────────────────────────────────────────
//
// Two cases, both about the same thing: the reader drawing SOMETHING. Each
// guards a line whose removal replaces the operator's agreement with a blank
// screen, and neither of those lines is exercised anywhere else — the
// out-of-shell spec mounts this page too, but only ever reads its outermost
// box.

const page = vi.hoisted(() => ({
  hash: "",
  documents: [] as { key: string; title: string; body: string }[],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
// Only `useLocation` is reached from this page; it is read during render and
// nothing keys an effect off the object itself, so a fresh one per call is safe.
vi.mock("react-router", () => ({
  useLocation: () => ({
    pathname: "/legal",
    search: "",
    hash: page.hash,
    state: null,
    key: "spec",
  }),
}));
vi.mock("@/components/ui/back-button", () => ({
  BackButton: () => createElement("button", { type: "button" }),
}));
vi.mock("@/lib/use-legal-documents", () => ({
  useLegalDocuments: () => ({
    documents: page.documents,
    isLoading: false,
    failed: false,
    retry: () => undefined,
  }),
}));

import LegalPage from "@/features/legal/legal-page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(): HTMLElement {
  if (root === null) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => {
    root?.render(createElement(LegalPage));
  });
  if (host === null) throw new Error("nothing was mounted");
  return host;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  page.hash = "";
  page.documents = [];
});

describe("the reader", () => {
  it("opens a document even when the fragment names one that does not exist", () => {
    // The bot, the sign-up form and anyone with an old link all point at
    // `#doc-<key>`, and a key the operator has since switched off — or a
    // hand-edited fragment — must not answer with an empty page. Without the
    // `?? documents[0]` fallback `current` is `undefined`, the whole
    // `current !== undefined` block is skipped, and the reader draws its
    // header over nothing at all.
    page.documents = [
      { key: "USER_AGREEMENT", title: "Соглашение", body: "1. Раздел\n\n1.1. Пункт." },
      { key: "OFFER", title: "Оферта", body: "Один абзац." },
    ];
    page.hash = "#doc-something-the-operator-switched-off";
    const mounted = render();

    expect(
      mounted.querySelector("article h2")?.textContent,
      "a fragment naming no document left the reader with nothing to read",
    ).toBe("Соглашение");

    // The switcher is real links, which is what makes a document shareable,
    // openable in a new tab and reachable from the keyboard — and the reader
    // says which one is open for anyone who cannot see the highlight.
    const pills = [...mounted.querySelectorAll("nav a")];
    expect(pills.map((pill) => pill.getAttribute("href"))).toEqual([
      "#doc-user-agreement",
      "#doc-offer",
    ]);
    expect(pills.map((pill) => pill.getAttribute("aria-current"))).toEqual(["page", null]);
    expect(mounted.querySelector("nav")?.getAttribute("aria-label")).toBe(
      "privacy.legalDocumentsNav",
    );
  });

  it("switches documents where `Element.scrollTo` does not exist", () => {
    // Switching puts the reader back at the top, because the page is its own
    // scroller and clause 7 of the offer must not open at the depth clause 7
    // of the policy was left at. That call has to be optional: jsdom has no
    // `Element.prototype.scrollTo` and neither do some embedded webviews, and
    // an unguarded call throws inside an effect — which tears the page down
    // and leaves a blank screen where the agreement should be. Failing to
    // scroll is a shrug; failing to render is the defect.
    expect(
      (document.createElement("div") as Partial<HTMLElement>).scrollTo,
      "jsdom grew `Element.prototype.scrollTo`, so this case no longer stands where it thinks it does",
    ).toBeUndefined();

    page.documents = [
      { key: "USER_AGREEMENT", title: "Соглашение", body: "Текст соглашения." },
      { key: "OFFER", title: "Оферта", body: "Текст оферты." },
    ];
    render();

    page.hash = "#doc-offer";
    const mounted = render();

    expect(
      mounted.querySelector("article h2")?.textContent,
      "the reader did not survive a document switch on a browser without `Element.scrollTo`",
    ).toBe("Оферта");
  });
});

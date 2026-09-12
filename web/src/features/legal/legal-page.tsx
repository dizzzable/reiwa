/**
 * Public reader for the operator's legal documents.
 *
 * Deliberately reachable WITHOUT a session. Three places need it and none of
 * them can assume an account exists:
 *   - the sign-up form, where someone is deciding whether to create one;
 *   - the bot's rules screen, whose only way to show a long text is a link;
 *   - the cabinet's privacy page, for reading afterwards.
 *
 * Bodies render as text, never as markup — this page ships in the pre-login
 * bundle, which keeps a sanitizer out on purpose. `outlineOf` reads the
 * numbering the operator already types and returns plain strings in labelled
 * boxes; nothing here interprets markup and nothing reaches
 * `dangerouslySetInnerHTML`.
 *
 * ── One document at a time ──────────────────────────────────────────────────
 *
 * Every document used to be stacked into one endless scroll in hint grey,
 * which is unreadable at the length an offer actually runs to. They are now
 * chosen from a list and read one at a time, addressed by `#doc-<key>` so the
 * bot — and anyone with a link — can point at a specific one. An unknown or
 * absent fragment falls back to the first document rather than an empty page.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";

import { BackButton } from "@/components/ui/back-button";
import { useLegalDocuments } from "@/lib/use-legal-documents";
import type { LegalDocument } from "@/lib/api-client";

import { switcherScrollLeft } from "./document-switcher-scroll";
import { anchorOf, outlineOf, type LegalBlock } from "./legal-document-outline";

export default function LegalPage() {
  const { t } = useTranslation();
  const { documents, isLoading, failed, retry } = useLegalDocuments();
  const { hash } = useLocation();

  // The page is its own scroller (see below), so switching documents has to
  // put the reader back at the top explicitly — otherwise clause 7 of the
  // offer opens at the depth clause 7 of the policy was left at.
  const scroller = useRef<HTMLDivElement | null>(null);
  const requested = hash.replace(/^#/, "");
  const current =
    documents.find((document) => anchorOf(document.key) === requested) ?? documents[0];

  useEffect(() => {
    // Optional CALL, not just an optional ref: `Element.scrollTo` is absent in
    // jsdom and in a few embedded webviews, and an unguarded call there throws
    // inside an effect — which unmounts the page and leaves a blank screen
    // where the agreement should be. Failing to scroll is a shrug; failing to
    // render is the defect this whole route exists to avoid.
    scroller.current?.scrollTo?.({ top: 0 });
  }, [current?.key]);

  return (
    // This page renders OUTSIDE `StealthLayout`, so nothing above it
    // scrolls: `#root` is `height: 100dvh; overflow: hidden` (index.css) and
    // the shell's `<main class="scroll-area">` belongs to the protected
    // routes only. Without the pair below, everything past the first screen
    // is unreachable — no scrollbar, no touch scroll, nothing — and on THIS
    // page that is the operator's agreement and offer, linked from the
    // sign-up form and from the bot, which a subscriber is asked to accept.
    //
    // `scroll-area h-dvh` is the pair the six entry screens already use.
    // `h-dvh` is the load-bearing half and not decoration: a scroll
    // container that sizes to its content never scrolls, it just grows past
    // the clip. `min-h-full` was exactly that shape.
    <div ref={scroller} className="scroll-area h-dvh bg-(--brand-bg-primary)">
      <header className="sticky top-0 z-10 border-b border-white/5 bg-(--brand-bg-primary)/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-4">
          <BackButton fallback="/welcome" label={t("common.back")} />
          <h1 className="text-base font-semibold tracking-tight text-foreground">
            {t("privacy.legalDocuments")}
          </h1>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-5 pt-5 pb-16">
        {isLoading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}

        {failed && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <p className="text-xs text-amber-300">{t("register.legal.unavailable")}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-2 text-xs font-medium text-(--brand-primary) underline underline-offset-4"
            >
              {t("common.retry")}
            </button>
          </div>
        )}

        {!isLoading && !failed && documents.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("privacy.legalDocumentsEmpty")}</p>
        )}

        {current !== undefined && (
          <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
            <DocumentSwitcher
              documents={documents}
              currentKey={current.key}
              label={t("privacy.legalDocumentsNav")}
            />
            <Document document={current} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The list of documents. One element, two presentations: a scrollable row of
 * pills on a phone, a column that stays put while the text scrolls on a wide
 * screen. Real links with real `href`s, so a document can be shared, opened in
 * a new tab, and reached from the keyboard.
 */
function DocumentSwitcher({
  documents,
  currentKey,
  label,
}: {
  documents: readonly LegalDocument[];
  currentKey: string;
  label: string;
}) {
  const row = useRef<HTMLElement | null>(null);
  const activePill = useRef<HTMLAnchorElement | null>(null);

  // Bring the selected pill on screen. On a phone the row is wider than the
  // screen, so arriving at `#doc-offer` — the shape of link the bot and the
  // sign-up form hand out — otherwise shows the right document under a row
  // still at `scrollLeft: 0`, in which the selection is past the right edge
  // and nothing looks selected at all. See `switcherScrollLeft`, which owns
  // the arithmetic and the two cases where the row must be left alone.
  useEffect(() => {
    const nav = row.current;
    const pill = activePill.current;
    if (nav === null || pill === null) return;
    const navBox = nav.getBoundingClientRect();
    const pillBox = pill.getBoundingClientRect();
    const left = switcherScrollLeft(
      {
        scrollLeft: nav.scrollLeft,
        clientWidth: nav.clientWidth,
        scrollWidth: nav.scrollWidth,
        left: navBox.left,
      },
      { left: pillBox.left, width: pillBox.width },
    );
    if (left === null) return;
    // Optional CALL for the same reason the page's own scroller has one:
    // `scrollTo` is absent in jsdom and in a few embedded webviews, and an
    // unguarded call there throws inside an effect and unmounts the page.
    // Assigning the offset is the fallback that works everywhere else.
    if (typeof nav.scrollTo === "function") nav.scrollTo({ left });
    else nav.scrollLeft = left;
  }, [currentKey]);

  return (
    <nav
      ref={row}
      aria-label={label}
      className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 lg:mx-0 lg:h-fit lg:flex-col lg:overflow-visible lg:px-0 lg:sticky lg:top-20"
    >
      {documents.map((document) => {
        const active = document.key === currentKey;
        return (
          <a
            key={document.key}
            ref={active ? activePill : undefined}
            href={`#${anchorOf(document.key)}`}
            aria-current={active ? "page" : undefined}
            className={[
              "shrink-0 rounded-xl px-3 py-2 text-xs leading-snug font-medium transition-colors lg:shrink lg:text-[0.8125rem]",
              active
                ? "bg-(--brand-primary)/12 text-(--brand-primary) ring-1 ring-(--brand-primary)/30"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
            ].join(" ")}
          >
            {document.title}
          </a>
        );
      })}
    </nav>
  );
}

function Document({ document }: { document: LegalDocument }) {
  const blocks = outlineOf(document.body);

  return (
    <article className="max-w-[68ch]">
      <h2 className="text-xl leading-tight font-semibold text-balance text-foreground">
        {document.title}
      </h2>
      <div className="mt-5 space-y-3.5">
        {blocks.map((block, index) => (
          <Block key={index} block={block} />
        ))}
      </div>
    </article>
  );
}

function Block({ block }: { block: LegalBlock }) {
  if (block.kind === "section") {
    return (
      <h3 className="mt-8 flex gap-2.5 border-t border-white/5 pt-6 text-[0.9375rem] font-semibold text-foreground first:mt-0 first:border-0 first:pt-0">
        <span className="tabular-nums text-(--brand-primary)">{block.number}.</span>
        <span className="text-balance">{block.text}</span>
      </h3>
    );
  }

  if (block.kind === "clause") {
    return (
      <p
        // The number lives in its own column so a run of clauses reads as a
        // list rather than as prose that happens to start with digits. Depth
        // is an indent and not a smaller type size: 4.10.2 is as binding as 4.
        className="flex gap-2.5 text-[0.8125rem] leading-relaxed text-muted-foreground"
        style={block.depth > 2 ? { paddingInlineStart: `${(block.depth - 2) * 1.1}rem` } : undefined}
      >
        <span className="shrink-0 tabular-nums text-foreground/55">{block.number}.</span>
        <span className="whitespace-pre-line">{block.text}</span>
      </p>
    );
  }

  return (
    <p className="text-[0.8125rem] leading-relaxed whitespace-pre-line text-muted-foreground">
      {block.text}
    </p>
  );
}

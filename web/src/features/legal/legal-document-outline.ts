/**
 * Structure a legal document into an outline — from its PLAIN TEXT.
 *
 * ── Why this exists rather than a markdown renderer ──────────────────────────
 *
 * The reader ships in the pre-login bundle, which keeps a sanitizer out on
 * purpose, so the operator's body is rendered as text and never as markup.
 * That rule is not negotiable and this file does not bend it: nothing here
 * interprets markup, and nothing it returns is ever handed to
 * `dangerouslySetInnerHTML`. It only reads the numbering the operator already
 * types — `1.`, `1.1.`, `1.1.1.` — and hands the page back plain strings in
 * labelled boxes, so the page can set a heading as a heading and line the
 * clause numbers up in their own column.
 *
 * A document with no numbering at all comes back as paragraphs, which is the
 * honest answer and still reads far better than one undifferentiated block.
 *
 * ── Why the trailing dot is mandatory ───────────────────────────────────────
 *
 * `50.5 ГБ трафика в месяц` is a sentence, not clause 50.5. Requiring the dot
 * AFTER the number (`1.1.` and not `1.1`) separates the two, and it costs
 * nothing: legal numbering is written with it. Without that the first tariff
 * paragraph mentioning a decimal turns into a clause and the outline lies.
 */

/** One piece of a document, already classified. All fields are plain text. */
export type LegalBlock =
  | {
      readonly kind: 'section'
      /** `1`, `7` — kept because a legal text is cited by it. */
      readonly number: string
      readonly text: string
    }
  | {
      readonly kind: 'clause'
      /** `1.1`, `4.10.2` */
      readonly number: string
      /** 2 for `1.1`, 3 for `1.1.1` — how far to indent. */
      readonly depth: number
      readonly text: string
    }
  | { readonly kind: 'paragraph'; readonly text: string }

/** `1.1.` / `4.10.2.` — at least two groups, trailing dot required. */
const CLAUSE = /^(\d+(?:\.\d+)+)\.[ \t]*(\S[\s\S]*)$/
/** `1. Стороны и акцепт` — one group, trailing dot required, single line. */
const SECTION_LINE = /^(\d+)\.[ \t]+(\S[^\n]*)$/

/**
 * Blocks are separated by a blank line. A single newline INSIDE a block is the
 * operator's own line break — a list, an address — and is preserved by the
 * page rather than collapsed here.
 */
const BLANK_LINE = /\n[ \t]*\n+/

export function outlineOf(body: string): readonly LegalBlock[] {
  const blocks: LegalBlock[] = []

  for (const raw of body.replace(/\r\n?/g, '\n').split(BLANK_LINE)) {
    pushBlock(blocks, raw.trim())
  }

  return blocks
}

function pushBlock(into: LegalBlock[], text: string): void {
  if (text.length === 0) return

  const clause = CLAUSE.exec(text)
  if (clause !== null) {
    const number = clause[1] ?? ''
    into.push({
      kind: 'clause',
      number,
      depth: number.split('.').length,
      text: clause[2] ?? '',
    })
    return
  }

  const section = SECTION_LINE.exec(text)
  if (section !== null) {
    into.push({ kind: 'section', number: section[1] ?? '', text: section[2] ?? '' })
    return
  }

  // A heading whose first clause follows without a blank line between them —
  // common enough in pasted text that dropping it into one grey paragraph
  // would undo most of the outline. Split the first line off and re-read the
  // remainder, which may itself be several clauses.
  const firstBreak = text.indexOf('\n')
  if (firstBreak > 0) {
    const head = text.slice(0, firstBreak).trim()
    if (SECTION_LINE.test(head)) {
      pushBlock(into, head)
      for (const rest of text.slice(firstBreak + 1).split('\n')) {
        pushBlock(into, rest.trim())
      }
      return
    }
  }

  into.push({ kind: 'paragraph', text })
}

/**
 * The URL fragment for a document, in the shape the reference site uses
 * (`#doc-privacy`). Derived from the key rather than a table so a fourth
 * document the panel learns to serve gets an anchor without a code change
 * here; the keys are screaming snake case and the fragment is kebab.
 */
export function anchorOf(key: string): string {
  return `doc-${key.toLowerCase().replace(/_/g, '-')}`
}

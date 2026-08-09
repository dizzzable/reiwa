import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Render purity for the Originkit components.
 *
 * Every one of these components keeps a "latest props" ref that its
 * `requestAnimationFrame` loop reads, so a control can move without tearing the
 * animation down. Seventeen of them refreshed that ref with a bare assignment in
 * the component body — a write during render. Render has to stay pure because
 * React may replay a render or throw one away; a discarded render still ran the
 * assignment, and the loop then draws from props belonging to a commit that
 * never happened. `react-doctor/no-ref-current-in-render` is the rule, and this
 * is the standing version of it.
 *
 * This repo is where the fault gets authored: these components are edited here
 * and vendored into rezeis by `scripts/sync-originkit.mjs`. It also has no
 * ESLint and no react-doctor gate of its own, so a render-scope ref write made
 * here is caught by nothing until somebody syncs and rezeis' pull-request gate
 * happens to include the file. Hence the twin of this file living beside the
 * vendored copy at
 * `rezeis-admin/web/src/components/reactbits/originkit-render-purity.test.ts` —
 * same contract, one at the source and one at the destination. Change one and
 * change the other.
 *
 * The permitted shape is lazy initialisation behind a nullish guard
 * (`if (ref.current === null) ref.current = …`) — it runs once, and running it
 * twice is a no-op, so a replayed render cannot corrupt anything. That form is
 * exempt below, and the exemption is pinned by fixtures so it cannot quietly
 * widen into "any `if`".
 *
 * The detector walks the TypeScript AST rather than matching text: the point is
 * to survive a renamed ref, a renamed component, `ref['current'] = …`,
 * `ref.current += …` and `ref.current++`, none of which a `\.current\s*=` regex
 * would agree were the same thing.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ORIGINKIT_DIR = join(HERE, '..', 'src', 'components', 'reactbits', 'originkit')
const MANIFEST_NAME = 'originkit.manifest.json'

/** Anything that can appear on the left of an assignment operator. */
const ASSIGNMENT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

/**
 * `??=` and `||=` on a ref are lazy init spelled as an operator: the write only
 * lands while the slot is empty, so a replayed render cannot change the value.
 */
const SELF_GUARDING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
])

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node)

const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isFunctionLike(parent)) return parent
  }
  return undefined
}

/**
 * "Is this function render scope?" answered without knowing any names.
 *
 * Only a component or a custom hook calls a hook in its own body; a callback
 * handed to `useEffect`, a `requestAnimationFrame` tick and a pointer handler
 * never do. Asking the question this way means the check does not care what the
 * component is called, whether it is a declaration or an arrow, or whether it is
 * the default export — all three vary across these thirty-one files.
 */
const callsHookDirectly = (fn: ts.Node): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    // Nested functions run later, not during this render — their hook calls (of
    // which there should be none) say nothing about this body.
    if (isFunctionLike(node)) return
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ''
      if (/^use[A-Z0-9]/.test(name)) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn, visit)
  return found
}

/** `x.current` and `x['current']` — the same write, spelled two ways. */
const currentTarget = (expr: ts.Node): ts.Expression | undefined => {
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'current') return expr
  if (
    ts.isElementAccessExpression(expr) &&
    ts.isStringLiteralLike(expr.argumentExpression) &&
    expr.argumentExpression.text === 'current'
  ) {
    return expr
  }
  return undefined
}

/** `[ref.current] = …` / `({ a: ref.current } = …)` — destructuring writes. */
const destructuredCurrents = (pattern: ts.Node): ts.Expression[] => {
  const found: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    const target = currentTarget(node)
    if (target) {
      found.push(target)
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(pattern, visit)
  return found
}

const squash = (node: ts.Node): string => node.getText().replace(/\s+/g, '')

/**
 * `!x.current`, `x.current === null`, `x.current == null`,
 * `x.current === undefined`, and `||`/`&&` combinations of those — and nothing
 * else. `if (props.enabled)` is not a guard, and neither is
 * `if (x.current !== null)`, whose then-branch is the populated case.
 */
const isNullishGuardFor = (expr: ts.Expression, target: string): boolean => {
  if (ts.isParenthesizedExpression(expr)) return isNullishGuardFor(expr.expression, target)
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return squash(expr.operand) === target
  }
  if (ts.isBinaryExpression(expr)) {
    const kind = expr.operatorToken.kind
    if (kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return isNullishGuardFor(expr.left, target) || isNullishGuardFor(expr.right, target)
    }
    if (
      kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      kind === ts.SyntaxKind.EqualsEqualsToken
    ) {
      const left = squash(expr.left)
      const right = squash(expr.right)
      const nullish = (text: string): boolean => text === 'null' || text === 'undefined'
      return (left === target && nullish(right)) || (right === target && nullish(left))
    }
  }
  return false
}

/** The write sits in the then-branch of an `if` that tests the same slot. */
const isGuardedLazyInit = (write: ts.Node, target: string): boolean => {
  for (let parent = write.parent; parent; parent = parent.parent) {
    if (isFunctionLike(parent)) return false
    if (ts.isIfStatement(parent) && isNullishGuardFor(parent.expression, target)) {
      for (let step: ts.Node | undefined = write; step && step !== parent; step = step.parent) {
        if (step === parent.thenStatement) return true
      }
    }
  }
  return false
}

export interface RenderScopeRefWrite {
  readonly file: string
  readonly line: number
  readonly code: string
}

export const findRenderScopeRefWrites = (
  fileName: string,
  source: string,
): RenderScopeRefWrite[] => {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  )
  const hits: RenderScopeRefWrite[] = []

  const record = (target: ts.Expression, whole: ts.Node): void => {
    const fn = enclosingFunction(whole)
    if (!fn || !callsHookDirectly(fn)) return
    if (isGuardedLazyInit(whole, squash(target))) return
    const { line } = sourceFile.getLineAndCharacterOfPosition(whole.getStart(sourceFile))
    hits.push({
      file: fileName,
      line: line + 1,
      code: whole.getText().split('\n')[0].trim().slice(0, 100),
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      const direct = currentTarget(node.left)
      if (direct) {
        if (!SELF_GUARDING_OPERATORS.has(node.operatorToken.kind)) record(direct, node)
      } else if (
        ts.isArrayLiteralExpression(node.left) ||
        ts.isObjectLiteralExpression(node.left)
      ) {
        for (const target of destructuredCurrents(node.left)) record(target, node)
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const target = currentTarget(node.operand)
      if (target) record(target, node)
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)
  return hits
}

const component = (body: string): string => `
import { useEffect, useRef } from 'react'
export default function Effect({ color }: { color: string }) {
  const ref = useRef<string | null>(null)
${body}
  return <div>{color}</div>
}
`

const lines = (fixture: string): number[] =>
  findRenderScopeRefWrites('Fixture.tsx', fixture).map((hit) => hit.line)

describe('render-scope ref-write detector', () => {
  // Positive cases. Each is a write during render spelled a different way; a
  // detector that only handles the first one is a detector one rename defeats.
  it.each([
    ['plain assignment', '  ref.current = color'],
    ['bracketed property', "  ref['current'] = color"],
    ['compound assignment', '  ref.current += color'],
    ['increment', '  ref.current++'],
    ['prefix decrement', '  --ref.current'],
    ['array destructuring', '  ;[ref.current] = [color]'],
    ['object destructuring', '  ;({ a: ref.current } = { a: color })'],
    ['guard that is not about the ref', '  if (color) ref.current = color'],
    ['else branch of a nullish guard', '  if (ref.current === null) {} else ref.current = color'],
    ['nested inside a block', '  {\n    ref.current = color\n  }'],
  ])('flags %s', (_label, body) => {
    expect(lines(component(body))).toHaveLength(1)
  })

  it('flags the write whatever the ref and the component are called', () => {
    const renamed = `
import { useRef } from 'react'
const SomethingElse = ({ color }: { color: string }) => {
  const zzzWhateverBag = useRef<string | null>(null)
  zzzWhateverBag.current = color
  return null
}
export default SomethingElse
`
    expect(lines(renamed)).toHaveLength(1)
  })

  // Negative cases. A detector that fires on these is a detector that gets
  // suppressed, and a suppressed detector guards nothing.
  it.each([
    ['null-guarded lazy init', '  if (ref.current === null) ref.current = color'],
    ['loose-null-guarded lazy init', '  if (ref.current == null) ref.current = color'],
    ['undefined-guarded lazy init', '  if (ref.current === undefined) ref.current = color'],
    ['falsy-guarded lazy init', '  if (!ref.current) ref.current = color'],
    ['either-nullish guard', '  if (ref.current === null || ref.current === undefined) ref.current = color'],
    ['guarded lazy init in a block', '  if (!ref.current) {\n    ref.current = color\n  }'],
    ['nullish assignment operator', '  ref.current ??= color'],
    ['or-assignment operator', '  ref.current ||= color'],
    ['write inside an effect', '  useEffect(() => {\n    ref.current = color\n  })'],
    ['write inside a nested callback', '  useEffect(() => {\n    const tick = () => {\n      ref.current = color\n    }\n    tick()\n  })'],
    ['read during render', '  const seen = ref.current'],
    ['write to a plain object property', '  const bag = { current: "" }\n  bag.notCurrent = color'],
  ])('leaves %s alone', (_label, body) => {
    expect(lines(component(body))).toEqual([])
  })

  it('leaves a write at module scope alone (nothing renders there)', () => {
    const moduleScope = `
import { useRef } from 'react'
const cache = { current: '' }
cache.current = 'warm'
export default function Effect() {
  useRef(0)
  return null
}
`
    expect(lines(moduleScope)).toEqual([])
  })

  it('reports the line the write is on', () => {
    const hits = findRenderScopeRefWrites('Fixture.tsx', component('  ref.current = color'))
    expect(hits[0]?.line).toBe(5)
    expect(hits[0]?.code).toBe('ref.current = color')
  })
})

const componentFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== MANIFEST_NAME && /\.tsx?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()

describe('Originkit components', () => {
  const files = componentFiles(ORIGINKIT_DIR)

  it('actually has components to scan', () => {
    // Anchors the assertion below. Without it, a broken path or a tightened
    // filter would leave an empty list to compare against an empty list, and
    // this file would go green while inspecting nothing at all. Loose enough
    // that deleting an effect or two is not a false red — there are 31 today.
    expect(files.length).toBeGreaterThanOrEqual(25)
  })

  it('never assigns to a ref at render scope', () => {
    const violations = files.flatMap((name) =>
      findRenderScopeRefWrites(name, readFileSync(join(ORIGINKIT_DIR, name), 'utf8')).map(
        (hit) => `${hit.file}:${hit.line}  ${hit.code}`,
      ),
    )
    expect(
      violations,
      'react-doctor/no-ref-current-in-render — a ref written during render. React may replay or discard a render, and the animation loop must not be left reading props from a commit that never happened. Move the write into `useEffect(() => { ref.current = … })` with no dependency array, declared above the animation effect. Lazy init behind `if (ref.current === null)` is fine and is exempt.',
    ).toEqual([])
  })
})

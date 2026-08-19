import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The SPA image builds from `web/` plus the files it explicitly carries — and
 * nothing else.
 *
 * WHY THIS EXISTS. The root Dockerfile's `build-web` stage is not a checkout of
 * the repository. It is:
 *
 *     FROM node:24-alpine AS build-web
 *     WORKDIR /app/web
 *     COPY web/package*.json ./
 *     RUN npm ci
 *     COPY web/ ./
 *     COPY src/application/ports/public-config-persistence.port.ts \
 *          /app/src/application/ports/public-config-persistence.port.ts
 *     RUN npm run build
 *
 * `web/`, and exactly ONE file from the backend. On a developer's machine and
 * under `actions/checkout` the whole repository is on disk, so a file in
 * `web/src` can write `../../../src/anything` and every check stays green —
 * `tsc -b`, `vite build`, the whole vitest run. The truncated tree exists only
 * inside the image, so a green pipeline is not the same claim as a buildable
 * image, and the first thing to notice is a failed build on a release tag.
 *
 * That already happened in the sibling panel repo: one file gained backend
 * imports, six local verifications passed, and `npm run build` died inside the
 * image on a directory the stage never copied. The owner found out from a
 * screenshot. This file is the cabinet's half of that guard.
 *
 * WHAT IS DIFFERENT HERE. The panel keeps its specs beside its sources, so its
 * production project has to `exclude` them and its version of this test reads
 * those globs. This repo separates them by DIRECTORY: specs live in
 * `web/test/`, `tsconfig.app.json` includes `src` and carries no `exclude` at
 * all, and `tsconfig.test.json` is deliberately not referenced from
 * `tsconfig.json` (see the note there). So the exposure here is narrower and
 * differently shaped — there is no exclude list to drift, but there is also
 * nothing structural stopping a spec from being dropped into `web/src`, where
 * the production project WOULD compile it, and where its `vitest` import alone
 * fails the image, because vitest is a root devDependency that `web/`'s own
 * `npm ci` never installs.
 *
 * That is also why this file lives in `web/test/` rather than beside the
 * sources it guards: in `web/src` it would be the very violation it looks for.
 *
 * WHAT IS ALLOWED. One crossing, and it is real: `web/src/lib/
 * public-config-snapshot.ts` reads the API's own `isPublicConfigSnapshot` so
 * that the browser's last-known-good copy is validated by exactly the shape the
 * API writes, not by a re-implementation of it. The Dockerfile carries that
 * single file with its own `COPY` line. The allowance below is an explicit list
 * with a reason rather than a blanket "backend imports are fine", because the
 * point of this file is that the SECOND crossing has to be a decision somebody
 * makes on purpose.
 *
 * WHAT IT READS RATHER THAN COPIES. The compiled surface comes from
 * `tsconfig.json`'s `references` and each referenced project's
 * `include`/`exclude` — the same thing `tsc -b` reads — so `vite.config.ts`
 * (via `tsconfig.node.json`) is covered without being named here, and a new
 * project or a new source directory is guarded the day it is added. The set of
 * files the image carries across the boundary is parsed out of the Dockerfile
 * itself, so deleting that `COPY` line turns this red instead of leaving a
 * stale allowance that says "fine" about a file the image no longer has.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(WEB_ROOT, "..");

/**
 * Where the repository root lands inside the `build-web` stage. `WORKDIR` is
 * `/app/web` and `COPY web/ ./` unpacks there, so a repo-relative path `P` sits
 * at `/app/P` — which is what makes `../../../src/...` from `web/src/lib/` find
 * the carried port file at all. The stage's `WORKDIR` is asserted below rather
 * than assumed, since this mapping is the arithmetic every crossing rides on.
 */
const IMAGE_REPO_ROOT = "/app";

/**
 * Files from OUTSIDE `web/` that the image carries, keyed by repo-relative
 * path, valued by the reason. An entry here is not enough to make an import
 * work — the Dockerfile has to carry it too, and the case below asserts that
 * this list and the Dockerfile agree in both directions.
 */
const CARRIED_ACROSS_THE_BOUNDARY: ReadonlyMap<string, string> = new Map([
  [
    "src/application/ports/public-config-persistence.port.ts",
    "The public-config snapshot validator. The cabinet's localStorage copy of " +
      "the bootstrap payload must be accepted by exactly the predicate the API " +
      "writes against, so `web/src/lib/public-config-snapshot.ts` imports " +
      "`isPublicConfigSnapshot` instead of re-deriving it and drifting away. " +
      "The file imports nothing itself, which is what keeps one COPY line " +
      "sufficient.",
  ],
]);

/** Directories no compiler input lives in; keeps the walk bounded. */
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "coverage"]);

const toPosix = (path: string): string => path.split(sep).join("/");
const repoRelative = (file: string): string => toPosix(relative(REPO_ROOT, file));
const webRelative = (file: string): string => toPosix(relative(WEB_ROOT, file));
const isOutsideWeb = (file: string): boolean =>
  relative(WEB_ROOT, file).split(sep)[0] === "..";

/**
 * The tsconfigs here carry `//` comments, so they are JSONC and `JSON.parse`
 * rejects them. Blank out whole-line comments only — that is the shape all of
 * them use, and a real JSONC parser would be a dependency for one read.
 */
function readJsonc(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

/** Every `.ts`/`.tsx` under a directory, `.d.ts` included — tsc compiles those too. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry)) collectSources(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** The tsconfig glob forms these projects actually use, as a predicate. */
function matchesGlob(pattern: string, relativePath: string): boolean {
  const expression = pattern
    .split("/")
    .map((segment) =>
      segment === "**" ? ".*" : segment.replace(/\*/g, "[^/]*").replace(/\./g, "\\."),
    )
    .join("/")
    .replace(/\.\*\//g, "(?:.*/)?");
  return new RegExp(`^${expression}$`).test(relativePath);
}

/** One `include` entry: a directory, a single file, or a glob. */
function expandInclude(entry: string): string[] {
  const full = join(WEB_ROOT, entry);
  if (existsSync(full)) {
    return statSync(full).isDirectory() ? collectSources(full) : [full];
  }
  return collectSources(WEB_ROOT).filter((file) => matchesGlob(entry, webRelative(file)));
}

/** Every file one referenced project feeds to the compiler. */
function projectSources(configPath: string): string[] {
  const config = readJsonc(resolve(WEB_ROOT, configPath));
  const include = (config["include"] as string[] | undefined) ?? [];
  const exclude = (config["exclude"] as string[] | undefined) ?? [];
  const files = new Set<string>();
  for (const entry of include) {
    for (const file of expandInclude(entry)) files.add(file);
  }
  return [...files].filter(
    (file) => !exclude.some((pattern) => matchesGlob(pattern, webRelative(file))),
  );
}

/** Exactly what `npm run build`'s `tsc -b` walks: `tsconfig.json` and its references. */
function compiledByTheProductionBuild(): string[] {
  const root = readJsonc(join(WEB_ROOT, "tsconfig.json"));
  const references = (root["references"] as { path: string }[] | undefined) ?? [];
  const files = new Set<string>();
  for (const reference of references) {
    for (const file of projectSources(reference.path)) files.add(file);
  }
  return [...files].sort();
}

/**
 * Module specifiers, read off the AST rather than matched out of the text.
 *
 * A regex over `from '...'` cannot tell an import from the same words inside a
 * doc comment, and it misses forms that break a build just as hard: side-effect
 * imports, `export * from`, `import('...')`, `import('...').Type`, and
 * `import.meta.glob`, which is a build-time edge of the bundle — every match is
 * pulled into the graph, so a pattern walking out of `web/` fails the image
 * exactly like an import would.
 */
function moduleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const found: string[] = [];
  const take = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      take(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      take(node.argument.literal);
    } else if (ts.isExternalModuleReference(node)) {
      take(node.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isViteGlob =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "glob" &&
        ts.isMetaProperty(callee.expression);
      if (isDynamicImport || isRequire || isViteGlob) take(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

/** Bundler-style resolution, enough for the relative specifiers this repo writes. */
function resolveToFile(base: string): string | null {
  // A `.js` specifier written in TypeScript usually means the sibling `.ts` —
  // the backend is NodeNext and spells its imports that way.
  const stems = base.endsWith(".js") ? [base.slice(0, -3), base] : [base];
  const suffixes = [
    "",
    ".ts",
    ".tsx",
    ".d.ts",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    "/index.ts",
    "/index.tsx",
    "/index.js",
  ];
  for (const stem of stems) {
    for (const suffix of suffixes) {
      const candidate = `${stem}${suffix}`;
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

interface Crossing {
  /** Repo-relative path of the file that reaches out. */
  readonly from: string;
  /** The specifier as written. */
  readonly specifier: string;
  /** Repo-relative path it lands on: the resolved file, or the bare path if nothing is there. */
  readonly target: string;
  /** Absolute path of the resolved file, when one exists. */
  readonly resolved: string | null;
}

/** Every relative specifier in `file` that lands outside `web/`. */
function crossings(file: string): Crossing[] {
  const out: Crossing[] = [];
  for (const specifier of moduleSpecifiers(file)) {
    // Only a relative specifier can escape: `@/…` is aliased to `./src` by both
    // `vite.config.ts` and `tsconfig.app.json`, and a bare name is node_modules.
    if (!specifier.startsWith(".")) continue;
    const landing = resolve(dirname(file), specifier);
    if (!isOutsideWeb(landing)) continue;
    const resolved = resolveToFile(landing);
    out.push({
      from: repoRelative(file),
      specifier,
      target: repoRelative(resolved ?? landing),
      resolved,
    });
  }
  return out;
}

interface DockerfileStage {
  readonly found: boolean;
  readonly workdir: string;
  readonly copies: { readonly sources: string[]; readonly destination: string }[];
}

/** The `build-web` stage of the root Dockerfile, as instructions. */
function readBuildWebStage(): DockerfileStage {
  const lines: string[] = [];
  let continued = "";
  for (const raw of readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*#/.test(line)) continue;
    if (line.endsWith("\\")) {
      continued += `${line.slice(0, -1)} `;
      continue;
    }
    lines.push(`${continued}${line}`.trim());
    continued = "";
  }

  let stage: string | null = null;
  let found = false;
  let workdir = "/";
  const copies: { sources: string[]; destination: string }[] = [];

  for (const line of lines) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      stage = from[1] ?? null;
      continue;
    }
    if (stage !== "build-web") continue;
    found = true;

    const workdirMatch = /^WORKDIR\s+(\S+)/i.exec(line);
    if (workdirMatch) {
      workdir = workdirMatch[1]!;
      continue;
    }

    const copy = /^COPY\s+(.+)$/i.exec(line);
    if (!copy) continue;
    const args = copy[1]!.split(/\s+/).filter((argument) => argument.length > 0);
    // `--from=<stage>` copies out of another stage, not out of the build
    // context, so it says nothing about what the repository has to provide.
    if (args.some((argument) => argument.startsWith("--from="))) continue;
    const positional = args.filter((argument) => !argument.startsWith("--"));
    copies.push({
      sources: positional.slice(0, -1),
      destination: positional[positional.length - 1]!,
    });
  }

  return { found, workdir, copies };
}

/** Sources the `build-web` stage takes from outside `web/`, with where each lands. */
function carriedByTheImage(): { source: string; destination: string }[] {
  return readBuildWebStage().copies.flatMap((copy) =>
    copy.sources
      .filter((source) => !/^web(\/|$)/.test(source))
      .map((source) => ({ source, destination: copy.destination })),
  );
}

const COMPILED = compiledByTheProductionBuild();
const ALL_CROSSINGS = COMPILED.flatMap(crossings);

describe("the SPA image builds from web/ plus what the Dockerfile carries", () => {
  it("compiles web/src and vite.config.ts, and no specs", () => {
    // The anchor. Every case below iterates this set, so a broken walk or a
    // misread `include` would leave nothing to inspect and turn the whole file
    // into a green no-op — the failure shape this repository keeps finding.
    // 304 files today: 303 under `web/src`, plus `vite.config.ts`.
    expect(
      COMPILED.length,
      "the production project resolved to almost no files — `tsconfig.json`'s references or their `include` were misread, and everything below is inspecting an empty set",
    ).toBeGreaterThan(150);

    // Not just `src`: `tsconfig.node.json` puts `vite.config.ts` into `tsc -b`,
    // and vite reads it to build at all, so it is inside the boundary too.
    expect(
      COMPILED.map(webRelative),
      "`vite.config.ts` is no longer part of `tsc -b` — either `tsconfig.node.json` stopped covering it or its reference was dropped from `tsconfig.json`, and the SPA's own build config is now unguarded",
    ).toContain("vite.config.ts");

    expect(
      COMPILED.filter(isOutsideWeb).map(repoRelative),
      "the production build now compiles files from outside `web/`. The build-web stage copies `web/` and a named list of files, so a project `include` reaching out of the directory cannot work in the image",
    ).toEqual([]);

    // `tsconfig.app.json` has no `exclude` — the separation here is the
    // `web/test/` directory, and nothing enforces it structurally. Two ways to
    // break it, one message.
    expect(
      COMPILED.filter((file) => /\.test\.tsx?$/.test(file)).map(webRelative),
      "the production build now compiles a spec. Either one was written under `web/src` (`tsconfig.app.json` includes all of `src` and excludes nothing) or `tsconfig.test.json` was added to `tsconfig.json`'s references. Both make `tsc -b` type-check tests, and `web/`'s own `npm ci` installs no `vitest` and no `@testing-library/*` — those are root devDependencies. Put the spec in `web/test/`, which `tsconfig.test.json` checks from the backend CI job",
    ).toEqual([]);
  });

  it("reaches outside web/ only for files the image carries", () => {
    const offenders = ALL_CROSSINGS.filter(
      (crossing) => !CARRIED_ACROSS_THE_BOUNDARY.has(crossing.target),
    );

    expect(
      offenders,
      "a file compiled by the production SPA build imports from outside `web/`. The Dockerfile's build-web stage copies `web/` and one named backend file, so this resolves on your machine and in CI (`actions/checkout` gives the whole repo) and then fails inside the image. Move what you need into `web/`, or — if the file genuinely has to be shared — add a `COPY` line to the build-web stage AND an entry with a reason to `CARRIED_ACROSS_THE_BOUNDARY` in this file",
    ).toEqual([]);
  });

  it("carries files that drag nothing further in", () => {
    // The COPY line carries one FILE, not a directory. If that file imported
    // anything of its own the copy would be a half-measure: a relative import
    // would land on a path the stage never created, and a bare import would
    // want a package `web/`'s lockfile does not install. So the chain gets
    // walked, not assumed one link long.
    const webPackage = JSON.parse(readFileSync(join(WEB_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = new Set([
      ...Object.keys(webPackage.dependencies ?? {}),
      ...Object.keys(webPackage.devDependencies ?? {}),
    ]);
    const packageOf = (specifier: string): string => {
      const parts = specifier.split("/");
      return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    };

    const problems: { file: string; specifier: string; why: string }[] = [];
    const visited = new Set<string>();
    const queue = [...CARRIED_ACROSS_THE_BOUNDARY.keys()].map((path) => join(REPO_ROOT, path));

    while (queue.length > 0) {
      const file = queue.shift()!;
      const key = repoRelative(file);
      if (visited.has(key)) continue;
      visited.add(key);

      expect(
        existsSync(file),
        `\`${key}\` is listed in CARRIED_ACROSS_THE_BOUNDARY but is not in the repository — the Dockerfile's COPY of it cannot succeed`,
      ).toBe(true);

      for (const specifier of moduleSpecifiers(file)) {
        if (specifier.startsWith(".")) {
          const landing = resolve(dirname(file), specifier);
          const next = resolveToFile(landing);
          const target = repoRelative(next ?? landing);
          if (CARRIED_ACROSS_THE_BOUNDARY.has(target)) {
            if (next) queue.push(next);
            continue;
          }
          problems.push({
            file: key,
            specifier,
            why: `resolves to \`${target}\`, which the build-web stage does not copy`,
          });
          continue;
        }
        if (specifier.startsWith("node:")) continue;
        const name = packageOf(specifier);
        if (installed.has(name)) continue;
        problems.push({
          file: key,
          specifier,
          why: `needs the package \`${name}\`, which is not in web/package.json — the build-web stage runs \`npm ci\` against that lockfile only`,
        });
      }
    }

    // Anchor: an emptied allowance list would walk nothing and report clean.
    expect(
      visited.size,
      "no carried file was walked — CARRIED_ACROSS_THE_BOUNDARY is empty, so this case proved nothing",
    ).toBe(CARRIED_ACROSS_THE_BOUNDARY.size);

    expect(
      problems,
      "a file the image copies across the boundary imports something of its own, and the single COPY line no longer covers it. Either keep that file import-free, or carry what it needs as well",
    ).toEqual([]);
  });

  it("agrees with the Dockerfile about what crosses, and where it lands", () => {
    const stage = readBuildWebStage();

    expect(
      stage.found,
      "the root Dockerfile has no stage named `build-web` — it was renamed or removed, and this whole file is guarding a build that no longer exists",
    ).toBe(true);
    expect(
      stage.workdir,
      "the build-web stage's WORKDIR moved. `COPY web/ ./` lands there, so the repo root sits one level above it — the relative arithmetic every crossing depends on is computed from this",
    ).toBe(`${IMAGE_REPO_ROOT}/web`);
    expect(
      stage.copies.some((copy) => copy.sources.some((source) => /^web\/?$/.test(source))),
      "the build-web stage no longer copies `web/` wholesale",
    ).toBe(true);

    const carried = carriedByTheImage();

    // Both directions. A COPY with no entry here is an undocumented exception;
    // an entry with no COPY is an allowance for a file the image does not have,
    // which is precisely the stale-guard failure this file exists to prevent.
    expect(
      carried.map((entry) => entry.source).sort(),
      "the Dockerfile's build-web stage and CARRIED_ACROSS_THE_BOUNDARY disagree about which files cross the boundary. Update both, and give the entry here a reason",
    ).toEqual([...CARRIED_ACROSS_THE_BOUNDARY.keys()].sort());

    for (const entry of carried) {
      expect(
        entry.destination,
        `\`${entry.source}\` is copied to \`${entry.destination}\`. It has to land at \`${IMAGE_REPO_ROOT}/${entry.source}\` — the importer under \`/app/web/src/…\` reaches it by walking up out of the SPA, so the path inside the image must mirror the path in the repository`,
      ).toBe(`${IMAGE_REPO_ROOT}/${entry.source}`);
    }

    // And the far end of the chain: every crossing that actually exists in the
    // tree must point at something one of those COPY lines produces.
    const produced = new Set(carried.map((entry) => entry.destination));
    for (const crossing of ALL_CROSSINGS) {
      expect(
        produced.has(`${IMAGE_REPO_ROOT}/${crossing.target}`),
        `\`${crossing.from}\` imports \`${crossing.specifier}\`, which is \`${IMAGE_REPO_ROOT}/${crossing.target}\` inside the image — no COPY in the build-web stage puts a file there`,
      ).toBe(true);
    }
  });

  it("still sees the one deliberate crossing, so the detector is not blind", () => {
    // `public-config-snapshot.ts` reaches into the backend on purpose. If this
    // stops finding it, either that import is gone — in which case the COPY
    // line and the allowance above are dead weight and should go with it — or
    // `crossings` stopped working, and the guard two cases up has been quietly
    // passing on everything.
    const known = crossings(join(WEB_ROOT, "src/lib/public-config-snapshot.ts"));
    expect(
      known.map((crossing) => crossing.target),
      "the known cross-boundary import is gone. If that was deliberate, drop the Dockerfile COPY line and the CARRIED_ACROSS_THE_BOUNDARY entry with it; if not, the detector is broken and nothing here is being checked",
    ).toEqual(["src/application/ports/public-config-persistence.port.ts"]);
  });

  it("keeps the HTML entry inside web/ too", () => {
    // `index.html` is rollup's input, not a source file, so no tsconfig covers
    // it. A `src`/`href` walking out of `web/` fails in the image the same way.
    const html = readFileSync(join(WEB_ROOT, "index.html"), "utf8");
    const references = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(
      references.length,
      "no src/href was read out of index.html — the match broke and this case is inspecting nothing",
    ).toBeGreaterThan(3);
    expect(
      references.filter((reference) => reference.startsWith("../")),
      "index.html references something above `web/`. Vite's build root is `web/`, and the image has nothing above it but the files the Dockerfile names",
    ).toEqual([]);
  });
});

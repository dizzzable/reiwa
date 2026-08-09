import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The test sources are type-checked, and CI is the thing that checks them.
 *
 * Vitest compiles specs with esbuild, which strips types without reading them.
 * So for a long time nothing in this repository type-checked a single test
 * file: the root `tsconfig.json` includes `src/**` only, and
 * `web/tsconfig.test.json` existed but was referenced by no project and invoked
 * by no command — a config file that read like coverage and was not.
 *
 * That is worse here than in most repos, because most of `test/web/` is
 * SOURCE-TEXT contracts: specs that read a component as a string and assert a
 * class or a prop is present. A rename can break the contract itself, and
 * without a compiler in the loop the spec keeps passing while guarding nothing.
 *
 * This spec pins the wiring, not the types — the types are pinned by the two
 * `tsc` invocations it asserts exist.
 */

const CI = readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const WEB_TEST_TSCONFIG = readFileSync(
  new URL("../../web/tsconfig.test.json", import.meta.url),
  "utf8",
);
const ROOT_TEST_TSCONFIG = readFileSync(
  new URL("../../tsconfig.test.json", import.meta.url),
  "utf8",
);
const ROOT_PACKAGE = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { readonly scripts: Record<string, string> };

describe("test sources are type-checked", () => {
  it("runs both test projects through tsc in CI", () => {
    for (const project of ["tsconfig.test.json", "web/tsconfig.test.json"]) {
      expect(
        CI,
        `.github/workflows/ci.yml no longer runs \`tsc -p ${project}\` — the specs it covers go back to being compiled by esbuild, which never reads a type, so a source-text contract can be broken by a rename with nothing to say so`,
      ).toMatch(new RegExp(`tsc\\s+-p\\s+${project.replace(/[.\\/]/g, "\\$&")}`));
    }
  });

  it("keeps that runnable by hand, so a failure is reproducible locally", () => {
    const script = ROOT_PACKAGE.scripts["check:tests"];
    expect(
      script,
      "`npm run check:tests` is gone — a CI-only check is one nobody can reproduce before pushing",
    ).toBeTruthy();
    expect(script).toContain("tsconfig.test.json");
    expect(script).toContain("web/tsconfig.test.json");
  });

  it("covers every test directory between the two projects", () => {
    // `test/web` is in the WEB project, not the root one: those specs import
    // `web/src`, which needs bundler resolution, the DOM lib, JSX and the `@/*`
    // alias. Splitting them the other way reports a TS2835 on every
    // extensionless import in the graph they pull in.
    expect(
      WEB_TEST_TSCONFIG,
      "web/tsconfig.test.json stopped including `web/test` — 50 spec files fall out of type checking",
    ).toMatch(/"include":[^\]]*"test"/);
    expect(
      WEB_TEST_TSCONFIG,
      "web/tsconfig.test.json stopped including `../test/web` — the source-text contracts fall out of type checking, and the root project cannot take them (bundler resolution, DOM, JSX, `@/*`)",
    ).toMatch(/"include":[^\]]*"\.\.\/test\/web"/);
    expect(
      ROOT_TEST_TSCONFIG,
      "tsconfig.test.json stopped including `test` — the backend specs fall out of type checking",
    ).toMatch(/"include":[^\]]*"test"/);
  });
});

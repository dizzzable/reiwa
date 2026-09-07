/**
 * What the flags cost a customer, and the two lines that keep it small.
 *
 * NOT a jsdom file, deliberately: under the jsdom environment this project
 * serves modules over http, so `import.meta.url` is not a file URL and
 * `readFileSync` on it throws. The rendering half lives next door in
 * `country-flag.test.tsx`; this half only reads configuration off disk.
 *
 * The set is 271 files and about two megabytes. A customer is meant to pay for
 * the handful of flags their operator actually uses, and both halves of that
 * promise are one line each — a `prebuild` hook that puts the files in place,
 * and a precache exclusion that stops the service worker shipping all of them
 * to every first load. Neither shows up in a screenshot when it breaks.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("what the flags cost a customer", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
  const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

  it("copies the set before every build and every dev run", () => {
    // Not committed — 271 generated binaries in a diff help nobody — so the
    // only thing standing between a fresh clone and a screen full of badges is
    // these two hooks.
    expect(packageJson.scripts["prebuild"]).toContain("sync-flags");
    expect(packageJson.scripts["predev"]).toContain("sync-flags");
    expect(packageJson.devDependencies["flag-icons"]).toBeTruthy();
  });

  it("addresses the files through the app's own base path", () => {
    // Not assertable from a render: under test `BASE_URL` is "/", so a
    // hard-coded `/flags/...` produces a byte-identical src and every rendered
    // assertion passes either way. The cabinet can be served from a sub-path,
    // where the hard-coded form 404s into the fallback badge — a failure that
    // looks exactly like no failure.
    const component = readFileSync(
      new URL("../src/components/ui/country-flag.tsx", import.meta.url),
      "utf8",
    );
    expect(component).toContain("import.meta.env.BASE_URL");
    expect(component).not.toMatch(new RegExp("src=[{]`/flags"));
  });

  it("keeps them out of the service worker's precache", () => {
    // THE COST. `globPatterns` already matches `**/*.svg`, so without this line
    // every customer downloads about two megabytes of flags on first load to
    // look at the six their operator uses.
    expect(viteConfig).toMatch(/globIgnores:\s*\[[^\]]*flags/);
  });
});

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fixed fixture directory shared by two test files is a silent flake factory.
 *
 * `bun test --isolate` gives each file its own module registry, but every file shares one
 * process and one filesystem. Two files that delete and recreate the same path while
 * pointing OPENCODEX_HOME at it will destroy each other's config and credentials whenever
 * the suite happens to overlap them. The failure surfaces as an unrelated assertion (a 401
 * where a 400 was expected) in whichever file lost the race, and the failure count changes
 * from run to run.
 *
 * That is exactly how `.tmp-server-auth-test` came to be declared by both
 * server-auth.test.ts and management-provider-validation.test.ts: the 665b65643 split copied
 * the path literal without renaming it. Reviewers do not reliably catch a duplicated string
 * across two large files, so assert it here instead.
 */
const TESTS_DIR = import.meta.dir;

/** `join(import.meta.dir, ".tmp-foo")` and the template-literal spelling of the same thing. */
const FIXTURE_LITERAL = /import\.meta\.dir\s*,\s*(["'`])(\.tmp-[^"'`]*)\1/g;

/** This guard quotes the offending literal in its own prose, so it must skip itself. */
const SELF = "fixture-dir-uniqueness.test.ts";

function testFiles(): string[] {
  return readdirSync(TESTS_DIR)
    .filter(name => name.endsWith(".test.ts") && name !== SELF)
    .sort();
}

/**
 * Strip comments before scanning. The fix for the original flake left an explanatory comment
 * naming the old path in both files, and a naive scan reads that as a live declaration — the
 * first version of this guard failed exactly that way.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("test fixture directories", () => {
  test("no static fixture directory is shared by two test files", () => {
    const owners = new Map<string, string[]>();

    for (const file of testFiles()) {
      const source = withoutComments(readFileSync(join(TESTS_DIR, file), "utf8"));
      for (const match of source.matchAll(FIXTURE_LITERAL)) {
        const literal = match[2]!;
        // Paths carrying a runtime value (`${process.pid}`, a counter, mkdtemp output) are
        // already per-run and cannot collide, so they are not the hazard this guards.
        if (literal.includes("${")) continue;
        const list = owners.get(literal) ?? [];
        if (!list.includes(file)) list.push(file);
        owners.set(literal, list);
      }
    }

    // Name the offenders rather than just failing a count: the fix is to give one of them its
    // own directory, and the message should say which files to look at.
    const shared = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([literal, files]) => `${literal} <- ${files.join(", ")}`);

    expect(shared).toEqual([]);
  });

  test("the two files behind the original flake no longer use a fixed path", () => {
    // Regression pin for the specific pair. Both now derive a per-run directory, which also
    // makes two concurrent runs of the SAME file safe — something a rename alone would miss.
    for (const file of ["server-auth.test.ts", "management-provider-validation.test.ts"]) {
      const source = withoutComments(readFileSync(join(TESTS_DIR, file), "utf8"));
      expect(source).not.toContain('join(import.meta.dir, ".tmp-server-auth-test")');
      expect(source).toContain("mkdtempSync(join(tmpdir()");
    }
  });
});

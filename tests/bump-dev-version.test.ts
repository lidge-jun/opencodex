import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideDevVersion } from "../scripts/bump-dev-version";

/**
 * The bump rule that keeps dev off an already-published version.
 *
 * Every case here is a real repair this repository performed by hand. The rule was got
 * wrong once during design - "increment the released minor" - and befcac3e1 is the
 * case that disproves it, so that row is load-bearing rather than an edge case.
 */

// fileURLToPath, not .pathname: on Windows the pathname is "/D:/a/.../bump-dev-version.ts",
// which bun cannot open, so every CLI case exited 1 before reaching the code under test —
// and the malformed-input case read that same load failure as a correct rejection.
const CLI = fileURLToPath(new URL("../scripts/bump-dev-version.ts", import.meta.url));

function runCli(...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args]);
  return { ...proc, stderrText: new TextDecoder().decode(proc.stderr) };
}

function tempPackageJson(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-bump-"));
  const path = join(dir, "package.json");
  // Two neighbouring keys and specific spacing on purpose: the CLI rewrites only the
  // version line, and this fixture is what proves the rest stays byte-identical.
  const body = [
    "{",
    '  "name": "@bitkyc08/opencodex",',
    '  "version": "' + version + '",',
    '  "private": false',
    "}",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  return path;
}

describe("dev version bump rule", () => {
  test("a stable release moves dev to the next minor", () => {
    // e4a85d134 (2.33.0 -> 2.34.0) and 076ad3036 (2.34.0 -> 2.35.0).
    expect(decideDevVersion("2.36.0", "2.36.0")).toMatchObject({ changed: true, version: "2.37.0" });
    expect(decideDevVersion("2.36.0", "2.35.0")).toMatchObject({ changed: true, version: "2.37.0" });
    expect(decideDevVersion("2.33.0", "2.32.1-preview.20260825")).toMatchObject({ changed: true, version: "2.34.0" });
  });

  test("a prerelease moves dev to that prereleases own stable core", () => {
    // befcac3e1: published v2.36.0-preview.20260829, dev went to 2.36.0 - NOT 2.37.0.
    // An "increment the released minor" rule returns 2.37.0 here and skips a stable
    // version that has not shipped. This assertion is the whole reason the rule keys
    // off the published version shape.
    expect(decideDevVersion("2.36.0-preview.20260829", "2.35.0")).toMatchObject({
      changed: true,
      version: "2.36.0",
    });
    expect(decideDevVersion("2.36.0-preview.20260829", "2.35.0").version).not.toBe("2.37.0");
  });

  test("dev already ahead is a no-op, not a downgrade", () => {
    expect(decideDevVersion("2.36.0", "2.37.0")).toMatchObject({ changed: false, version: "2.37.0" });
    // A prerelease of a FUTURE core is ahead of a published stable. This is the same
    // ordering release-version-line.test.ts pins, so the two must not disagree.
    expect(decideDevVersion("2.36.0", "2.37.0-preview.1")).toMatchObject({ changed: false });
    // dev already carries the prerelease stable core.
    expect(decideDevVersion("2.36.0-preview.20260830", "2.36.0")).toMatchObject({ changed: false });
  });

  test("a v-prefixed release tag is accepted, not double-prefixed", () => {
    // The workflow passes github.event.release.tag_name, which is "v2.36.0", while
    // package.json holds a bare "2.36.0". Prefixing blindly built "vv2.36.0" and the
    // comparison silently misordered, so the script rejected a correct candidate with
    // "candidate 2.37.0 does not rank ahead of released v2.36.0". Both forms must agree.
    expect(decideDevVersion("v2.36.0", "2.35.0")).toMatchObject({ changed: true, version: "2.37.0" });
    // Compare the DECISION, not the reason text: reason echoes the input verbatim, so it
    // legitimately differs between the two forms while the outcome must not.
    const tagged = decideDevVersion("v2.36.0", "2.35.0");
    const bare = decideDevVersion("2.36.0", "2.35.0");
    expect({ changed: tagged.changed, version: tagged.version })
      .toEqual({ changed: bare.changed, version: bare.version });
    expect(decideDevVersion("v2.36.0-preview.20260829", "2.35.0")).toMatchObject({
      changed: true,
      version: "2.36.0",
    });
    // And a v-prefixed dev version must not fool the ahead-check either.
    expect(decideDevVersion("v2.36.0", "v2.37.0")).toMatchObject({ changed: false });
  });

  test("a malformed version is refused rather than guessed at", () => {
    expect(() => decideDevVersion("not-a-version", "2.36.0")).toThrow(/not parseable/);
    expect(() => decideDevVersion("2.36", "2.36.0")).toThrow(/not parseable/);
    expect(() => decideDevVersion("2.36.0", "garbage")).toThrow(/not parseable/);
  });

  test("the CLI rewrites only the version line", () => {
    const path = tempPackageJson("2.36.0");
    const before = readFileSync(path, "utf8");
    const proc = runCli("2.36.0", path);
    expect(proc.exitCode, proc.stderrText).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(after).toContain('"version": "2.37.0"');
    // Everything else survives. A JSON round-trip would reformat the file and turn a
    // one-line bump into an unreviewable diff, so assert the inverse substitution
    // reproduces the original exactly.
    expect(after.replace('"version": "2.37.0"', '"version": "2.36.0"')).toBe(before);
  });

  test("the CLI leaves the file byte-identical when nothing is needed", () => {
    const path = tempPackageJson("2.37.0");
    const before = readFileSync(path, "utf8");
    const proc = runCli("2.36.0", path);
    expect(proc.exitCode, proc.stderrText).toBe(0);
    // Byte-identical, not merely "still parses": a no-op run that reformats the file
    // would open a pull request with a diff and no version change.
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(new TextDecoder().decode(proc.stdout)).toContain('"changed":false');
  });

  test("the rewrite is atomic and leaves no debris", () => {
    // package.json is package metadata, so a partial write corrupts a checkout and this
    // script is also the documented manual recovery path - it runs on developer machines
    // where an interrupt or a full disk mid-write would strand an unusable file.
    // scripts/AGENTS.md requires atomic replacement for exactly this class of file.
    const path = tempPackageJson("2.36.0");
    const dir = dirname(path);
    const proc = runCli("2.36.0", path);
    expect(proc.exitCode, proc.stderrText).toBe(0);
    // The temp sibling must be gone: a leftover .tmp-<pid> means the rename never
    // happened and the write was not atomic.
    expect(readdirSync(dir).filter(f => f.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(dir)).toEqual(["package.json"]);
    // And the surviving file is complete, not truncated.
    const after = readFileSync(path, "utf8");
    expect(JSON.parse(after).version).toBe("2.37.0");
    expect(JSON.parse(after).name).toBe("@bitkyc08/opencodex");
    expect(after.endsWith("}\n")).toBe(true);
  });

  // Skipped on Windows: `chmod 0500` is not access control there, so the write would
  // succeed and this test would fail red for a reason that has nothing to do with the
  // behavior under test. Same guard as tests/codex-native-residue.test.ts uses for its
  // EACCES case. The POSIX runners still cover the failure path.
  const unwritableTest = process.platform === "win32" ? test.skip : test;
  unwritableTest("an unwritable target fails closed with the original intact", () => {
    // The atomic path must not destroy the original when the write itself fails. A
    // read-only directory makes both the temp write and the rename impossible.
    const path = tempPackageJson("2.36.0");
    const before = readFileSync(path, "utf8");
    const dir = dirname(path);
    chmodSync(dir, 0o500);
    try {
      const proc = runCli("2.36.0", path);
      expect(proc.exitCode).not.toBe(0);
      // Byte-identical: the failure path must leave the checkout installable.
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(dir).filter(f => f.includes(".tmp-"))).toEqual([]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("the CLI fails without writing when the released version is malformed", () => {
    const path = tempPackageJson("2.36.0");
    const before = readFileSync(path, "utf8");
    const proc = runCli("nonsense", path);
    expect(proc.exitCode).not.toBe(0);
    // The specific rejection, not "any nonzero": a module-load failure also exits 1.
    expect(proc.stderrText).toContain("released version is not parseable");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

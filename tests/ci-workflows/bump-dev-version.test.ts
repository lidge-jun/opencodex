import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideDevVersion } from "../../scripts/bump-dev-version";
import { assertReleasable } from "../../scripts/version-line";

/**
 * The bump rule that moves dev ahead of an intended or already-published version.
 *
 * Every case here is a real repair this repository performed by hand. The rule was got
 * wrong once during design - "increment the released minor" - and befcac3e1 is the
 * case that disproves it, so that row is load-bearing rather than an edge case.
 */

// fileURLToPath, not .pathname: on Windows the pathname is "/D:/a/.../bump-dev-version.ts",
// which bun cannot open, so every CLI case exited 1 before reaching the code under test —
// and the malformed-input case read that same load failure as a correct rejection.
const CLI = fileURLToPath(new URL("../../scripts/bump-dev-version.ts", import.meta.url));
const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/dev-version-bump.yml", import.meta.url));
const VERSION_LINE_CLI = fileURLToPath(new URL("../../scripts/version-line.ts", import.meta.url));

function runCli(...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args]);
  return { ...proc, stderrText: new TextDecoder().decode(proc.stderr) };
}

async function runVersionLineCli(args: string[], stdin = "") {
  const proc = Bun.spawn([process.execPath, VERSION_LINE_CLI, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  proc.stdin.write(stdin);
  proc.stdin.end();
  return {
    exitCode: await proc.exited,
    stdoutText: await stdoutPromise,
    stderrText: await stderrPromise,
  };
}

// Relative to the fixture root, in the order scripts/release-version-sources.ts plans them.
const VERSION_SOURCES = [
  "package.json",
  "desktop/src-tauri/tauri.conf.json",
  "desktop/src-tauri/Cargo.toml",
  "desktop/src-tauri/Cargo.lock",
] as const;
type VersionSource = (typeof VERSION_SOURCES)[number];

// The literal each source carries its own version as. The inverse-substitution checks
// swap exactly this text, so it must name the version line and nothing else.
const VERSION_LINE: Record<VersionSource, (version: string) => string> = {
  "package.json": version => '"version": "' + version + '"',
  "desktop/src-tauri/tauri.conf.json": version => '"version": "' + version + '"',
  "desktop/src-tauri/Cargo.toml": version => 'version = "' + version + '"',
  "desktop/src-tauri/Cargo.lock": version => 'version = "' + version + '"',
};

function sourcePath(root: string, source: VersionSource): string {
  return join(root, ...source.split("/"));
}

function tauriConfBody(version: string | null): string {
  // "version" sits after "productName" and before a nested object, as in the real file.
  // With version null the top-level key is gone but a nested "version" remains: the writer
  // must refuse the file rather than bump the nested one.
  return [
    "{",
    '  "$schema": "https://schema.tauri.app/config/2",',
    '  "productName": "OpenCodex",',
    ...(version === null ? [] : ['  "version": "' + version + '",']),
    '  "identifier": "com.opencodex.desktop",',
    '  "build": {',
    '    "frontendDist": "../dist",',
    '    "devUrl": "http://localhost:1420"',
    "  },",
    '  "plugins": {',
    '    "updater": { "version": "1.0.0", "active": true }',
    "  }",
    "}",
    "",
  ].join("\n");
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

  // The CLI moves the desktop sources beside package.json too, and refuses to write
  // anything when one is missing, so a package.json-only fixture no longer exercises the
  // success path. Each desktop fixture carries a second, unrelated version on purpose -
  // a dependency requirement in Cargo.toml, another crate in Cargo.lock, a nested key in
  // tauri.conf.json - so the byte-identity checks prove only the owning line moved.
  mkdirSync(join(dir, "desktop", "src-tauri"), { recursive: true });
  writeFileSync(sourcePath(dir, "desktop/src-tauri/tauri.conf.json"), tauriConfBody(version), "utf8");
  writeFileSync(sourcePath(dir, "desktop/src-tauri/Cargo.toml"), [
    "[package]",
    'name = "opencodex-desktop"',
    'version = "' + version + '"',
    'edition = "2021"',
    "",
    "[dependencies]",
    'serde = { version = "1.0.210", features = ["derive"] }',
    'tauri = { version = "2.1.0", features = [] }',
    "",
  ].join("\n"), "utf8");
  writeFileSync(sourcePath(dir, "desktop/src-tauri/Cargo.lock"), [
    "# This file is automatically @generated by Cargo.",
    "# It is not intended for manual editing.",
    "version = 4",
    "",
    "[[package]]",
    'name = "serde"',
    'version = "1.0.210"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    "",
    "[[package]]",
    'name = "opencodex-desktop"',
    'version = "' + version + '"',
    "dependencies = [",
    ' "serde",',
    ' "tauri",',
    "]",
    "",
  ].join("\n"), "utf8");
  return path;
}

/** Every version source that exists under root, keyed by its relative path. */
function snapshot(root: string): Partial<Record<VersionSource, string>> {
  const out: Partial<Record<VersionSource, string>> = {};
  for (const source of VERSION_SOURCES) {
    const file = sourcePath(root, source);
    if (existsSync(file)) out[source] = readFileSync(file, "utf8");
  }
  return out;
}

/** Temp siblings in every directory the writer touches. */
function tempDebris(root: string): string[] {
  return [root, join(root, "desktop"), join(root, "desktop", "src-tauri")]
    .filter(dir => existsSync(dir))
    .flatMap(dir => readdirSync(dir).filter(f => f.includes(".tmp-")).map(f => join(dir, f)));
}

describe("dev version bump rule", () => {
  test("the idempotency check filters the repository-owned head before pagination", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const block = workflow.match(/open_prs="\$\(([\s\S]*?)\n\s*\)"/)?.[1];
    expect(block).toBeDefined();
    expect(block).toContain('gh api --method GET "repos/${GITHUB_REPOSITORY}/pulls"');
    expect(block).toContain("-f state=open");
    expect(block).toContain("-f base=dev");
    expect(block).toContain('-f "head=${GITHUB_REPOSITORY_OWNER}:${branch}"');
    expect(block).toContain("-F per_page=1");
    expect(block).toContain("--jq 'length'");
    expect(block).not.toContain("gh pr list");
    expect(block).not.toContain("isCrossRepository");
  });

  test("an intended release uses the same shape rule before publication", () => {
    expect(decideDevVersion("2.42.0", "2.42.0")).toMatchObject({
      changed: true,
      version: "2.43.0",
    });
    expect(decideDevVersion("2.43.0-preview.20260904", "2.42.0")).toMatchObject({
      changed: true,
      version: "2.43.0",
    });
  });

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
    // The workflow accepts an intended version with an optional leading v, while
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

  test("release ordering refuses a patch after a higher-core preview opens", () => {
    expect(assertReleasable({
      candidate: "2.42.1",
      tags: ["v2.42.0"],
    })).toEqual({ ok: true });
    expect(assertReleasable({
      candidate: "2.42.1",
      tags: ["v2.42.0", "v2.43.0-preview.1"],
    })).toEqual({ ok: false, blockedBy: "v2.43.0-preview.1" });
  });

  test("release ordering preserves only the explicit equal-tag dry-run exception", () => {
    expect(assertReleasable({
      candidate: "2.42.0",
      tags: ["v2.42.0"],
    })).toEqual({ ok: false, blockedBy: "v2.42.0" });
    expect(assertReleasable({
      candidate: "2.42.0",
      tags: ["v2.42.0"],
      allowExistingTagAtHead: true,
    })).toEqual({ ok: true });
    expect(assertReleasable({
      candidate: "2.42.0",
      tags: ["v2.42.0", "v2.43.0-preview.1"],
      allowExistingTagAtHead: true,
    })).toEqual({ ok: false, blockedBy: "v2.43.0-preview.1" });
  });

  test("the version-line CLI wires both gates, stdin tags, and usage failures", async () => {
    const ahead = await runVersionLineCli(["assert-ahead", "2.43.0", "2.42.0"]);
    expect(ahead.exitCode, ahead.stderrText).toBe(0);

    const behind = await runVersionLineCli(["assert-ahead", "2.42.0", "2.42.0"]);
    expect(behind.exitCode).not.toBe(0);
    expect(behind.stderrText).toContain("does not outrank 2.42.0");

    const releasable = await runVersionLineCli(
      ["assert-releasable", "2.42.1"],
      "v2.42.0\n",
    );
    expect(releasable.exitCode, releasable.stderrText).toBe(0);

    const blocked = await runVersionLineCli(
      ["assert-releasable", "2.42.1"],
      "v2.42.0\nv2.43.0-preview.1\n",
    );
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderrText).toContain("blocked by v2.43.0-preview.1");

    const allowedEqual = await runVersionLineCli(
      ["assert-releasable", "2.42.0", "--allow-existing-tag-at-head"],
      "v2.42.0\n",
    );
    expect(allowedEqual.exitCode, allowedEqual.stderrText).toBe(0);

    const unknown = await runVersionLineCli(["nonsense"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderrText).toContain(
      "usage: bun scripts/version-line.ts assert-ahead <a> <b> | assert-releasable <version> [--allow-existing-tag-at-head]",
    );
  });

  test("the CLI rewrites only the version line", () => {
    const path = tempPackageJson("2.36.0");
    const root = dirname(path);
    const originals = snapshot(root);
    const before = readFileSync(path, "utf8");
    const proc = runCli("2.36.0", path);
    expect(proc.exitCode, proc.stderrText).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(after).toContain('"version": "2.37.0"');
    // Everything else survives. A JSON round-trip would reformat the file and turn a
    // one-line bump into an unreviewable diff, so assert the inverse substitution
    // reproduces the original exactly.
    expect(after.replace('"version": "2.37.0"', '"version": "2.36.0"')).toBe(before);

    // The same holds for every desktop source. The new version must appear exactly once,
    // on the owning line, so the single inverse substitution below cannot hide a second
    // edit - the serde requirement, the serde lock entry and the nested updater version
    // all keep their own values.
    for (const source of VERSION_SOURCES) {
      const moved = readFileSync(sourcePath(root, source), "utf8");
      expect(moved.split("2.37.0").length - 1, source).toBe(1);
      expect(moved, source).toContain(VERSION_LINE[source]("2.37.0"));
      expect(moved.replace(VERSION_LINE[source]("2.37.0"), VERSION_LINE[source]("2.36.0")), source)
        .toBe(originals[source]);
    }
    const lock = readFileSync(sourcePath(root, "desktop/src-tauri/Cargo.lock"), "utf8");
    expect(lock).toContain('name = "serde"\nversion = "1.0.210"');
    expect(lock.startsWith("# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n")).toBe(true);
    const manifest = readFileSync(sourcePath(root, "desktop/src-tauri/Cargo.toml"), "utf8");
    expect(manifest).toContain('serde = { version = "1.0.210", features = ["derive"] }');
    const tauriConf = JSON.parse(readFileSync(sourcePath(root, "desktop/src-tauri/tauri.conf.json"), "utf8"));
    expect(tauriConf.version).toBe("2.37.0");
    expect(tauriConf.plugins.updater.version).toBe("1.0.0");
  });

  test("the CLI leaves the file byte-identical when nothing is needed", () => {
    const path = tempPackageJson("2.37.0");
    const originals = snapshot(dirname(path));
    const before = readFileSync(path, "utf8");
    const proc = runCli("2.36.0", path);
    expect(proc.exitCode, proc.stderrText).toBe(0);
    // Byte-identical, not merely "still parses": a no-op run that reformats the file
    // would open a pull request with a diff and no version change.
    expect(readFileSync(path, "utf8")).toBe(before);
    // The desktop sources too: the workflow stages all four, so a stray rewrite of any
    // of them would still open a pull request on a no-op.
    expect(snapshot(dirname(path))).toEqual(originals);
    expect(Object.keys(originals).sort()).toEqual([...VERSION_SOURCES].sort());
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
    expect(tempDebris(dir)).toEqual([]);
    // Exactly the fixture, nothing added: each desktop source is renamed over in place
    // beside its original, not staged in the root.
    expect(readdirSync(dir).sort()).toEqual(["desktop", "package.json"]);
    expect(readdirSync(join(dir, "desktop"))).toEqual(["src-tauri"]);
    expect(readdirSync(join(dir, "desktop", "src-tauri")).sort())
      .toEqual(["Cargo.lock", "Cargo.toml", "tauri.conf.json"]);
    // And the surviving file is complete, not truncated.
    const after = readFileSync(path, "utf8");
    expect(JSON.parse(after).version).toBe("2.37.0");
    expect(JSON.parse(after).name).toBe("@bitkyc08/opencodex");
    expect(after.endsWith("}\n")).toBe(true);
    const tauriConf = readFileSync(sourcePath(dir, "desktop/src-tauri/tauri.conf.json"), "utf8");
    expect(JSON.parse(tauriConf).version).toBe("2.37.0");
    expect(JSON.parse(tauriConf).productName).toBe("OpenCodex");
    expect(tauriConf.endsWith("}\n")).toBe(true);
    expect(readFileSync(sourcePath(dir, "desktop/src-tauri/Cargo.lock"), "utf8").endsWith("]\n")).toBe(true);
    expect(readFileSync(sourcePath(dir, "desktop/src-tauri/Cargo.toml"), "utf8")
      .endsWith('tauri = { version = "2.1.0", features = [] }\n')).toBe(true);
  });

  // Skipped on Windows: `chmod 0500` is not access control there, so the write would
  // succeed and this test would fail red for a reason that has nothing to do with the
  // behavior under test. Same guard as tests/codex-integration/codex-native-residue.test.ts uses for its
  // EACCES case. The POSIX runners still cover the failure path.
  const unwritableTest = process.platform === "win32" ? test.skip : test;
  unwritableTest("an unwritable target fails closed with the original intact", () => {
    // The atomic path must not destroy the original when the write itself fails. A
    // read-only directory makes both the temp write and the rename impossible.
    const path = tempPackageJson("2.36.0");
    const before = readFileSync(path, "utf8");
    const dir = dirname(path);
    const originals = snapshot(dir);
    chmodSync(dir, 0o500);
    try {
      const proc = runCli("2.36.0", path);
      expect(proc.exitCode).not.toBe(0);
      // The writer's own failure, not a module-load or parse failure that also exits 1.
      expect(proc.stderrText).toContain("could not move the version sources");
      // Byte-identical: the failure path must leave the checkout installable.
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(dir).filter(f => f.includes(".tmp-"))).toEqual([]);
      // Only the root is read-only; desktop/src-tauri stays writable. Every temp is
      // written before the first rename, so a desktop temp written ahead of the failing
      // one must have been removed, and no desktop original may have been replaced.
      expect(snapshot(dir)).toEqual(originals);
      expect(tempDebris(dir)).toEqual([]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("the CLI fails without writing when the released version is malformed", () => {
    const path = tempPackageJson("2.36.0");
    const originals = snapshot(dirname(path));
    const before = readFileSync(path, "utf8");
    const proc = runCli("nonsense", path);
    expect(proc.exitCode).not.toBe(0);
    // The specific rejection, not "any nonzero": a module-load failure also exits 1.
    expect(proc.stderrText).toContain("released version is not parseable");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(snapshot(dirname(path))).toEqual(originals);
    expect(tempDebris(dirname(path))).toEqual([]);
  });

  test("a missing or unlocatable desktop source fails with nothing written", () => {
    // package.json moving alone is the defect this CLI exists to prevent: npm would
    // carry the new version while the desktop app kept reporting the old one, and the
    // updater would keep offering the same release. So a desktop source the writer
    // cannot find, or cannot find the version in, must stop the whole bump - including
    // the package.json rewrite that would otherwise have succeeded on its own.
    const cases: { name: string; damage: (root: string) => void; expect: string }[] = [
      {
        name: "Cargo.lock deleted",
        damage: root => unlinkSync(sourcePath(root, "desktop/src-tauri/Cargo.lock")),
        expect: "desktop/src-tauri/Cargo.lock is missing",
      },
      {
        // Only a nested "version" left: bumping it would be a silent wrong edit.
        name: "tauri.conf.json without a top-level version",
        damage: root => writeFileSync(
          sourcePath(root, "desktop/src-tauri/tauri.conf.json"),
          tauriConfBody(null),
          "utf8",
        ),
        expect: "desktop/src-tauri/tauri.conf.json",
      },
    ];
    for (const scenario of cases) {
      const path = tempPackageJson("2.36.0");
      const root = dirname(path);
      scenario.damage(root);
      const originals = snapshot(root);
      const before = readFileSync(path, "utf8");
      const proc = runCli("2.36.0", path);
      expect(proc.exitCode, scenario.name).not.toBe(0);
      expect(proc.stderrText, scenario.name).toContain("could not move the version sources");
      expect(proc.stderrText, scenario.name).toContain(scenario.expect);
      // Byte-identical everywhere: the plan is computed before any write, so the
      // sources that were fine must not have moved ahead of the broken one.
      expect(readFileSync(path, "utf8"), scenario.name).toBe(before);
      expect(snapshot(root), scenario.name).toEqual(originals);
      expect(tempDebris(root), scenario.name).toEqual([]);
      // And no decision was reported: the workflow branches on stdout/GITHUB_OUTPUT,
      // so a failed write must not also announce a change.
      expect(new TextDecoder().decode(proc.stdout), scenario.name).not.toContain('"changed":true');
    }
  });
});

#!/usr/bin/env bun
/**
 * The files that carry the OpenCodex version, and the one place that reads or rewrites them.
 *
 * WHY THIS EXISTS
 *
 * The npm package reads its version from `package.json`. The desktop app does not: Tauri
 * takes it from `desktop/src-tauri/tauri.conf.json`, the Rust crate from
 * `desktop/src-tauri/Cargo.toml` (mirrored in the `opencodex-desktop` entry of
 * `desktop/src-tauri/Cargo.lock`), and `desktop/scripts/build-widget.sh` stamps the
 * widget plist from `tauri.conf.json`. The release workflow injects no version into the
 * desktop build, while the updater manifest is derived from the dispatch input.
 *
 * So when only `package.json` moves, a release ships an app that reports the previous version
 * under a manifest naming the new one. The desktop updater then keeps offering the same release,
 * because the installed app never reports that it caught up. `dev` reached exactly that state
 * when `package.json` moved to 2.62.0 and the three desktop sources stayed at 2.61.0.
 *
 * Every path that moves the version goes through here: `scripts/bump-dev-version.ts` for the
 * `dev` pre-move, `scripts/release.ts` for the release commit on `main`/`preview`, and
 * `.github/workflows/release.yml` / `.github/workflows/dev-version-bump.yml`, which run
 * `check` before they build or open a pull request.
 *
 * Usage:
 *   bun scripts/release-version-sources.ts check [<version>] [--root <dir>]
 *       Exit 1 unless every source carries <version> (default: package.json's version).
 *   bun scripts/release-version-sources.ts sync <version> [--root <dir>]
 *       Rewrite every source to <version>, changing only its version line.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository-relative, POSIX separators. The workflows stage exactly this list. */
export const VERSION_SOURCE_PATHS = [
  "package.json",
  "desktop/src-tauri/tauri.conf.json",
  "desktop/src-tauri/Cargo.toml",
  "desktop/src-tauri/Cargo.lock",
] as const;

export type VersionSourcePath = (typeof VERSION_SOURCE_PATHS)[number];

/** The workspace crate whose lock entry mirrors Cargo.toml. */
export const DESKTOP_CRATE = "opencodex-desktop";

/**
 * What a version may look like before it is written into four files. The value arrives from a
 * workflow input, so a quote or a newline must never reach a rewrite.
 */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A TOML `version = "..."` line, as Cargo writes it in both the manifest and the lock. */
const TOML_VERSION_LINE = /^(version\s*=\s*")([^"]*)("\s*\r?)$/;

interface VersionRule {
  /** Where the version lives, for error messages. */
  describe: string;
  read(text: string): string | null;
  /** The rewritten text, or null when the version cannot be located unambiguously. */
  rewrite(text: string, version: string): string | null;
}

function topLevelJsonVersion(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { version?: unknown } | null;
    return parsed && typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite the first `"version"` string in place so the diff is one line, then prove by
 * re-parsing that the edit hit the top-level key and changed nothing else. A nested
 * `"version"` that happens to come first fails that proof instead of being silently bumped.
 */
const jsonRule: VersionRule = {
  describe: "the top-level \"version\" key",
  read: topLevelJsonVersion,
  rewrite(text, version) {
    let expected: Record<string, unknown>;
    try {
      expected = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!expected || typeof expected !== "object" || typeof expected.version !== "string") return null;
    expected.version = version;
    const rewritten = text.replace(
      /("version"\s*:\s*")[^"]*(")/,
      (_match, open: string, close: string) => open + version + close,
    );
    try {
      return JSON.stringify(JSON.parse(rewritten)) === JSON.stringify(expected) ? rewritten : null;
    } catch {
      return null;
    }
  },
};

/** Index of the `version` line inside `[package]`, stopping at the next table header. */
function cargoManifestVersionLine(lines: string[]): number | null {
  const start = lines.findIndex(line => line.trim() === "[package]");
  if (start < 0) return null;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*\[/.test(line)) return null;
    if (TOML_VERSION_LINE.test(line)) return index;
  }
  return null;
}

/**
 * Index of the `version` line of the single `[[package]]` entry named for the desktop crate.
 * Cargo writes `name` then `version` directly under the header. A second entry with the same
 * name is ambiguous and refused rather than guessed at.
 */
function cargoLockVersionLine(lines: string[]): number | null {
  let found: number | null = null;
  for (let index = 0; index + 2 < lines.length; index++) {
    if (lines[index]!.trimEnd() !== "[[package]]") continue;
    if (lines[index + 1]!.trimEnd() !== 'name = "' + DESKTOP_CRATE + '"') continue;
    if (!TOML_VERSION_LINE.test(lines[index + 2]!)) continue;
    if (found !== null) return null;
    found = index + 2;
  }
  return found;
}

function lineRule(describe: string, locate: (lines: string[]) => number | null): VersionRule {
  return {
    describe,
    read(text) {
      const lines = text.split("\n");
      const index = locate(lines);
      return index === null ? null : TOML_VERSION_LINE.exec(lines[index]!)![2]!;
    },
    rewrite(text, version) {
      const lines = text.split("\n");
      const index = locate(lines);
      if (index === null) return null;
      lines[index] = lines[index]!.replace(
        TOML_VERSION_LINE,
        (_match, open: string, _old: string, close: string) => open + version + close,
      );
      return lines.join("\n");
    },
  };
}

const RULES: Record<VersionSourcePath, VersionRule> = {
  "package.json": jsonRule,
  "desktop/src-tauri/tauri.conf.json": jsonRule,
  "desktop/src-tauri/Cargo.toml": lineRule("the [package] version", cargoManifestVersionLine),
  "desktop/src-tauri/Cargo.lock": lineRule(
    "the version of the single " + DESKTOP_CRATE + " [[package]] entry",
    cargoLockVersionLine,
  ),
};

export interface VersionSourceReading {
  path: VersionSourcePath;
  /** null when the file is missing or its version cannot be located. */
  version: string | null;
}

function sourceFile(root: string, path: VersionSourcePath): string {
  return join(root, ...path.split("/"));
}

export function readVersionSources(root: string): VersionSourceReading[] {
  return VERSION_SOURCE_PATHS.map(path => {
    const file = sourceFile(root, path);
    if (!existsSync(file)) return { path, version: null };
    return { path, version: RULES[path].read(readFileSync(file, "utf8")) };
  });
}

/** One message per source that does not carry `expected`; empty when they all agree. */
export function versionSourceMismatches(root: string, expected: string): string[] {
  return readVersionSources(root)
    .filter(reading => reading.version !== expected)
    .map(reading => reading.version === null
      ? reading.path + ": " + RULES[reading.path].describe + " is missing or ambiguous (expected " + expected + ")"
      : reading.path + " carries " + reading.version + ", expected " + expected);
}

/**
 * Rewrite every source to `version` and return the paths whose bytes changed.
 *
 * Every rewrite is computed before anything is written, so an unlocatable source leaves the
 * whole set untouched. Each file is then replaced atomically (sibling temp file, rename), per
 * scripts/AGENTS.md. Temp files are all written before the first rename, so a write failure
 * such as a full disk or a read-only directory also leaves every original intact.
 *
 * @throws on a malformed version or any source whose version cannot be located.
 */
export function writeVersionSources(root: string, version: string): VersionSourcePath[] {
  if (!VERSION_SHAPE.test(version)) {
    throw new Error("refusing to write a malformed version: " + JSON.stringify(version));
  }

  const planned: { path: VersionSourcePath; file: string; text: string }[] = [];
  for (const path of VERSION_SOURCE_PATHS) {
    const file = sourceFile(root, path);
    if (!existsSync(file)) throw new Error(path + " is missing");
    const before = readFileSync(file, "utf8");
    const after = RULES[path].rewrite(before, version);
    if (after === null) throw new Error("could not locate " + RULES[path].describe + " in " + path);
    if (after !== before) planned.push({ path, file, text: after });
  }

  const temps: string[] = [];
  try {
    for (const entry of planned) {
      const temp = entry.file + ".tmp-" + process.pid;
      writeFileSync(temp, entry.text, "utf8");
      temps.push(temp);
    }
    planned.forEach((entry, index) => renameSync(temps[index]!, entry.file));
  } catch (err) {
    for (const temp of temps) {
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        // The original is what matters; a stray temp file is reported by the caller's failure.
      }
    }
    throw err;
  }
  return planned.map(entry => entry.path);
}

const DEFAULT_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const USAGE = "usage: bun scripts/release-version-sources.ts check [<version>] | sync <version> [--root <dir>]";

if (import.meta.main) {
  const args = process.argv.slice(2);
  let root = DEFAULT_ROOT;
  const rootFlag = args.indexOf("--root");
  if (rootFlag >= 0) {
    const value = args[rootFlag + 1];
    if (!value) {
      console.error(USAGE);
      process.exit(1);
    }
    root = value;
    args.splice(rootFlag, 2);
  }
  const [command, version, ...rest] = args;

  if (command === "check" && rest.length === 0) {
    const expected = version ?? readVersionSources(root)[0]!.version;
    if (!expected) {
      console.error("✗ package.json has no version to compare against");
      process.exit(1);
    }
    const mismatches = versionSourceMismatches(root, expected);
    if (mismatches.length > 0) {
      for (const mismatch of mismatches) console.error("✗ " + mismatch);
      process.exit(1);
    }
    console.log("✓ " + VERSION_SOURCE_PATHS.length + " version sources carry " + expected);
  } else if (command === "sync" && version && rest.length === 0) {
    try {
      const changed = writeVersionSources(root, version);
      const mismatches = versionSourceMismatches(root, version);
      if (mismatches.length > 0) throw new Error(mismatches.join("; "));
      console.log(changed.length === 0
        ? "✓ version sources already carry " + version
        : "✓ moved " + changed.join(", ") + " to " + version);
    } catch (err) {
      console.error("✗ " + (err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

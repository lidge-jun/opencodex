import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERSION_SOURCE_PATHS,
  readVersionSources,
  writeVersionSources,
} from "../../scripts/release-version-sources";
import { repoPath, repoRoot } from "../helpers/repo-root";

/**
 * The npm package and the desktop app read their version from different files. When only
 * package.json moved, dev carried 2.62.0 for npm while tauri.conf.json, Cargo.toml and the
 * opencodex-desktop Cargo.lock entry still said 2.61.0, so a release would have shipped an app
 * that reports the previous version under an updater manifest naming the new one, and the
 * updater would re-offer that release forever.
 *
 * The first test is the tripwire for that drift and parses each file itself rather than trusting
 * the module under test. The rest pin that every path which moves the version moves all four.
 */

const CLI = repoPath("scripts", "release-version-sources.ts");

function packageVersion(root: string): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

/** Copies of the real four files in a scratch root, so rewrites never touch the checkout. */
function scratchCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-version-sources-"));
  mkdirSync(join(root, "desktop", "src-tauri"), { recursive: true });
  for (const path of VERSION_SOURCE_PATHS) copyFileSync(repoPath(...path.split("/")), join(root, ...path.split("/")));
  return root;
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(VERSION_SOURCE_PATHS.map(path => [path, readFileSync(join(root, ...path.split("/")), "utf8")]));
}

function runCli(...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args]);
  return { exitCode: proc.exitCode, stderr: new TextDecoder().decode(proc.stderr) };
}

describe("release version sources", () => {
  test("every version source in the working tree carries package.json's version", () => {
    const root = repoRoot();
    const expected = packageVersion(root);
    const tauri = (JSON.parse(readFileSync(repoPath("desktop", "src-tauri", "tauri.conf.json"), "utf8")) as { version?: string }).version;
    const manifest = /^\[package\][^]*?^version = "([^"]+)"$/m.exec(readFileSync(repoPath("desktop", "src-tauri", "Cargo.toml"), "utf8"))?.[1];
    const lock = [...readFileSync(repoPath("desktop", "src-tauri", "Cargo.lock"), "utf8")
      .matchAll(/^\[\[package\]\]\r?\nname = "opencodex-desktop"\r?\nversion = "([^"]+)"$/gm)].map(match => match[1]);

    expect({ tauri, manifest, lock }).toEqual({ tauri: expected, manifest: expected, lock: [expected] });
    expect(readVersionSources(root)).toEqual(VERSION_SOURCE_PATHS.map(path => ({ path, version: expected })));
  });

  test("the source list is package.json plus the three desktop files", () => {
    expect([...VERSION_SOURCE_PATHS]).toEqual([
      "package.json",
      "desktop/src-tauri/tauri.conf.json",
      "desktop/src-tauri/Cargo.toml",
      "desktop/src-tauri/Cargo.lock",
    ]);
  });

  test("a sync moves each real source by exactly its version line", () => {
    const root = scratchCopy();
    const before = snapshot(root);
    expect(writeVersionSources(root, "9.9.9")).toEqual([...VERSION_SOURCE_PATHS]);
    const after = snapshot(root);
    for (const path of VERSION_SOURCE_PATHS) {
      const old = before[path]!.split("\n");
      const moved = after[path]!.split("\n");
      expect(moved.length, path).toBe(old.length);
      const changed = moved.flatMap((line, index) => (line === old[index] ? [] : [line]));
      expect(changed.length, path).toBe(1);
      expect(changed[0], path).toContain('"9.9.9"');
    }
    // The lock line that moved is the desktop crate's, not a dependency sharing its version.
    expect(after["desktop/src-tauri/Cargo.lock"]).toMatch(/^name = "opencodex-desktop"\nversion = "9\.9\.9"$/m);
    expect(readVersionSources(root).map(reading => reading.version)).toEqual(VERSION_SOURCE_PATHS.map(() => "9.9.9"));
    expect(readdirSync(join(root, "desktop", "src-tauri")).filter(name => name.includes(".tmp-"))).toEqual([]);

    // Idempotent: the --publish re-run of a dry run must not produce a diff.
    expect(writeVersionSources(root, "9.9.9")).toEqual([]);
    expect(snapshot(root)).toEqual(after);
  });

  test("a malformed version is refused before any file is written", () => {
    const root = scratchCopy();
    const before = snapshot(root);
    for (const version of ['9.9.9"', "9.9.9\nversion = \"1.0.0\"", "v9.9.9", "9.9", ""]) {
      expect(() => writeVersionSources(root, version), JSON.stringify(version)).toThrow(/malformed version/);
    }
    expect(snapshot(root)).toEqual(before);
  });

  test("a missing or ambiguous source fails with every file untouched", () => {
    const missing = scratchCopy();
    unlinkSync(join(missing, "desktop", "src-tauri", "Cargo.lock"));
    const packageBefore = readFileSync(join(missing, "package.json"), "utf8");
    const tauriBefore = readFileSync(join(missing, "desktop", "src-tauri", "tauri.conf.json"), "utf8");
    expect(() => writeVersionSources(missing, "9.9.9")).toThrow(/Cargo\.lock is missing/);
    expect(readFileSync(join(missing, "package.json"), "utf8")).toBe(packageBefore);
    expect(readFileSync(join(missing, "desktop", "src-tauri", "tauri.conf.json"), "utf8")).toBe(tauriBefore);

    const duplicated = scratchCopy();
    const lockPath = join(duplicated, "desktop", "src-tauri", "Cargo.lock");
    writeFileSync(lockPath, readFileSync(lockPath, "utf8") + '\n[[package]]\nname = "opencodex-desktop"\nversion = "0.0.1"\n', "utf8");
    const duplicatedBefore = snapshot(duplicated);
    expect(() => writeVersionSources(duplicated, "9.9.9")).toThrow(/opencodex-desktop/);
    expect(snapshot(duplicated)).toEqual(duplicatedBefore);

    // A nested "version" that comes first must not be bumped in place of a missing top-level one.
    const nested = scratchCopy();
    writeFileSync(join(nested, "desktop", "src-tauri", "tauri.conf.json"), '{\n  "plugin": { "version": "1.0.0" }\n}\n', "utf8");
    const nestedBefore = snapshot(nested);
    expect(() => writeVersionSources(nested, "9.9.9")).toThrow(/tauri\.conf\.json/);
    expect(snapshot(nested)).toEqual(nestedBefore);
  });

  test("the check CLI fails naming the drifted source and passes when they agree", () => {
    const root = scratchCopy();
    const version = packageVersion(root);
    expect(runCli("check", version, "--root", root).exitCode).toBe(0);
    expect(runCli("check", "--root", root).exitCode).toBe(0);

    const tauriPath = join(root, "desktop", "src-tauri", "tauri.conf.json");
    writeFileSync(tauriPath, readFileSync(tauriPath, "utf8").replace('"version": "' + version + '"', '"version": "0.0.1"'), "utf8");
    for (const args of [["check", version], ["check"]]) {
      const drifted = runCli(...args, "--root", root);
      expect(drifted.exitCode).not.toBe(0);
      expect(drifted.stderr).toContain("desktop/src-tauri/tauri.conf.json carries 0.0.1, expected " + version);
    }
    expect(runCli("check", "9.9.9", "--root", root).stderr).toContain("package.json carries " + version + ", expected 9.9.9");
    expect(runCli("nonsense").exitCode).not.toBe(0);
  });
});

type WorkflowStep = { name?: string; shell?: string; env?: Record<string, string>; run?: string };
type Workflow = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

function workflowSteps(file: string, job: string): WorkflowStep[] {
  const workflow = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", file), "utf8")) as Workflow;
  return workflow.jobs?.[job]?.steps ?? [];
}

function stepIndex(steps: WorkflowStep[], name: string): number {
  const index = steps.findIndex(step => step.name === name);
  expect(index, name).toBeGreaterThanOrEqual(0);
  return index;
}

describe("every version move covers all four sources", () => {
  test("release.yml refuses a drifted source before the desktop build and again before publish", () => {
    const desktop = workflowSteps("release.yml", "package-desktop");
    const gate = desktop[stepIndex(desktop, "Verify every version source matches the release")]!;
    expect(gate.shell).toBe("bash");
    expect(gate.env).toEqual({ RELEASE_VERSION: "$" + "{{ inputs.version }}" });
    expect(gate.run?.trim()).toBe('bun scripts/release-version-sources.ts check "$RELEASE_VERSION"');
    const gateAt = stepIndex(desktop, "Verify every version source matches the release");
    for (const later of ["Install project dependencies", "Build WidgetKit extension", "Build desktop bundles", "Upload desktop release"]) {
      expect(gateAt, later).toBeLessThan(stepIndex(desktop, later));
    }

    const publish = workflowSteps("release.yml", "publish");
    const verify = publish[stepIndex(publish, "Verify every version source matches the requested version")]!;
    expect(verify.env).toEqual({ RELEASE_VERSION: "$" + "{{ inputs.version }}" });
    expect(verify.run).toContain('bun scripts/release-version-sources.ts check "$RELEASE_VERSION" || {');
    expect(verify.run).toContain("exit 1;");
    expect(stepIndex(publish, "Setup project Bun")).toBeLessThan(stepIndex(publish, "Verify every version source matches the requested version"));
    expect(stepIndex(publish, "Verify every version source matches the requested version")).toBeLessThan(stepIndex(publish, "Publish (or dry-run)"));
  });

  test("the dev bump stages exactly the four sources and checks them before committing", () => {
    const steps = workflowSteps("dev-version-bump.yml", "open-bump-pr");
    const run = steps[stepIndex(steps, "Open the bump pull request")]!.run ?? "";
    const adds = [...run.matchAll(/^\s*git add (.+)$/gm)].map(match => match[1]!.trim());
    expect(adds).toEqual(["-- " + VERSION_SOURCE_PATHS.join(" ")]);

    const checks = [...run.matchAll(/bun scripts\/release-version-sources\.ts check "\$\{NEXT_VERSION\}"/g)].map(match => match.index!);
    expect(checks.length).toBe(2);
    // Existing-branch path: after the checkout it validates, before the pull request is opened.
    expect(checks[0]!).toBeGreaterThan(run.indexOf('git checkout -B "$' + '{branch}"'));
    // The decide step left its own rewrite in the working tree. It must be discarded before the
    // switch, or git refuses to switch and the check would read this run's edits, not the branch.
    const restore = run.indexOf("git checkout -- " + VERSION_SOURCE_PATHS.join(" "));
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(run.indexOf('git checkout -B "$' + '{branch}"'));
    // New-branch path: before anything is staged, committed or pushed.
    expect(checks[1]!).toBeLessThan(run.indexOf("git add --"));
    expect(run.indexOf("git add --")).toBeLessThan(run.indexOf('push origin "$' + '{branch}"'));
    // lastIndexOf: the step's own comments mention `gh pr create` before the command itself.
    expect(checks[1]!).toBeLessThan(run.lastIndexOf("gh pr create"));
  });

  // The guard is the only thing stopping this job, which holds contents: write, from pushing or
  // opening a pull request from a same-named branch someone else filled. Execute the workflow's
  // own shell against allowed and forbidden change sets rather than pattern-matching it.
  const bashTest = process.platform === "win32" ? test.skip : test;
  bashTest("the reused-branch guard accepts only the four sources and requires package.json", () => {
    const steps = workflowSteps("dev-version-bump.yml", "open-bump-pr");
    const run = steps[stepIndex(steps, "Open the bump pull request")]!.run ?? "";
    expect(run).toContain('git diff --no-renames --name-only "origin/dev...origin/$' + '{branch}"');
    const start = run.indexOf("touches_package_json=false");
    const endMarker = run.indexOf("does not move package.json");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(endMarker).toBeGreaterThan(start);
    // The first standalone `fi` line after the message closes the block; a bare "fi" search
    // would stop inside `changed_files`.
    const closing = /\n[ \t]*fi[ \t]*(?:\n|$)/.exec(run.slice(endMarker));
    expect(closing).not.toBeNull();
    const guard = run.slice(start, endMarker + closing!.index + closing![0].length);
    expect(guard).toContain("done <<< ");

    const verdict = (changed: string) => Bun.spawnSync(
      ["bash", "-c", 'set -euo pipefail\nbranch=codex/dev-version-9.9.9\nchanged_files="$1"\n' + guard + "\necho accepted", "guard", changed],
    ).exitCode;

    expect(verdict("package.json")).toBe(0);
    expect(verdict(VERSION_SOURCE_PATHS.join("\n"))).toBe(0);
    expect(verdict("desktop/src-tauri/Cargo.lock\npackage.json")).toBe(0);
    for (const rejected of [
      "",
      "desktop/src-tauri/Cargo.lock",
      "package.json\nsrc/server/index.ts",
      "package.json\n.github/workflows/release.yml",
      "package.json\ndesktop/src-tauri/tauri.conf.json.bak",
      "package.json\ndesktop/src-tauri/src/main.rs",
      "Package.json",
      "./package.json",
    ]) {
      expect(verdict(rejected), JSON.stringify(rejected)).not.toBe(0);
    }
  });

  test("scripts/release.ts syncs, probes and stages the same four sources", () => {
    const source = readFileSync(repoPath("scripts", "release.ts"), "utf8");
    const sync = source.indexOf('await runLoud(["bun", "scripts/release-version-sources.ts", "sync", version]);');
    expect(sync).toBeGreaterThanOrEqual(0);
    expect(source).toContain('import { VERSION_SOURCE_PATHS } from "./release-version-sources";');
    const probe = source.indexOf('capture(["git", "status", "--porcelain", "--", ...VERSION_SOURCE_PATHS])');
    const add = source.indexOf('runLoud(["git", "add", "--", ...VERSION_SOURCE_PATHS])');
    expect(probe).toBeGreaterThan(sync);
    expect(add).toBeGreaterThan(probe);
    expect(source).not.toContain('runLoud(["git", "add", "package.json"])');
  });
});

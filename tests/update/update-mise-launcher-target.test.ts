import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planMiseLauncherTargetWatch, type MiseLauncherTargetDeps } from "../../src/update/mise-launcher-target";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let toolRoot = "";

/** One mise npm-backend install as aube lays it out: `<version>/node_modules/.mise/<pkg>@<v>/...`. */
function installVersion(version: string, base = toolRoot): string {
  const store = join(base, version, "node_modules", ".mise", `@bitkyc08+opencodex@${version}`, "node_modules", "@bitkyc08", "opencodex");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version }));
  const link = join(base, version, "node_modules", "@bitkyc08", "opencodex");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join("..", ".mise", `@bitkyc08+opencodex@${version}`, "node_modules", "@bitkyc08", "opencodex"), link);
  mkdirSync(join(base, version, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(base, version, "node_modules", ".bin", "ocx"), "#!/bin/sh\n", { mode: 0o755 });
  return realpathSync(store);
}

function pointLatestAt(version: string, base = toolRoot): void {
  rmSync(join(base, "latest"), { force: true });
  symlinkSync(`./${version}`, join(base, "latest"));
}

const launcher = (base = toolRoot) => join(base, "latest", "node_modules", ".bin", "ocx");

function plan(overrides: MiseLauncherTargetDeps = {}, running = join(toolRoot, "2.65.0", "node_modules", "@bitkyc08", "opencodex")) {
  return planMiseLauncherTargetWatch({
    platform: "linux",
    env: { OCX_SERVICE_MANAGED: "1" },
    runningRoot: () => running,
    launcherPath: () => launcher(),
    ...overrides,
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-mise-launcher-")));
  toolRoot = join(root, "installs", "opencodex");
  mkdirSync(toolRoot, { recursive: true });
  writeFileSync(join(toolRoot, ".mise.backend.toml"), 'short = "opencodex"\nfull = "npm:@bitkyc08/opencodex"\n');
});

afterEach(() => {
  removeTreeWithRetry(root);
});

describe("mise launcher target plan", () => {
  test("follows `latest` from the running version to the upgraded one", () => {
    const running = installVersion("2.65.0");
    const next = installVersion("2.66.0");
    pointLatestAt("2.65.0");
    const watch = plan();
    expect(watch?.runningRoot).toBe(running);
    expect(watch?.resolveTarget()?.root).toBe(running);
    pointLatestAt("2.66.0");
    expect(watch?.resolveTarget()?.root).toBe(next);
  });

  test("still resolves the new target after the running version is pruned", () => {
    installVersion("2.65.0");
    const next = installVersion("2.66.0");
    pointLatestAt("2.65.0");
    const watch = plan();
    pointLatestAt("2.66.0");
    removeTreeWithRetry(join(toolRoot, "2.65.0"));
    expect(watch?.resolveTarget()?.root).toBe(next);
  });

  test("is disabled for npm's --prefix layout, which mise ownership detection does not verify", () => {
    const pkg = join(toolRoot, "2.65.0", "lib", "node_modules", "@bitkyc08", "opencodex");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), "{}");
    mkdirSync(join(toolRoot, "2.65.0", "bin"), { recursive: true });
    writeFileSync(join(toolRoot, "2.65.0", "bin", "ocx"), "", { mode: 0o755 });
    pointLatestAt("2.65.0");
    expect(plan({ launcherPath: () => join(toolRoot, "latest", "bin", "ocx") }, pkg)).toBeNull();
  });

  test("a target repointed outside the tool's installs is unresolvable", () => {
    installVersion("2.65.0");
    pointLatestAt("2.65.0");
    const watch = plan();
    const elsewhere = join(root, "elsewhere");
    installVersion("9.9.9", elsewhere);
    rmSync(join(toolRoot, "latest"));
    symlinkSync(join(elsewhere, "9.9.9"), join(toolRoot, "latest"));
    expect(watch?.resolveTarget()).toBeNull();
  });

  test.each([
    ["macOS, whose launchd services run pinned package paths", { platform: "darwin" as const }],
    ["Windows, whose services have no launcher", { platform: "win32" as const }],
    ["a proxy carrying only OCX_SERVICE=1", { env: { OCX_SERVICE: "1" } }],
    ["a foreground proxy with a service record on disk", { env: {} }],
    ["no recorded launcher", { launcherPath: () => undefined }],
    ["a non-mise install", { ownership: () => ({ installer: "npm" as const }) }],
    ["unverifiable mise ownership", { ownership: () => ({ installer: "mise" as const, owner: null, error: "metadata_inconsistent" as const }) }],
  ])("is disabled for %s", (_label, overrides) => {
    installVersion("2.65.0");
    pointLatestAt("2.65.0");
    expect(plan(overrides)).toBeNull();
  });

  test("is disabled for a mise shim, which names no package", () => {
    installVersion("2.65.0");
    pointLatestAt("2.65.0");
    const shims = join(root, "shims");
    mkdirSync(shims, { recursive: true });
    writeFileSync(join(root, "mise"), "", { mode: 0o755 });
    symlinkSync(join(root, "mise"), join(shims, "ocx"));
    expect(plan({ launcherPath: () => join(shims, "ocx") })).toBeNull();
  });

  test("is disabled for another tool's launcher", () => {
    installVersion("2.65.0");
    pointLatestAt("2.65.0");
    const other = join(root, "installs", "other");
    installVersion("1.0.0", other);
    pointLatestAt("1.0.0", other);
    expect(plan({ launcherPath: () => launcher(other) })).toBeNull();
  });

  test("is disabled when the launcher did not start this process", () => {
    installVersion("2.65.0");
    installVersion("2.66.0");
    pointLatestAt("2.66.0");
    expect(plan()).toBeNull();
  });
});

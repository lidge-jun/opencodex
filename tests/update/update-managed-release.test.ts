import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkForUpdate } from "../../src/update/job";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

test("a managed release directory shows the npm latest, no git-pull hint and no manual update", () => {
  const result = checkForUpdate("latest", {
    currentVersion: () => "2.95.0",
    detectInstall: () => "source",
    latestVersion: () => "2.96.0",
    managedReleaseDirectory: () => true,
  });
  expect(result.latestVersion).toBe("2.96.0");
  expect(result.updateAvailable).toBe(true);
  expect(result.canUpdate).toBe(false);
  expect(result.reason).toBe("managed_release");
  expect(result.command).toBe("");
});

test("a plain source checkout keeps the git pull hint", () => {
  const result = checkForUpdate("latest", {
    currentVersion: () => "2.95.0",
    detectInstall: () => "source",
    latestVersion: () => "2.96.0",
    managedReleaseDirectory: () => false,
  });
  expect(result.reason).toBe("source_checkout");
  expect(result.latestVersion).toBeNull();
});

test("a managed release with an unknown latest version stays read-only and can be rechecked", () => {
  expect(checkForUpdate("latest", {
    currentVersion: () => "2.95.0",
    detectInstall: () => "source",
    latestVersion: () => null,
    managedReleaseDirectory: () => true,
  })).toMatchObject({
    latestVersion: null, updateAvailable: false, canUpdate: false, command: "", reason: "latest_unavailable",
  });
});

test.each([
  { name: "ignores project dotenv in the Node launcher", mode: "node", args: [], inherited: undefined, dotenv: true, managed: false },
  { name: "accepts a genuine Node launcher opt-in", mode: "node", args: [], inherited: "1", dotenv: true, managed: true },
  { name: "requires the exact launcher value", mode: "node", args: [], inherited: "true", dotenv: true, managed: false },
  { name: "ignores project dotenv when Bun runs the Node launcher", mode: "bun-launcher", args: [], inherited: undefined, dotenv: true, managed: false },
  { name: "ignores an inherited marker when Bun runs the Node launcher", mode: "bun-launcher", args: [], inherited: "1", dotenv: true, managed: false },
  { name: "ignores project dotenv in direct Bun", mode: "direct", args: [], inherited: undefined, dotenv: true, managed: false },
  { name: "ignores an inherited marker in direct Bun", mode: "direct", args: [], inherited: "1", dotenv: true, managed: false },
  { name: "ignores an inherited marker in direct Bun even with dotenv off", mode: "direct", args: ["--no-env-file"], inherited: "1", dotenv: false, managed: false },
  { name: "ignores project definitions of Bun argv and env", mode: "direct", args: [], inherited: undefined, dotenv: true, managed: false, projectDefines: true },
  { name: "rejects an explicit env file even with auto-loading disabled", mode: "direct", args: ["--no-env-file", "--env-file=.env"], inherited: undefined, dotenv: true, managed: false },
  { name: "rejects the disabling flag when used as an option value", mode: "direct", args: ["--title", "--no-env-file"], inherited: undefined, dotenv: true, managed: false },
])("managed release $name", scenario => {
  const root = mkdtempSync(join(tmpdir(), "ocx-managed-release-"));
  try {
    const probe = join(root, "probe.ts");
    const url = (path: string) => JSON.stringify(pathToFileURL(repoPath(path)).href);
    writeFileSync(probe, `
      import { initializeNodeLauncherContext } from ${url("src/cli/launcher-context.ts")};
      import { managedReleaseDirectory } from ${url("src/update/managed-release.ts")};
      if (!process.argv[1].endsWith("ocx.mjs")) {
        const dotenv = process.env.OCX_TEST_MANAGED_DOTENV === "loaded";
        const projectDefines = process.execArgv[0] === "--project-define-sentinel"
          && process.env.OCX_TEST_MANAGED_DEFINE === "defined";
        initializeNodeLauncherContext();
        console.log(JSON.stringify({ dotenv, projectDefines, managed: managedReleaseDirectory(),
          markerConsumed: process.env.OCX_MANAGED_RELEASE === undefined }));
        process.exit(0);
      }
    `);
    writeFileSync(join(root, ".env"), "OCX_MANAGED_RELEASE=1\nOCX_TEST_MANAGED_DOTENV=loaded\n");
    const env: NodeJS.ProcessEnv = { ...process.env, OPENCODEX_BUN_PATH: process.execPath, OCX_NO_DESKTOP_HANDOFF: "1" };
    for (const name of Object.keys(env)) {
      if (["OCX_MANAGED_RELEASE", "OCX_NODE_LAUNCH_CONTEXT", "OCX_TEST_MANAGED_DOTENV", "OCX_TEST_MANAGED_DEFINE"].includes(name.toUpperCase())) delete env[name];
    }
    if (scenario.inherited !== undefined) env.OCX_MANAGED_RELEASE = scenario.inherited;
    const launcher = scenario.mode !== "direct";
    // The published launcher still runs its normal Node and Bun bootstrap. A project
    // preload observes the boundary before the CLI would do any service work.
    if (launcher) writeFileSync(join(root, "bunfig.toml"), 'preload = ["./probe.ts"]\n');
    if (scenario.projectDefines) writeFileSync(join(root, "bunfig.toml"), `
[define]
"process.execArgv" = '["--project-define-sentinel"]'
"process.env.OCX_TEST_MANAGED_DEFINE" = '"defined"'
`);
    const result = spawnSync(scenario.mode === "node" ? "node" : process.execPath,
      launcher ? [repoPath("bin/ocx.mjs"), "status"] : [...scenario.args, probe],
      { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      dotenv: scenario.dotenv, projectDefines: scenario.projectDefines ?? false,
      managed: scenario.managed, markerConsumed: true,
    });
  } finally {
    removeTreeWithRetry(root);
  }
}, 15_000);

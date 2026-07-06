import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const updateSource = readFileSync(join(import.meta.dir, "..", "src", "update", "index.ts"), "utf8");
const launcherSource = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");
const serverSource = readFileSync(join(import.meta.dir, "..", "src", "server", "index.ts"), "utf8");

describe("update stops the running proxy before replacing files", () => {
  test("bun/source update path gates on the pid file and spawns 'stop' before the package manager", () => {
    expect(updateSource).toContain('spawnSync(process.execPath, [process.argv[1], "stop"]');
    const stopAt = updateSource.indexOf('[process.argv[1], "stop"]');
    const updateAt = updateSource.indexOf("const { bin, args: cmdArgs } = updateCommand(installer, tag);");
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(updateAt);
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort())");
  });

  test("npm launcher update path stops via its own launcher path before npm install", () => {
    expect(launcherSource).toContain('spawnSync(process.execPath, [launcher, "stop"]');
    const stopAt = launcherSource.indexOf('[launcher, "stop"]');
    const installAt = launcherSource.indexOf('spawnSync(npm, ["install", "-g"');
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(installAt);
    expect(launcherSource).toContain('existsSync(join(configDir(), "ocx.pid"))');
    expect(launcherSource).toContain('existsSync(join(configDir(), "runtime-port.json"))');
  });

  test("both paths abort when the stop fails, and reinstall a managed service after success", () => {
    expect(updateSource).toContain("aborting the update");
    expect(updateSource).toContain('[process.argv[1], "service", "install"]');
    expect(launcherSource).toContain("aborting the update");
    expect(launcherSource).toContain('[launcher, "service", "install"]');
    expect(launcherSource).toContain('existsSync(join(configDir(), "service-state.json"))');
  });

  test("both update paths surface a skipped history restore after the stop", () => {
    // A codex-history-backup-*.json surviving `ocx stop` means the native-history restore
    // was skipped (locked state DB) — users must be told or their threads silently stay
    // hidden in the Codex app.
    expect(updateSource).toContain("export function historyRestoreIncomplete(");
    expect(updateSource).toContain('name.startsWith("codex-history-backup-") && name.endsWith(".json")');
    expect(updateSource).toContain("if (historyRestoreIncomplete())");
    expect(launcherSource).toContain("function historyRestoreIncomplete()");
    expect(launcherSource).toContain('name.startsWith("codex-history-backup-") && name.endsWith(".json")');
    expect(launcherSource).toContain("if (historyRestoreIncomplete())");
    const warnAt = launcherSource.indexOf("Codex resume history was NOT restored");
    const installAt = launcherSource.indexOf('spawnSync(npm, ["install", "-g"');
    expect(warnAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(installAt);
  });

  test("the stop gate covers service-managed and orphaned proxies whose pid file is stale/missing", () => {
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort())");
    expect(launcherSource).toContain("if (serviceWasInstalled || hasRuntimeState)");
    expect(launcherSource).toContain("stopRes.status !== 0 || stillHasRuntimeState");
  });
});

describe("/healthz identity fields", () => {
  test("healthz advertises service identity, pid, and port", () => {
    expect(serverSource).toContain('service: "opencodex"');
    expect(serverSource).toContain("pid: process.pid");
    expect(serverSource).toContain("port: listenPort");
  });
});

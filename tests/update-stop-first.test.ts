import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const updateSource = readFileSync(join(import.meta.dir, "..", "src", "update.ts"), "utf8");
const launcherSource = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");
const serverSource = readFileSync(join(import.meta.dir, "..", "src", "server.ts"), "utf8");

describe("update stops the running proxy before replacing files", () => {
  test("bun/source update path gates on the pid file and spawns 'stop' before the package manager", () => {
    expect(updateSource).toContain('spawnSync(process.execPath, [process.argv[1], "stop"]');
    const stopAt = updateSource.indexOf('[process.argv[1], "stop"]');
    const updateAt = updateSource.indexOf("const { bin, args: cmdArgs } = updateCommand(installer, tag);");
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(updateAt);
    expect(updateSource).toContain("if (readPid())");
  });

  test("npm launcher update path stops via its own launcher path before npm install", () => {
    expect(launcherSource).toContain('spawnSync(process.execPath, [launcher, "stop"]');
    const stopAt = launcherSource.indexOf('[launcher, "stop"]');
    const installAt = launcherSource.indexOf('spawnSync(npm, ["install", "-g"');
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(installAt);
    expect(launcherSource).toContain('existsSync(join(configDir(), "ocx.pid"))');
  });

  test("both paths abort when the stop fails, and reinstall a managed service after success", () => {
    expect(updateSource).toContain("aborting the update");
    expect(updateSource).toContain('[process.argv[1], "service", "install"]');
    expect(launcherSource).toContain("aborting the update");
    expect(launcherSource).toContain('[launcher, "service", "install"]');
    expect(launcherSource).toContain('existsSync(join(configDir(), "service-state.json"))');
  });
});

describe("/healthz identity fields", () => {
  test("healthz advertises service identity, pid, and port", () => {
    expect(serverSource).toContain('service: "opencodex"');
    expect(serverSource).toContain("pid: process.pid");
    expect(serverSource).toContain("port: listenPort");
  });
});

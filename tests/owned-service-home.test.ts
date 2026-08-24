import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { claimOwnedServiceHome } from "./helpers/owned-service-home";

const repoRoot = resolve(import.meta.dir, "..");

test("Windows owned-service-home fixture masks manager queries in a real child", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-owned-service-home-seam-"));
  const codexHome = join(root, "codex");
  const opencodexHome = join(root, "opencodex");
  const home = join(root, "home");
  for (const path of [codexHome, opencodexHome, home]) mkdirSync(path, { recursive: true });

  try {
    const fixture = claimOwnedServiceHome(codexHome, opencodexHome, home);
    if (process.platform !== "win32") return;

    const child = Bun.spawn([process.execPath, "--eval", `
      import { inspectServiceManagerInstallation } from "./src/service-manager-probe.ts";
      const result = inspectServiceManagerInstallation({
        platform: "win32",
        home: process.env.USERPROFILE,
        configDir: process.env.OPENCODEX_HOME,
      });
      console.log(JSON.stringify(result));
    `], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...fixture.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        OPENCODEX_HOME: opencodexHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ kind: "absent" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { claimOwnedServiceHome, withOwnedServiceHomePreload } from "./helpers/owned-service-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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

    // Copy the test preload below a path that contains spaces. Passing it as a
    // separate argv element is the regression under test; BUN_OPTIONS tokenizes
    // this same path before Bun 1.4 ever sees it.
    const spacedCheckout = join(root, "checkout with spaces");
    mkdirSync(spacedCheckout, { recursive: true });
    const spacedPreload = join(spacedCheckout, "owned-service-home-preload.ts");
    copyFileSync(join(import.meta.dir, "helpers", "owned-service-home-preload.ts"), spacedPreload);

    const child = Bun.spawn([process.execPath, ...withOwnedServiceHomePreload(["--eval", `
      import { join } from "node:path";
      import { resolveTrustedWindowsSystemDirectory } from "./src/lib/windows-elevation.ts";
      import { spawnSync } from "node:child_process";
      import { inspectServiceManagerInstallation } from "./src/service-manager-probe.ts";
      const system = resolveTrustedWindowsSystemDirectory();
      const schtasks = join(system, "schtasks.exe");
      const sc = join(system, "sc.exe");
      const text = (value: unknown) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
      const serviceProbe = (label: string, executable: string, args: string[]) => {
        const probe = spawnSync(executable, args, {
          encoding: "buffer",
          timeout: 5_000,
          windowsHide: true,
        });
        // A timeout (or any spawn failure) is a failed probe, not an absent
        // service. Keep the real pass-through result visible via status/stderr.
        if (probe.error || probe.status === null) {
          const detail = probe.error instanceof Error
            ? probe.error.message
            : String(probe.error ?? "no exit status");
          throw new Error(label + " failed: " + detail);
        }
        return probe;
      };
      const exactScheduler = serviceProbe("exact scheduler", schtasks, ["/query", "/tn", "opencodex-proxy", "/xml"]);
      const foreignScheduler = serviceProbe("foreign scheduler", schtasks, ["/query", "/tn", "foreign-opencodex-proxy", "/xml"]);
      const extraScheduler = serviceProbe("extra scheduler", schtasks, ["/query", "/tn", "opencodex-proxy", "/xml", "/extra"]);
      const exactNative = serviceProbe("exact native", sc, ["query", "opencodex-proxy-native"]);
      const extraNative = serviceProbe("extra native", sc, ["query", "opencodex-proxy-native", "extra"]);
      const result = inspectServiceManagerInstallation({
        platform: "win32",
        home: process.env.USERPROFILE,
        configDir: process.env.OPENCODEX_HOME,
      });
      console.log(JSON.stringify({
        result,
        exactScheduler: { status: exactScheduler.status, stderr: text(exactScheduler.stderr) },
        foreignScheduler: { status: foreignScheduler.status, stderr: text(foreignScheduler.stderr) },
        extraScheduler: { status: extraScheduler.status, stderr: text(extraScheduler.stderr) },
        exactNative: { status: exactNative.status, stderr: text(exactNative.stderr) },
        extraNative: { status: extraNative.status, stderr: text(extraNative.stderr) },
      }));
    `], spacedPreload)], {
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
    const payload = JSON.parse(stdout.trim()) as {
      result: { kind: string };
      exactScheduler: { status: number | undefined; stderr: string };
      foreignScheduler: { status: number | undefined; stderr: string };
      extraScheduler: { status: number | undefined; stderr: string };
      exactNative: { status: number | undefined; stderr: string };
      extraNative: { status: number | undefined; stderr: string };
    };
    expect(payload.result).toEqual({ kind: "absent" });
    expect(payload.exactScheduler.status).toBe(1);
    expect(payload.exactScheduler.stderr).toContain("OCX_TEST_SERVICE_HOME");
    expect(payload.foreignScheduler.stderr).not.toContain("OCX_TEST_SERVICE_HOME");
    expect(payload.extraScheduler.stderr).not.toContain("OCX_TEST_SERVICE_HOME");
    expect(payload.exactNative.status).toBe(1);
    expect(payload.exactNative.stderr).toContain("OCX_TEST_SERVICE_HOME");
    expect(payload.extraNative.stderr).not.toContain("OCX_TEST_SERVICE_HOME");
  } finally {
    removeTreeWithRetry(root);
  }
});

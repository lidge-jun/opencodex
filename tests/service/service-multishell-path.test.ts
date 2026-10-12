import { describe, expect, test } from "bun:test";
import { posix } from "node:path";
import { buildPlist, buildUnit, buildWindowsServiceScript, repairService, stableLauncherEntry } from "../../src/service";
import { buildWinswXml } from "../../src/lib/winsw";
import { filterTransientServicePath, isTransientServiceLauncherPath, serviceLauncherPathDiagnostic } from "../../src/service/state";

describe("shell-scoped service paths", () => {
  test("recognizes shell-local manager components without rejecting durable shims", () => {
    for (const manager of ["fnm", "nvm", "mise", "asdf", "volta"]) {
      expect(isTransientServiceLauncherPath(`/tmp/${manager}_multishells/123/bin/ocx`, "linux")).toBe(true);
      expect(isTransientServiceLauncherPath(`C:\\Temp\\${manager}_multishells\\123\\ocx.cmd`, "win32")).toBe(true);
    }
    expect(isTransientServiceLauncherPath("/opt/fnm_multishells-backup/bin/ocx", "linux")).toBe(false);
    expect(isTransientServiceLauncherPath("/home/user/.local/share/mise/shims/ocx", "linux")).toBe(false);
    expect(filterTransientServicePath("/usr/bin:/tmp/nvm_multishells/1/bin:/opt/bin", ":", "linux"))
      .toBe("/usr/bin:/opt/bin");
  });

  test("skips a recorded fnm launcher and removes its directory from systemd PATH", () => {
    // A systemd unit is POSIX on every host, so the fixture is too: on a Windows runner the
    // host path module and delimiter would produce "\\opt\\..." paths and ";"-joined PATHs.
    const temporaryBin = posix.join("/tmp", "fnm_multishells", "shell-1", "bin");
    const durableBin = "/opt/opencodex/bin";
    const temporaryLauncher = posix.join(temporaryBin, "ocx");
    const durableLauncher = posix.join(durableBin, "ocx");
    const launcher = stableLauncherEntry({
      state: { launcherPath: temporaryLauncher } as never,
      env: { PATH: [temporaryBin, durableBin].join(":") },
      pathDelimiter: ":",
      platform: "linux",
      isExecutableFile: candidate => candidate === temporaryLauncher || candidate === durableLauncher,
    });
    expect(launcher).toBe(durableLauncher);

    const oldPath = process.env.PATH;
    try {
      process.env.PATH = [temporaryBin, durableBin].join(":");
      const unit = buildUnit([], { launcher, runtime: { path: "/opt/opencodex/bun", source: "bundled", overrideEnv: "OPENCODEX_BUN_PATH" } });
      expect(unit).not.toContain("fnm_multishells");
      expect(unit).toContain(durableLauncher);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  test("falls back to the package-local Bun when every launcher is temporary", () => {
    const temporaryBin = "/tmp/mise_multishells/1/bin";
    const launcher = stableLauncherEntry({
      state: { launcherPath: `${temporaryBin}/ocx` } as never,
      env: { PATH: temporaryBin },
      isExecutableFile: () => true,
    });
    expect(launcher).toBeNull();
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = temporaryBin;
      const unit = buildUnit([], { launcher, runtime: { path: "/opt/opencodex/bun", source: "bundled", overrideEnv: "OPENCODEX_BUN_PATH" } });
      expect(unit).toContain("exec '/opt/opencodex/bun'");
      expect(unit).not.toContain("mise_multishells");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  test("filters Windows PATH using semicolons while preserving other environment", () => {
    const oldPath = process.env.PATH;
    const oldProxy = process.env.HTTPS_PROXY;
    try {
      process.env.PATH = "C:\\Windows\\System32;C:\\Temp\\volta_multishells\\1\\bin;C:\\OpenCodex\\bin";
      process.env.HTTPS_PROXY = "http://proxy.example:8080";
      const script = buildWindowsServiceScript(
        { bun: "C:\\OpenCodex\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\OpenCodex\\cli.ts" },
        10100,
        [{ name: "HTTPS_PROXY", value: process.env.HTTPS_PROXY }],
      );
      expect(script).not.toContain("volta_multishells");
      expect(script).toContain("C:\\Windows\\System32;C:\\OpenCodex\\bin");
      expect(script).toContain('set "HTTPS_PROXY=http://proxy.example:8080"');
      expect(script).toContain('set "OCX_BUN_RUNTIME_SOURCE=bundled"');
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = oldProxy;
    }
  });

  test("filters shell-local Windows PATH from native WinSW XML", () => {
    const xml = buildWinswXml(
      { bun: "C:\\OpenCodex\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\OpenCodex\\cli.ts" },
      {
        PATH: "C:\\Windows\\System32;C:\\Temp\\VOLTA_multishells\\1\\bin;C:\\Tools & More\\bin",
        USERNAME: "operator",
      },
    );
    expect(xml).not.toContain("VOLTA_multishells");
    expect(xml).toContain('<env name="PATH" value="C:\\Windows\\System32;C:\\Tools &amp; More\\bin"/>');
    expect(xml).toContain('<env name="OCX_BUN_RUNTIME_SOURCE" value="bundled"/>');
  });

  test("launchd renders a cleaned PATH with bundled Bun and proxy settings intact", () => {
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = "/tmp/asdf_multishells/1/bin:/usr/bin";
      const plist = buildPlist(
        [{ name: "HTTPS_PROXY", value: "http://proxy.example:8080" }],
        { runtime: { path: "/opt/opencodex/bun", source: "bundled", overrideEnv: "OPENCODEX_BUN_PATH" } },
      );
      expect(plist).not.toContain("asdf_multishells");
      expect(plist).toContain("<key>PATH</key><string>/usr/bin</string>");
      expect(plist).toContain("<key>OCX_BUN_RUNTIME_PATH</key><string>/opt/opencodex/bun</string>");
      expect(plist).toContain("<key>HTTPS_PROXY</key><string>http://proxy.example:8080</string>");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  test("repair diagnostic does not tell an in-progress repair to run again", () => {
    const state = { launcherPath: "/tmp/fnm_multishells/1/bin/ocx" } as never;
    expect(serviceLauncherPathDiagnostic(state, "linux")).toContain("ocx service repair");
    const message = serviceLauncherPathDiagnostic(state, "linux", true);
    expect(message).toContain("replacing");
    expect(message).not.toContain("ocx service repair");
  });

  test("repair prints the temporary-launcher diagnosis while replacing the service", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    let repaired = false;
    console.warn = (...parts: unknown[]) => warnings.push(parts.join(" "));
    try {
      await repairService({
        platform: "linux",
        diagnose: () => ({ supported: true, installed: true, enabled: true, running: false,
          viable: false, startable: true, stale: true, conflict: false, backend: "systemd", summary: "stale" }),
        launcherPathDiagnostic: () => serviceLauncherPathDiagnostic({ launcherPath: "/tmp/fnm_multishells/1/bin/ocx" } as never, "linux", true),
        readOwnership: () => ({ kind: "none", revision: 1 }),
        assertEnv: () => {},
        assertAuth: () => {},
        repairSystemd: () => { repaired = true; },
      });
      expect(repaired).toBe(true);
      expect(warnings.join("\n")).toContain("fnm_multishells");
      expect(warnings.join("\n")).not.toContain("ocx service repair");
    } finally {
      console.warn = originalWarn;
    }
  });
});

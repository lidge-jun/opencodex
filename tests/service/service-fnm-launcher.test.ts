import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  bakedServicePathsDiagnostic,
  buildUnit,
  buildWindowsServiceScript,
  repairService,
  stableLauncherEntry,
} from "../../src/service";

const TEST_DIR = join(import.meta.dir, ".tmp-fnm-launcher-test");

function installState(launcherPath: string): Record<string, unknown> {
  return {
    version: 2,
    codexHome: join(TEST_DIR, ".codex"),
    opencodexHome: TEST_DIR,
    backend: "scheduler",
    revision: 1,
    launcherPath,
  };
}

describe("fnm service launcher paths", () => {
  test("does not bake a shell-local multishell path into systemd", () => {
    const multishellBin = join(TEST_DIR, "fnm_multishells", "1912953_1790129291989", "bin");
    const stableBin = join(TEST_DIR, "stable-bin");
    const temporaryLauncher = join(multishellBin, "ocx");
    const stableLauncher = join(stableBin, "ocx");
    const launcher = stableLauncherEntry({
      state: installState(temporaryLauncher) as never,
      env: { PATH: [multishellBin, stableBin].join(delimiter) },
      isExecutableFile: candidate => candidate === temporaryLauncher || candidate === stableLauncher,
    });

    expect(launcher).toBe(stableLauncher);

    const previousPath = process.env.PATH;
    process.env.PATH = [multishellBin, stableBin].join(delimiter);
    try {
      const unit = buildUnit([], {
        launcher,
        runtime: {
          path: "/opt/opencodex/bun",
          source: "bundled",
          overrideEnv: "OPENCODEX_BUN_PATH",
        },
      });
      expect(unit).not.toContain("fnm_multishells");
      expect(unit).toContain(stableLauncher.replaceAll("\\", "\\\\"));

      const directLauncher = stableLauncherEntry({
        state: installState(temporaryLauncher) as never,
        env: { PATH: multishellBin },
        isExecutableFile: candidate => candidate === temporaryLauncher,
      });
      expect(directLauncher).toBeNull();
      const directUnit = buildUnit([], {
        launcher: directLauncher,
        runtime: {
          path: "/opt/opencodex/bun",
          source: "bundled",
          overrideEnv: "OPENCODEX_BUN_PATH",
        },
      });
      expect(directUnit).toContain("exec '/opt/opencodex/bun'");
      expect(directUnit).not.toContain("fnm_multishells");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test.skipIf(process.platform !== "win32")("Windows service scripts filter fnm PATH entries", () => {
    const oldPath = process.env.PATH;
    const oldLocalAppData = process.env.LOCALAPPDATA;
    const localAppData = "C:\\Users\\Andrew\\AppData\\Local";
    try {
      process.env.LOCALAPPDATA = localAppData;
      process.env.PATH = [
        "C:\\Windows\\System32",
        `${localAppData}\\fnm_multishells\\36956_1790318511513`,
        "C:\\OpenCodex\\bin",
      ].join(";");
      const script = buildWindowsServiceScript(
        { bun: "C:\\OpenCodex\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\OpenCodex\\cli.ts" },
        10100,
        [],
      );
      expect(script).toContain('set "PATH=C:\\Windows\\System32;C:\\OpenCodex\\bin"');
      expect(script).not.toContain("fnm_multishells");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = oldLocalAppData;
    }
  });

  test("reports an already-recorded multishell launcher instead of generic no-answer text", () => {
    const temporaryLauncher = join(TEST_DIR, "fnm_multishells", "1912953_1790129291989", "bin", "ocx");
    const diagnostic = bakedServicePathsDiagnostic(process.platform, installState(temporaryLauncher) as never);
    expect(diagnostic).toContain("fnm_multishells");
    expect(diagnostic).toContain("temporary");
    expect(diagnostic).toContain("ocx service repair");
  });

  test("service repair names the temporary launcher before replacing it", async () => {
    const temporaryLauncher = join(TEST_DIR, "fnm_multishells", "1912953_1790129291989", "bin", "ocx");
    const staleDiagnostic = bakedServicePathsDiagnostic("linux", installState(temporaryLauncher) as never);
    const warnings: string[] = [];
    const previousWarn = console.warn;
    const repaired: string[] = [];
    console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
    try {
      await repairService({
        platform: "linux",
        diagnose: () => ({
          supported: true,
          installed: true,
          enabled: true,
          running: false,
          viable: false,
          startable: true,
          stale: true,
          conflict: false,
          backend: "systemd",
          summary: "installed, but stale",
        }),
        bakedPathsDiagnostic: () => staleDiagnostic,
        readOwnership: () => ({ kind: "none", revision: 1 }),
        assertEnv: () => {},
        assertAuth: () => {},
        repairSystemd: () => { repaired.push("systemd"); },
      });
    } finally {
      console.warn = previousWarn;
    }

    expect(repaired).toEqual(["systemd"]);
    expect(warnings.join("\n")).toContain("fnm_multishells");
    expect(warnings.join("\n")).toContain("direct Bun");
  });
});

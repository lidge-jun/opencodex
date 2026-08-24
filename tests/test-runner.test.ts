import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createIsolatedTestEnvironment, resolveBunTestArgs } from "../scripts/test";
import {
  decodeWindowsIdentityPowerShellOutputForTests,
  windowsIdentityPowerShellCommandForTests,
  windowsIdentityPowerShellSpawnOptionsForTests,
} from "../src/codex/user-identity";

describe("test runner isolation", () => {
  test("redirects user homes to a disposable root", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "/test/bin", HOME: "/real/home" });
    try {
      expect(isolated.env).toMatchObject({
        PATH: "/test/bin",
        HOME: isolated.root,
        USERPROFILE: isolated.root,
        OPENCODEX_HOME: join(isolated.root, ".opencodex"),
        CODEX_HOME: join(isolated.root, ".codex"),
      });
      expect(existsSync(isolated.env.OPENCODEX_HOME!)).toBe(true);
      expect(existsSync(isolated.env.CODEX_HOME!)).toBe(true);
    } finally {
      isolated.cleanup();
    }
    expect(existsSync(isolated.root)).toBe(false);
  });

  test.if(process.platform === "win32")("gives the Windows sandbox a real profile shape", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "C:\\test\\bin" });
    try {
      expect(existsSync(join(isolated.root, "AppData", "Local"))).toBe(true);
      expect(existsSync(join(isolated.root, "AppData", "Roaming"))).toBe(true);
    } finally {
      isolated.cleanup();
    }
  });

  // The bug this pins: .NET's known-folder API resolves against USERPROFILE and returns an
  // EMPTY STRING — not an error — for a folder that does not exist. With the sandbox missing
  // AppData, `resolveWindowsRuntimeRoot` refused every Codex coordinator lookup with "Windows
  // effective-account lookup returned an empty value", and each refusal surfaced as an
  // unrelated assertion in whichever suite touched a Codex home.
  test.if(process.platform === "win32")(
    "keeps the .NET known-folder lookup resolvable inside the sandbox",
    () => {
      const isolated = createIsolatedTestEnvironment();
      try {
        const command = windowsIdentityPowerShellCommandForTests(
          "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
        );
        const result = Bun.spawnSync(command, {
          ...windowsIdentityPowerShellSpawnOptionsForTests(),
          env: { ...process.env, USERPROFILE: isolated.root, HOME: isolated.root },
        });

        expect(result.exitCode).toBe(0);
        const localAppData = decodeWindowsIdentityPowerShellOutputForTests(
          result.stdout ?? new Uint8Array(),
        );
        expect(localAppData).not.toBe("");
        expect(isAbsolute(localAppData)).toBe(true);
        expect(localAppData.toLowerCase()).toStartWith(isolated.root.toLowerCase());
      } finally {
        isolated.cleanup();
      }
    },
  );
});

/**
 * Without `--parallel`, `--isolate` re-evaluates the module graph once per file on a single
 * core. Past ~900 files that stops reading as slow and starts reading as hung: measured at
 * 1 h 29 m with zero output, ~57 % CPU and 8.5 MB RSS. Four workers keep the suite inside a
 * few minutes without the deadline-sensitive failures observed when Bun selected all ten cores.
 * These pin the argv so the bound cannot be dropped again silently.
 */
describe("bun test argv", () => {
  test("a filter-less run gets isolate, bounded parallelism and the suite path", () => {
    expect(resolveBunTestArgs([])).toEqual(["--isolate", "--parallel=4", "./tests/"]);
  });

  test("a file filter keeps isolate and bounded parallelism but no suite path", () => {
    expect(resolveBunTestArgs(["tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=4", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["-"]))
      .toEqual(["--isolate", "--parallel=4", "-"]);
  });

  test("a caller-supplied concurrency is left alone", () => {
    expect(resolveBunTestArgs(["--parallel=2"]))
      .toEqual(["--isolate", "--parallel=2", "./tests/"]);
    expect(resolveBunTestArgs(["--parallel"]))
      .toEqual(["--isolate", "--parallel", "./tests/"]);
    expect(resolveBunTestArgs(["--parallel", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["--parallel=2", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=2", "tests/foo.test.ts"]);
  });

  test("option-only arguments still count as a full suite run", () => {
    expect(resolveBunTestArgs(["--timeout=30000"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout=30000", "./tests/"]);
    expect(resolveBunTestArgs(["--timeout", "30000"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout", "30000", "./tests/"]);
    expect(resolveBunTestArgs(["--timeout", "30000", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout", "30000", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["--timings", ".bun-test-timings/current.json"]))
      .toEqual([
        "--isolate",
        "--parallel=4",
        "--timings",
        ".bun-test-timings/current.json",
        "./tests/",
      ]);
    for (const configFlag of ["-c", "--config"]) {
      expect(resolveBunTestArgs([configFlag, "ci.bunfig.toml"]))
        .toEqual(["--isolate", "--parallel=4", configFlag, "ci.bunfig.toml", "./tests/"]);
    }
    expect(resolveBunTestArgs(["-t", "serial test"])).toEqual([
      "--isolate",
      "--parallel=4",
      "-t",
      "serial test",
      "./tests/",
    ]);
  });

  test("arguments after the delimiter are passed through instead of parsed as wrapper flags", () => {
    expect(resolveBunTestArgs(["--", "--parallel=2"]))
      .toEqual(["--isolate", "--parallel=4", "--", "--parallel=2"]);
  });

  test("the wrapper passes parallel execution through to bun", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "opencodex-test-runner-"));
    const fixturePath = join(fixtureRoot, "parallel-smoke.test.ts");
    const markerPath = join(fixtureRoot, "executed.marker");
    writeFileSync(
      fixturePath,
      `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("smoke", () => writeFileSync(${JSON.stringify(markerPath)}, "executed"));\n`,
    );
    try {
      const result = Bun.spawnSync([
        process.execPath,
        join(import.meta.dir, "../scripts/test.ts"),
        fixturePath,
      ], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, OCX_TEST_NO_QUEUE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = new TextDecoder().decode(result.stdout)
        + new TextDecoder().decode(result.stderr);
      expect(result.exitCode).toBe(0);
      expect(output).toContain("PARALLEL");
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

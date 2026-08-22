import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createIsolatedTestEnvironment, shouldRunCompanionTests } from "../scripts/test";
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

describe("test runner companion gating", () => {
  test("shouldRunCompanionTests is true only for the default full suite", () => {
    expect(shouldRunCompanionTests([])).toBe(true);
    expect(shouldRunCompanionTests(["tests/example.test.ts"])).toBe(false);
    expect(shouldRunCompanionTests(["tests/a.test.ts", "tests/b.test.ts"])).toBe(false);
  });

  test("file-scoped wrapper invocation does not run the replit-gateway companion", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "scripts/test.ts",
        "tests/test-runner.test.ts",
        "--test-name-pattern",
        "redirects user homes to a disposable root",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, OCX_TEST_NO_QUEUE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = [
      new TextDecoder().decode(result.stdout),
      new TextDecoder().decode(result.stderr),
    ].join("\n");
    expect(result.exitCode).toBe(0);
    expect(output).not.toContain("replit-gateway companion");
    expect(output).not.toContain("integrations/replit-gateway");
  });
});

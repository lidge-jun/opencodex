import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { acquireTestRunLock, collectTestFiles, createIsolatedTestEnvironment, partitionTestFiles } from "../scripts/test";
import {
  decodeWindowsIdentityPowerShellOutputForTests,
  windowsIdentityPowerShellCommandForTests,
  windowsIdentityPowerShellSpawnOptionsForTests,
} from "../src/codex/user-identity";

describe("test runner isolation", () => {
  test("discovers supported test names deterministically and ignores unrelated files", () => {
    const root = mkdtempSync(join(process.platform === "win32" ? process.env.TEMP! : "/tmp", "opencodex-test-discovery-"));
    try {
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "z.test.ts"), "");
      writeFileSync(join(root, "nested", "a_spec.tsx"), "");
      writeFileSync(join(root, "nested", "notes.ts"), "");
      expect(collectTestFiles(root).map(path => path.slice(path.indexOf(root.split(/[\\/]/).at(-1)!)))).toEqual([
        `${root.split(/[\\/]/).at(-1)}/nested/a_spec.tsx`,
        `${root.split(/[\\/]/).at(-1)}/z.test.ts`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("partitions every file once and rejects unsafe batch sizes", () => {
    expect(partitionTestFiles(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(() => partitionTestFiles(["a"], 0)).toThrow("positive integer");
  });

  test("serializes simultaneous full-suite owners with an atomic lock", async () => {
    const root = mkdtempSync(join(process.platform === "win32" ? process.env.TEMP! : "/tmp", "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const releaseFirst = await acquireTestRunLock(lockPath, { pollMs: 5, maxWaitMs: 1_000 });
      let secondResolved = false;
      const second = acquireTestRunLock(lockPath, { pollMs: 5, maxWaitMs: 1_000 }).then(release => {
        secondResolved = true;
        return release;
      });
      await Bun.sleep(20);
      expect(secondResolved).toBe(false);
      releaseFirst();
      const releaseSecond = await second;
      expect(secondResolved).toBe(true);
      releaseSecond();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

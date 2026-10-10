import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCodeAfterTempSweep, settleIsolatedTestRoot } from "../../scripts/test";
import { removeTestTempTree } from "../../scripts/test-temp";
import {
  describeLockedTemp,
  omitProbeProcess,
  quarantineFinalEperm,
  type LockedTempChild,
  type LockedTempDiagnostic,
} from "../../scripts/test-temp-lock";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function eperm(): Error {
  return Object.assign(new Error("EPERM"), { code: "EPERM" });
}

function containedFixture(): { root: string; runTmp: string; locked: string; env: Record<string, string> } {
  const wrapped = join(tmpdir(), "opencodex-test-Aa11Bb");
  rmSync(wrapped, { recursive: true, force: true });
  const runTmp = join(wrapped, "tmp");
  const locked = join(runTmp, "ocx-management-auth-held");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "token"), "not-a-secret\n");
  roots.push(wrapped);
  return {
    root: wrapped,
    runTmp: realpathSync(runTmp),
    locked: realpathSync(locked),
    env: { TEMP: runTmp, TMP: runTmp, TMPDIR: runTmp },
  };
}

function diagnostic(overrides: Partial<LockedTempDiagnostic> = {}): LockedTempDiagnostic & { warnings: string[] } {
  const warnings: string[] = [];
  const base: LockedTempDiagnostic = {
    platform: "win32",
    realpath: realpathSync,
    readDir: () => [],
    isDirectory: () => false,
    probeRename: () => "",
    spawn: () => ({ stdout: "acl", stderr: "", timedOut: false }),
    children: () => [],
    warn: line => { warnings.push(line); },
    trashName: () => ".trash-fixed",
    rename: (from, to) => { mkdirSync(to, { recursive: true }); rmSync(from, { recursive: true, force: true }); },
  };
  return { ...base, ...overrides, warnings, warn: line => { warnings.push(line); } };
}

describe("final EPERM quarantine", () => {
  test("retries, then moves a childless contained tree aside instead of raising the budget", () => {
    const fixture = containedFixture();
    const seen = diagnostic({
      rename: (from, to) => {
        expect(from).toBe(fixture.locked);
        expect(to).toBe(join(fixture.runTmp, ".trash-fixed"));
        mkdirSync(to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
      },
    });
    let attempts = 0;
    removeTestTempTree(fixture.locked, {
      delays: [1],
      sleep: () => {},
      remove: () => { attempts += 1; throw eperm(); },
      lockDiagnostic: seen,
      lockEnv: fixture.env,
    });
    expect(attempts).toBe(2);
    expect(seen.warnings.some(line => line.includes("final EPERM"))).toBe(true);
    expect(seen.warnings.some(line => line.includes(".trash-fixed"))).toBe(true);
    expect(readdirSync(fixture.runTmp)).toContain(".trash-fixed");
  });

  test("an earlier EPERM does not diagnose or move", () => {
    const fixture = containedFixture();
    const seen = diagnostic();
    let attempts = 0;
    removeTestTempTree(fixture.locked, {
      delays: [1],
      sleep: () => {},
      remove: () => {
        attempts += 1;
        if (attempts === 1) throw eperm();
      },
      lockDiagnostic: seen,
      lockEnv: fixture.env,
    });
    expect(attempts).toBe(2);
    expect(seen.warnings).toEqual([]);
  });

  test("the child probe does not count itself as the lock holder", () => {
    const probe: LockedTempChild = { pid: 5144, parentPid: 2, name: "powershell.exe", referencesTarget: false };
    const holder: LockedTempChild = { pid: 9, parentPid: 2, name: "icacls.exe", referencesTarget: true };
    expect(omitProbeProcess([probe], probe.pid)).toEqual([]);
    expect(omitProbeProcess([probe, holder], probe.pid)).toEqual([holder]);
  });

  test("a live child keeps the original error", () => {
    const fixture = containedFixture();
    const child: LockedTempChild = { pid: 4, parentPid: 2, name: "icacls.exe", referencesTarget: true };
    const seen = diagnostic({ children: () => [child] });
    expect(quarantineFinalEperm(fixture.locked, eperm(), seen, fixture.env)).toBe(false);
    expect(() => removeTestTempTree(fixture.locked, {
      delays: [],
      remove: () => { throw eperm(); },
      lockDiagnostic: seen,
      lockEnv: fixture.env,
    })).toThrow("EPERM");
    expect(seen.warnings.some(line => line.includes("child process is still alive") && line.includes("references-temp"))).toBe(true);
    expect(readdirSync(fixture.runTmp)).toContain("ocx-management-auth-held");
  });

  test("a failed child probe, a non-EPERM, and a path outside the contained temp are not moved", () => {
    const fixture = containedFixture();
    const unresolved = diagnostic({ children: () => undefined });
    expect(quarantineFinalEperm(fixture.locked, eperm(), unresolved, fixture.env)).toBe(false);
    expect(unresolved.warnings.some(line => line.includes("did not complete"))).toBe(true);

    const busy = diagnostic();
    expect(quarantineFinalEperm(fixture.locked, Object.assign(new Error("busy"), { code: "EBUSY" }), busy, fixture.env)).toBe(false);
    expect(busy.warnings).toEqual([]);

    const outside = diagnostic();
    const host = mkdtempSync(join(tmpdir(), "ocx-outside-"));
    roots.push(host);
    expect(quarantineFinalEperm(host, eperm(), outside, fixture.env)).toBe(false);
    expect(outside.warnings.some(line => line.includes("not a contained temp subtree"))).toBe(true);
  });

  test("a rename that fails leaves the EPERM in place", () => {
    const fixture = containedFixture();
    const seen = diagnostic({
      rename: () => { throw Object.assign(new Error("sharing"), { code: "EPERM" }); },
    });
    expect(quarantineFinalEperm(fixture.locked, eperm(), seen, fixture.env)).toBe(false);
    expect(seen.warnings.some(line => line.includes("could not move"))).toBe(true);
    expect(readdirSync(fixture.runTmp)).toContain("ocx-management-auth-held");
  });

  test("the diagnostic lists a locked file and the acl tools without a command line", () => {
    const text = describeLockedTemp("/tmp/held", {
      ...diagnostic(),
      readDir: () => ["kept.txt"],
      isDirectory: () => false,
      probeRename: () => "EPERM",
      spawn: command => ({ stdout: command[0] === "icacls" ? "BUILTIN\\Users:(F)" : "A    kept.txt", stderr: "", timedOut: false }),
    });
    expect(text).toContain(`file ${join("/tmp/held", "kept.txt")} rename:EPERM`);
    expect(text).toContain("icacls");
    expect(text).toContain("attrib");
    expect(text).not.toContain("CommandLine");
  });
});

describe("end-of-run sweep", () => {
  test("a surviving quarantine fails a green lane and a plain root stays deferred", () => {
    expect(exitCodeAfterTempSweep(0, "quarantine-remains")).toBe(1);
    expect(exitCodeAfterTempSweep(0, "removed")).toBe(0);
    expect(exitCodeAfterTempSweep(0, "deferred")).toBe(0);
    expect(exitCodeAfterTempSweep(124, "quarantine-remains")).toBe(124);

    const root = mkdtempSync(join(tmpdir(), "opencodex-sweep-"));
    roots.push(root);
    mkdirSync(join(root, "tmp", ".trash-left"), { recursive: true });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(settleIsolatedTestRoot(root, () => { throw eperm(); })).toBe("quarantine-remains");
      rmSync(join(root, "tmp", ".trash-left"), { recursive: true, force: true });
      expect(settleIsolatedTestRoot(root, () => { throw eperm(); })).toBe("deferred");
      expect(settleIsolatedTestRoot(root, () => {})).toBe("removed");
    } finally {
      errors.mockRestore();
    }
  });
});

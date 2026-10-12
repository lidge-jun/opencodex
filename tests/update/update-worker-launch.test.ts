import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guiUpdateWorkerCommand, isTrustedSystemdRunFile, resolveSystemdRun, resetSystemdRunProbeForTests,
  resolveSystemdRunAsync, SYSTEMD_SCOPE_ARGS,
} from "../../src/update/worker-launch";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #5750: a worker spawned by the systemd user service must leave the service cgroup before the
// updater stops that service, or systemd kills it along with the proxy.
describe("dashboard update worker launch", () => {
  const args = ["/opt/ocx/src/cli/index.ts", "__gui-update-worker", "job-1", "stable", "restart"];

  test("a systemd-started Linux proxy launches the worker in its own scope", () => {
    const launch = guiUpdateWorkerCommand("/usr/bin/bun", args, {
      platform: "linux", env: { INVOCATION_ID: "abc", PATH: "/tmp/attacker:/usr/bin" },
      resolveSystemdRun: () => "/usr/bin/systemd-run",
    });
    expect(launch).toEqual({
      command: "/usr/bin/systemd-run", argv: [...SYSTEMD_SCOPE_ARGS, "/usr/bin/bun", ...args],
    });
  });

  test("without systemd-run, outside systemd, or off Linux the spawn is unchanged", () => {
    const plain = { command: "/usr/bin/bun", argv: args };
    expect(guiUpdateWorkerCommand("/usr/bin/bun", args, {
      platform: "linux", env: { INVOCATION_ID: "abc" }, resolveSystemdRun: () => undefined,
    })).toEqual(plain);
    let probed = false;
    expect(guiUpdateWorkerCommand("/usr/bin/bun", args, {
      platform: "linux", env: {}, resolveSystemdRun: () => { probed = true; return "/usr/bin/systemd-run"; },
    })).toEqual(plain);
    expect(probed).toBe(false);
    expect(guiUpdateWorkerCommand("/usr/bin/bun", args, {
      platform: "darwin", env: { INVOCATION_ID: "abc" }, resolveSystemdRun: () => "/usr/bin/systemd-run",
    })).toEqual(plain);
  });
});

// The real resolver — not the context seam — must be the thing under test: PATH must stay
// unconsulted, only the trusted absolute candidates may be probed, and a failed probe must
// fall through rather than settle for the plain in-cgroup spawn.
describe("trusted systemd-run discovery", () => {
  test("walks only the trusted candidates and ignores PATH", () => {
    resetSystemdRunProbeForTests();
    const seen: string[] = [];
    const found = resolveSystemdRun({
      isExecutableFile: path => { seen.push(path); return path === "/run/current-system/sw/bin/systemd-run"; },
      probeScope: () => true,
    });
    expect(found).toBe("/run/current-system/sw/bin/systemd-run");
    expect(seen).toEqual([
      "/usr/bin/systemd-run", "/bin/systemd-run", "/usr/local/bin/systemd-run",
      "/run/current-system/sw/bin/systemd-run",
    ]);
    expect(seen.every(path => path.startsWith("/"))).toBe(true);
  });

  test("a failed scope probe falls through to the next candidate", () => {
    resetSystemdRunProbeForTests();
    const found = resolveSystemdRun({
      isExecutableFile: () => true,
      probeScope: path => path !== "/usr/bin/systemd-run",
    });
    expect(found).toBe("/bin/systemd-run");
  });

  test("the probe is cached and reports undefined when nothing qualifies", () => {
    resetSystemdRunProbeForTests();
    let calls = 0;
    const hooks = {
      isExecutableFile: () => { calls++; return false; },
      probeScope: () => { throw new Error("must not run"); },
    };
    expect(resolveSystemdRun(hooks)).toBeUndefined();
    expect(resolveSystemdRun(hooks)).toBeUndefined();
    expect(calls).toBe(4);
    resetSystemdRunProbeForTests();
  });

  test("resolveSystemdRunAsync shares one probe pass across concurrent first callers", async () => {
    resetSystemdRunProbeForTests();
    let probes = 0;
    const hooks = {
      isExecutableFile: () => true,
      probeScope: () => { throw new Error("sync probe must not run on the request path"); },
      probeScopeAsync: async (path: string) => {
        probes++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return path === "/bin/systemd-run";
      },
    };
    const [first, second, third] = await Promise.all([
      resolveSystemdRunAsync(hooks),
      resolveSystemdRunAsync(hooks),
      resolveSystemdRunAsync(hooks),
    ]);
    expect(first).toBe("/bin/systemd-run");
    expect(second).toBe("/bin/systemd-run");
    expect(third).toBe("/bin/systemd-run");
    expect(probes).toBe(2);
    // The resolved value is now cached: the sync resolver agrees without probing again.
    expect(resolveSystemdRun(hooks)).toBe("/bin/systemd-run");
    expect(probes).toBe(2);
    resetSystemdRunProbeForTests();
  });
});

// The default trust check must run against the real filesystem, not a stubbed seam. uid/mode
// semantics are POSIX-only — on Windows statSync reports uid 0 and chmod is a no-op — and only
// a root-run suite can create a uid-0 fixture, so each case is gated on what the test user can
// actually arrange.
describe("isTrustedSystemdRunFile (real filesystem)", () => {
  const posix = process.platform !== "win32";
  const itPosix = posix ? test : test.skip;
  const getuid = (process as { getuid?: () => number }).getuid?.bind(process);
  const itNonRoot = posix && getuid?.() !== 0 ? test : test.skip;
  const itRoot = posix && getuid?.() === 0 ? test : test.skip;

  function fixture(): { dir: string; file: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "ocx-systemd-run-trust-"));
    const file = join(dir, "systemd-run");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    return { dir, file, cleanup: () => removeTreeWithRetry(dir) };
  }

  itNonRoot("rejects an executable owned by the test user rather than root", () => {
    const { file, cleanup } = fixture();
    try { expect(isTrustedSystemdRunFile(file)).toBe(false); } finally { cleanup(); }
  });

  itNonRoot("rejects non-executable and missing paths", () => {
    const { dir, file, cleanup } = fixture();
    try {
      chmodSync(file, 0o644);
      expect(isTrustedSystemdRunFile(file)).toBe(false);
      expect(isTrustedSystemdRunFile(join(dir, "absent"))).toBe(false);
      expect(isTrustedSystemdRunFile(dir)).toBe(false);
    } finally { cleanup(); }
  });

  itRoot("rejects a root-owned file inside a group/world-writable directory", () => {
    const { dir, file, cleanup } = fixture();
    try {
      chmodSync(dir, 0o777);
      expect(isTrustedSystemdRunFile(file)).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
      cleanup();
    }
  });

  itRoot("accepts a root-owned executable in a root-only-writable directory", () => {
    const { dir, file, cleanup } = fixture();
    try {
      chmodSync(dir, 0o755);
      expect(isTrustedSystemdRunFile(file)).toBe(true);
    } finally { cleanup(); }
  });
});

/*
 * A trusted-path symlink is only as strong as the file it resolves to and the
 * directories able to substitute that file. The link's own parent being
 * root-only is not enough — these run against stub seams so the substitution
 * chain is exercised without needing a uid-0 fixture on disk.
 */
describe("isTrustedSystemdRunFile (resolved substitution chain)", () => {
  const fileStat = (mode: number, uid = 0) => ({ isFile: () => true, isDirectory: () => false, uid, mode });
  const dirStat = (mode: number, uid = 0) => ({ isFile: () => false, isDirectory: () => true, uid, mode });
  const trustedDeps = {
    accessSync: () => {},
    statSync: (path: string) => dirStat(0o755),
    realpathSync: (path: string) => path,
  };

  test("rejects a trusted-dir symlink whose resolved target can be substituted", () => {
    // /usr/bin/systemd-run -> /home/user/bin/systemd-run: the file itself is
    // root-owned and mode-pinned, but /home/user/bin is user-writable, so the
    // user can replace it outright.
    const deps = {
      ...trustedDeps,
      realpathSync: () => "/home/user/bin/systemd-run",
      statSync: (path: string) =>
        path === "/home/user/bin/systemd-run" ? fileStat(0o755)
          : path === "/home/user/bin" ? dirStat(0o775)
          : dirStat(0o755),
    };
    expect(isTrustedSystemdRunFile("/usr/bin/systemd-run", deps)).toBe(false);
  });

  test("rejects when any resolved ancestor can be substituted, not just the parent", () => {
    // Target dir is pinned, but /opt/vendor is world-writable: swapping
    // /opt/vendor/tools there substitutes the binary below it.
    const deps = {
      ...trustedDeps,
      realpathSync: () => "/opt/vendor/tools/systemd-run",
      statSync: (path: string) =>
        path === "/opt/vendor/tools/systemd-run" ? fileStat(0o755)
          : path === "/opt/vendor" ? dirStat(0o777)
          : dirStat(0o755),
    };
    expect(isTrustedSystemdRunFile("/usr/bin/systemd-run", deps)).toBe(false);
  });

  test("accepts a resolved chain that is root-owned and pinned end to end", () => {
    const deps = {
      ...trustedDeps,
      realpathSync: () => "/usr/lib/systemd/systemd-run",
      statSync: (path: string) =>
        path === "/usr/lib/systemd/systemd-run" ? fileStat(0o755) : dirStat(0o755),
    };
    expect(isTrustedSystemdRunFile("/usr/bin/systemd-run", deps)).toBe(true);
  });

  test("rejects a non-root resolved target even inside a pinned chain", () => {
    const deps = {
      ...trustedDeps,
      realpathSync: () => "/usr/lib/systemd/systemd-run",
      statSync: (path: string) =>
        path === "/usr/lib/systemd/systemd-run" ? fileStat(0o755, 1000) : dirStat(0o755),
    };
    expect(isTrustedSystemdRunFile("/usr/bin/systemd-run", deps)).toBe(false);
  });
});

test("launcher trust also checks lexical ancestors of a canonical system target", () => {
  const candidate = "/usr/local/bin/systemd-run";
  const target = "/nix/store/systemd/bin/systemd-run";
  const deps = (bad: string | undefined) => ({ realpathSync: () => target, accessSync: () => {},
    statSync: (path: string) => ({ isFile: () => path === target, uid: 0, mode: path === bad ? 0o777 : 0o755 }) });
  expect(isTrustedSystemdRunFile(candidate, deps(undefined))).toBe(true);
  expect(isTrustedSystemdRunFile(candidate, deps("/usr/local"))).toBe(false);
  expect(isTrustedSystemdRunFile(candidate, deps("/nix/store"))).toBe(false);
  expect(isTrustedSystemdRunFile("relative/systemd-run", deps(undefined))).toBe(false);
});

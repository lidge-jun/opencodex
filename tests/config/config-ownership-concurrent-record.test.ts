import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONFIG_OWNERSHIP_LOCK,
  CONFIG_UNINSTALL_MANIFEST,
  ConfigOwnershipLockError,
  ConfigUninstallInProgressError,
  recordOwnedConfigPath,
  removeOwnedConfigState,
  setUninstallStepHookForTests,
} from "../../src/lib/config-ownership";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8093: every manifest read-modify-write runs under one cross-process lock, and uninstall
// tombstones the manifest under that lock before it snapshots the paths it removes.
const modulePath = repoPath("src/lib/config-ownership.ts");
const BARRIER_MS = 20_000;
// Exit codes: 0 recorded, 2 not recorded, 3 refused by the uninstall tombstone, 1 anything else.
// With a gate, the child creates its file, announces it, and records only once the gate opens.
const childScript = (dir: string, rel: string, gate?: { ready: string; go: string }, createPath = true) => [
  "import { existsSync, writeFileSync } from \"node:fs\";",
  "import { ConfigUninstallInProgressError, recordOwnedConfigPath } from " + JSON.stringify(modulePath) + ";",
  "const path = " + JSON.stringify(join(dir, rel)) + ";",
  gate && createPath ? "writeFileSync(path, \"child\");" : "",
  gate ? "writeFileSync(" + JSON.stringify(gate.ready) + ", \"\");" : "",
  gate ? "const until = Date.now() + " + BARRIER_MS + "; while (!existsSync(" + JSON.stringify(gate.go) + ") && Date.now() < until) Bun.sleepSync(5);" : "",
  gate ? "if (!existsSync(" + JSON.stringify(gate.go) + ")) process.exit(1);" : "",
  // A busy ownership lock fails fast; callers retry, and so does this child.
  "let code = 1;",
  "for (let attempt = 0; attempt < 400; attempt++) {",
  "  try { code = recordOwnedConfigPath(" + JSON.stringify(dir) + ", path) ? 0 : 2; break; }",
  "  catch (error) {",
  "    if (error && error.code === \"CONFIG_OWNERSHIP_LOCK_UNAVAILABLE\") { Bun.sleepSync(5); continue; }",
  "    code = error instanceof ConfigUninstallInProgressError ? 3 : 1; if (code === 1) console.error(error); break;",
  "  }",
  "}",
  "process.exit(code);",
].join("\n");
const spawnChild = (dir: string, rel: string, gate?: { ready: string; go: string }) =>
  Bun.spawn([process.execPath, "-e", childScript(dir, rel, gate)], { stderr: "inherit" });
const manifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")) as { paths: string[]; uninstallStartedAt?: number };

function holdLock(dir: string): () => void {
  const database = new Database(join(dir, CONFIG_OWNERSHIP_LOCK), { create: false, readwrite: true });
  database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  return () => { database.exec("ROLLBACK"); database.close(); };
}

/** Uninstall in another process, so this process keeps its warm ownership cache. */
function uninstallElsewhere(dir: string): string {
  const script = "import { removeOwnedConfigState } from " + JSON.stringify(modulePath) + ";\n"
    + "console.log(removeOwnedConfigState(" + JSON.stringify(dir) + ").status);";
  return Bun.spawnSync([process.execPath, "-e", script]).stdout.toString().trim();
}

function withHome(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-ownership-record-"));
    const dir = join(parent, "home");
    try { await fn(dir); } finally { removeTreeWithRetry(parent); }
  };
}

describe("serialized ownership manifest (#8093)", () => {
  test("a path another process recorded survives this process's write from an older cache", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
    expect(Bun.spawnSync([process.execPath, "-e", childScript(dir, "other")]).exitCode).toBe(0);
    expect(recordOwnedConfigPath(dir, join(dir, "local"))).toBe(true);
    expect(manifest(dir).paths).toEqual(expect.arrayContaining(["other", "local"]));
    for (const name of ["config.json", "other", "local"]) writeFileSync(join(dir, name), name);
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
  }));

  test("concurrent registrations from several processes all survive", withHome(async dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
    const names = Array.from({ length: 6 }, (_, i) => "parallel-" + i);
    const children = names.map(name => spawnChild(dir, name));
    expect(await Promise.all(children.map(child => child.exited))).toEqual(names.map(() => 0));
    expect(manifest(dir).paths).toEqual(expect.arrayContaining(names));
    expect(manifest(dir).paths).not.toContain(CONFIG_OWNERSHIP_LOCK);
  }));

  test("a registration racing uninstall is either removed or refused, never left unreported", withHome(async dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const names = Array.from({ length: 6 }, (_, i) => "racing-" + i);
    const signals = dirname(dir);
    const gates = names.map(name => ({ ready: join(signals, name + ".ready"), go: join(signals, "go") }));
    const children = names.map((name, i) => spawnChild(dir, name, gates[i]));
    // Barrier: every child has created its file before uninstall starts.
    const deadline = Date.now() + BARRIER_MS;
    while (Date.now() < deadline && !gates.every(gate => existsSync(gate.ready))) await Bun.sleep(10);
    expect(gates.every(gate => existsSync(gate.ready))).toBe(true);
    // Open the gate while holding the lock, so the children contend with uninstall for it.
    const release = holdLock(dir);
    try {
      writeFileSync(gates[0]!.go, "");
      await Bun.sleep(50);
    } finally { release(); }
    const result = removeOwnedConfigState(dir);
    const codes = await Promise.all(children.map(child => child.exited));
    expect(codes.every(code => code === 0 || code === 2 || code === 3)).toBe(true);
    names.forEach((name, i) => {
      const path = join(dir, name);
      if (codes[i] === 0) expect(existsSync(path)).toBe(false);
      else expect(result.residualPaths).toContain(path);
    });
    expect(existsSync(join(dir, CONFIG_OWNERSHIP_LOCK))).toBe(false);
  }), 60_000);

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an interrupted uninstall refuses registrations, cached paths included, and a rerun finishes it",
    withHome(async dir => {
      // This process records (and caches) paths, as a long-running proxy would.
      expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(join(dir, "config.json"), "{}");
      // "artifacts" is an initially owned path; an unwritable directory makes removal stop midway.
      mkdirSync(join(dir, "artifacts"));
      writeFileSync(join(dir, "artifacts", "image.png"), "png");
      chmodSync(join(dir, "artifacts"), 0o500);
      try {
        expect(uninstallElsewhere(dir)).toBe("partial");
      } finally { chmodSync(join(dir, "artifacts"), 0o700); }
      const tombstoned = readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8");
      expect(manifest(dir).uninstallStartedAt).toEqual(expect.any(Number));

      expect(() => recordOwnedConfigPath(dir, join(dir, "seed"))).toThrow(ConfigUninstallInProgressError);
      expect(() => recordOwnedConfigPath(dir, join(dir, "artifacts"))).toThrow(ConfigUninstallInProgressError);
      expect(() => recordOwnedConfigPath(dir, join(dir, "late-local"))).toThrow(ConfigUninstallInProgressError);
      // The refusal can reach logs, so it names no path.
      try { recordOwnedConfigPath(dir, join(dir, "late-local")); } catch (error) { expect(String(error)).not.toContain(dir); }
      expect(await spawnChild(dir, "late").exited).toBe(3);
      expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")).toBe(tombstoned);

      expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
      expect(existsSync(dir)).toBe(false);
    }));

  test("a rerun finishes a home where only the ownership lock was left behind", withHome(dir => {
    mkdirSync(dir);
    writeFileSync(join(dir, CONFIG_OWNERSHIP_LOCK), "");
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
  }));

  test.each([
    ["a sidecar name alone", { "-journal": "user data" }],
    ["a lock file holding data", { "": "user data" }],
    ["an empty lock next to a sidecar holding data", { "": "", "-journal": "user data" }],
    ["an empty sidecar without the lock file", { "-wal": "" }],
  ] as const)("a home without metadata is refused untouched when it holds %s", (_label, files) => withHome(dir => {
    mkdirSync(dir);
    for (const [suffix, content] of Object.entries(files)) writeFileSync(join(dir, CONFIG_OWNERSHIP_LOCK + suffix), content);
    expect(removeOwnedConfigState(dir).status).toBe("refused");
    for (const [suffix, content] of Object.entries(files)) {
      expect(readFileSync(join(dir, CONFIG_OWNERSHIP_LOCK + suffix), "utf8")).toBe(content);
    }
  })());

  test("a registration that cannot get the lock fails without writing", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const before = readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8");
    const release = holdLock(dir);
    try {
      // SQLite's busy wait is off, so a held lock fails within the short bounded retry.
      const started = Date.now();
      expect(() => recordOwnedConfigPath(dir, join(dir, "blocked"))).toThrow(ConfigOwnershipLockError);
      expect(Date.now() - started).toBeLessThan(500);
    } finally { release(); }
    expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")).toBe(before);
    expect(recordOwnedConfigPath(dir, join(dir, "blocked"))).toBe(true);
  }));

  test("refusing a home without ownership metadata leaves it untouched", withHome(dir => {
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, CONFIG_OWNERSHIP_LOCK), "");
    expect(removeOwnedConfigState(dir).status).toBe("refused");
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(existsSync(join(dir, CONFIG_OWNERSHIP_LOCK))).toBe(true);
    removeTreeWithRetry(join(dir, CONFIG_OWNERSHIP_LOCK));
    expect(removeOwnedConfigState(dir).status).toBe("refused");
    expect(existsSync(join(dir, CONFIG_OWNERSHIP_LOCK))).toBe(false);
  }));
});

describe("callers that create files after registering them (#8093)", () => {
  test("service log rotation goes ahead unrecorded while the ownership lock is busy", withHome(async dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const { startServiceLogging, SERVICE_LOG_MAX_BYTES } = await import("../../src/service/logging");
    const path = join(dir, "service.log");
    writeFileSync(path, "x".repeat(SERVICE_LOG_MAX_BYTES + 1));
    expect(manifest(dir).paths).not.toContain("service.log.1");
    const release = holdLock(dir);
    let stop: (() => void) | undefined;
    try {
      expect(() => recordOwnedConfigPath(dir, path + ".1")).toThrow(ConfigOwnershipLockError);
      stop = startServiceLogging(path, { OCX_SERVICE: "1" }, 10);
      expect(existsSync(path + ".1")).toBe(false);
      const deadline = Date.now() + 3_000;
      while (!existsSync(path + ".1") && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(path + ".1")).toBe(true);
      expect(manifest(dir).paths).not.toContain("service.log.1");
    } finally {
      try { stop?.(); } finally { release(); }
    }
  }));

  test.skipIf(process.platform === "win32")("service log rotation goes ahead unrecorded once the ownership lock keeps failing",
    withHome(async dir => {
      expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
      // A second link to the lock file is refused on every attempt: a lock fault that persists.
      linkSync(join(dir, CONFIG_OWNERSHIP_LOCK), join(dirname(dir), "lock-link"));
      expect(() => recordOwnedConfigPath(dir, join(dir, "service.log.1"))).toThrow(ConfigOwnershipLockError);
      const { startServiceLogging, SERVICE_LOG_MAX_BYTES } = await import("../../src/service/logging");
      const path = join(dir, "service.log");
      writeFileSync(path, "x".repeat(SERVICE_LOG_MAX_BYTES + 1));
      const stop = startServiceLogging(path, { OCX_SERVICE: "1" }, 10);
      try {
        // The first attempt skips, as it would for a busy lock; later ticks rotate anyway.
        expect(existsSync(path + ".1")).toBe(false);
        const deadline = Date.now() + 5_000;
        while (!existsSync(path + ".1") && Date.now() < deadline) await Bun.sleep(10);
      } finally { stop(); }
      expect(existsSync(path + ".1")).toBe(true);
      expect(manifest(dir).paths).not.toContain("service.log.1");
    }));

  test("service log rotation stops creating generations once uninstall has started", withHome(async dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const { startServiceLogging, SERVICE_LOG_MAX_BYTES } = await import("../../src/service/logging");
    const path = join(dir, "service.log");
    const grow = () => writeFileSync(path, "x".repeat(SERVICE_LOG_MAX_BYTES + 1));
    grow();
    const stop = startServiceLogging(path, { OCX_SERVICE: "1" }, 10);
    try {
      expect(existsSync(path + ".1")).toBe(true);
      expect(manifest(dir).paths).toEqual(expect.arrayContaining(["service.log.1", "service.log.2"]));
      // Uninstall starts while the timer is running; the next rotations must create nothing.
      const tombstoned = { ...manifest(dir), uninstallStartedAt: Date.now() };
      writeFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), JSON.stringify(tombstoned, null, 2) + "\n");
      removeTreeWithRetry(path + ".1");
      grow();
      await Bun.sleep(100);
    } finally { stop(); }
    expect(existsSync(path + ".1")).toBe(false);
    expect(existsSync(path + ".2")).toBe(false);
  }));
});

describe("manifest limits and uninstall leftovers (#8093)", () => {
  test("registration stops at the byte limit instead of writing a manifest uninstall would reject", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const warn = console.warn;
    console.warn = () => {};
    let refused = 0;
    try {
      for (let i = 0; i < 400 && refused === 0; i += 1) {
        if (!recordOwnedConfigPath(dir, join(dir, String(i).padStart(4, "0") + "-" + "n".repeat(220)))) refused += 1;
      }
    } finally { console.warn = warn; }
    expect(refused).toBe(1);
    expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST)).length).toBeLessThanOrEqual(64 * 1024 - 64);
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
  }));

  test("a rerun resuming from the tombstoned manifest keeps an unlisted file and reports it", withHome(async dir => {
    const { setUninstallStepHookForTests } = await import("../../src/lib/config-ownership");
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    writeFileSync(join(dir, "seed"), "x");
    setUninstallStepHookForTests(step => { if (step === "owner-deleted") throw new Error("stopped"); });
    try { expect(removeOwnedConfigState(dir).status).toBe("partial"); } finally { setUninstallStepHookForTests(undefined); }
    writeFileSync(join(dir, "user-notes.txt"), "keep");
    const result = removeOwnedConfigState(dir);
    expect(result.status).toBe("partial");
    expect(result.residualPaths).toEqual([join(dir, "user-notes.txt")]);
    expect(readFileSync(join(dir, "user-notes.txt"), "utf8")).toBe("keep");
  }));

  test("leftover lock files are kept while another process holds the lock", withHome(dir => {
    mkdirSync(dir);
    writeFileSync(join(dir, CONFIG_OWNERSHIP_LOCK), "");
    const release = holdLock(dir);
    try {
      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(existsSync(join(dir, CONFIG_OWNERSHIP_LOCK))).toBe(true);
    } finally { release(); }
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
  }));
});

describe("upgraded homes near the manifest byte limit (#8093)", () => {
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an interrupted uninstall of a near-limit manifest still resumes after the tombstone",
    withHome(dir => {
      expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
      // An older version could fill the manifest up to the limit with no tombstone reserve.
      const base = manifest(dir);
      const filler: string[] = [];
      const size = () => Buffer.byteLength(JSON.stringify({ ...base, paths: [...base.paths, ...filler].sort() }, null, 2) + "\n");
      while (size() < 64 * 1024 - 300) filler.push("f-" + String(filler.length).padStart(4, "0") + "-" + "x".repeat(200));
      filler.push("z-" + "y".repeat(64 * 1024 - size() - 10));
      while (size() > 64 * 1024) filler[filler.length - 1] = filler[filler.length - 1]!.slice(0, -1);
      const nearLimit = JSON.stringify({ ...base, paths: [...base.paths, ...filler].sort() }, null, 2) + "\n";
      expect(Buffer.byteLength(nearLimit)).toBeGreaterThan(64 * 1024 - 40);
      expect(Buffer.byteLength(nearLimit)).toBeLessThanOrEqual(64 * 1024);
      writeFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), nearLimit);
      mkdirSync(join(dir, "artifacts"));
      writeFileSync(join(dir, "artifacts", "image.png"), "png");
      chmodSync(join(dir, "artifacts"), 0o500);
      try {
        expect(removeOwnedConfigState(dir).status).toBe("partial");
      } finally { chmodSync(join(dir, "artifacts"), 0o700); }
      expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST)).length).toBeGreaterThan(64 * 1024);
      expect(manifest(dir).uninstallStartedAt).toEqual(expect.any(Number));
      expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
    }));

  test("an untombstoned manifest over the limit is still rejected", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const base = manifest(dir);
    const over = JSON.stringify({ ...base, paths: [...base.paths, "w".repeat(64 * 1024)] }, null, 2) + "\n";
    writeFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), over);
    expect(removeOwnedConfigState(dir).status).toBe("refused");
  }));
});

describe("interrupted metadata writes (#8093)", () => {
  test("a manifest write that stopped before its rename does not block uninstall", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const temp = join(dir, CONFIG_UNINSTALL_MANIFEST + ".4242." + crypto.randomUUID() + ".tmp");
    // What writeManifest leaves when it stops before the rename: this home's next manifest.
    writeFileSync(temp, JSON.stringify({ ...manifest(dir), paths: [...manifest(dir).paths, "next"].sort() }, null, 2) + "\n");
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
  }));

  test("a file that only looks like a manifest temp file is kept and reported", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const name = (suffix: string) => join(dir, CONFIG_UNINSTALL_MANIFEST + "." + suffix + "." + crypto.randomUUID() + ".tmp");
    const userData = name("4242");
    const truncated = name("4243");
    const otherHome = name("4244");
    writeFileSync(userData, "user data");
    writeFileSync(truncated, JSON.stringify(manifest(dir)).slice(0, 40));
    writeFileSync(otherHome, JSON.stringify({ ...manifest(dir), ownerId: crypto.randomUUID() }));
    const result = removeOwnedConfigState(dir);
    expect({ ...result, residualPaths: [...result.residualPaths].sort() }).toEqual({
      status: "partial",
      reason: "unowned files remain in the config directory",
      residualPaths: [userData, truncated, otherHome].sort(),
    });
    expect(readFileSync(userData, "utf8")).toBe("user data");
  }));

  test("a home whose creation wrote the manifest but not yet the owner marker is refused untouched", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    // Creation writes the manifest first, so this is the in-progress state; uninstall's own
    // leftover state is the reverse (owner marker without manifest).
    removeTreeWithRetry(join(dir, ".opencodex-owner.json"));
    removeTreeWithRetry(join(dir, CONFIG_OWNERSHIP_LOCK));
    expect(removeOwnedConfigState(dir).status).toBe("refused");
    expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
  }));

  test("creation writes the manifest before the owner marker", () => {
    const source = readFileSync(modulePath, "utf8");
    const create = source.slice(source.indexOf("function createOwnership"), source.indexOf("function createOwnership") + 2_000);
    expect(create.indexOf("CONFIG_UNINSTALL_MANIFEST")).toBeLessThan(create.indexOf("CONFIG_OWNER_FILE"));
  });
});

describe("rerunning ocx uninstall through its cleanup flow (#8093)", () => {
  test("the uninstaller's own cleanup steps can register state, and the rerun finishes", withHome(async dir => {
    const { removeOwnedConfigAfterDesktopCleanup } = await import("../../src/cli/uninstall-client-state");
    const { withClientLifecycle } = await import("../../src/client/lifecycle-lock");
    const { withConfigMutationLockSync } = await import("../../src/config/mutation-lock");
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    writeFileSync(join(dir, "config.json"), "{}");
    // An earlier uninstall stopped after its tombstone.
    writeFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), JSON.stringify({ ...manifest(dir), uninstallStartedAt: Date.now() }, null, 2) + "\n");
    // Outside the uninstaller, registrations keep refusing.
    expect(() => recordOwnedConfigPath(dir, join(dir, "config-mutation.sqlite"))).toThrow(ConfigUninstallInProgressError);
    const lockPath = join(dirname(dir), "runtime", "lifecycle.sqlite");
    const result = await removeOwnedConfigAfterDesktopCleanup(
      { serviceStop: "stopped", serviceRemoval: "removed", proxyProvenDown: true, respawnWindowVerified: false },
      {
        readConnection: () => ({ kind: "disconnected" }),
        inspectDesktop: () => ({ kind: "absent" }),
        readReceipt: () => ({ kind: "absent" }),
        disconnect: async () => undefined,
        withLifecycle: work => withClientLifecycle(work, { lockPath }),
        cleanupIntegrations: async () => ({ attempted: 0, changed: 0 }),
        remove: () => removeOwnedConfigState(dir),
        aclReapPending: () => false,
        // Picker cleanup takes the config mutation lock, which records its database.
        removePickerArtifacts: async () => { withConfigMutationLockSync(() => undefined, dir); return { ok: true }; },
      } as never,
    );
    expect(result).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
  }));
});

describe("teardown scope ends cleanly (#8093)", () => {
  test("after a failed teardown, a path registered inside the scope is refused again", withHome(async dir => {
    const { beginConfigOwnershipTeardown } = await import("../../src/lib/config-ownership");
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    writeFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), JSON.stringify({ ...manifest(dir), uninstallStartedAt: Date.now() }, null, 2) + "\n");
    const end = beginConfigOwnershipTeardown();
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
      expect(recordOwnedConfigPath(dir, join(dir, "picker-state"))).toBe(true);
      // Cleanup fails here, before the remover runs.
    } finally { end(); }
    expect(() => recordOwnedConfigPath(dir, join(dir, "seed"))).toThrow(ConfigUninstallInProgressError);
    expect(() => recordOwnedConfigPath(dir, join(dir, "picker-state"))).toThrow(ConfigUninstallInProgressError);
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
  }));
});

describe("concurrent first registrations on an absent home (#8093)", () => {
  test("a worker whose first-registration barrier expired exits without creating the home", withHome(dir => {
    const gate = { ready: join(dirname(dir), "expired.ready"), go: join(dirname(dir), "never-go") };
    const clock = "let tick = 0; Date.now = () => tick++ * " + BARRIER_MS + ";\n";
    const child = Bun.spawnSync([process.execPath, "-e", clock + childScript(dir, "cold", gate, false)]);
    expect(existsSync(gate.ready)).toBe(true);
    expect(child.exitCode).toBe(1);
    expect(existsSync(dir)).toBe(false);
  }));

  test("processes that start together on an absent home all record their paths", withHome(async dir => {
    const names = Array.from({ length: 6 }, (_, i) => "cold-" + i);
    const signals = dirname(dir);
    const go = join(signals, "go-cold");
    // Use the same bounded busy-lock retry as other registration children, while
    // leaving the home absent until the synchronized first registration starts.
    const script = (rel: string) => childScript(dir, rel, { ready: join(signals, rel + ".ready"), go }, false);
    const children = names.map(name => Bun.spawn([process.execPath, "-e", script(name)], { stderr: "inherit" }));
    const deadline = Date.now() + BARRIER_MS;
    while (Date.now() < deadline && !names.every(name => existsSync(join(signals, name + ".ready")))) await Bun.sleep(10);
    expect(names.every(name => existsSync(join(signals, name + ".ready")))).toBe(true);
    writeFileSync(go, "");
    expect(await Promise.all(children.map(child => child.exited))).toEqual(names.map(() => 0));
    expect(manifest(dir).paths).toEqual(expect.arrayContaining(names));
  }), 60_000);
});

describe("rerun after the owner marker was already deleted (#8093)", () => {
  test("the rerun's own cleanup can recreate an initially owned file, and the rerun still finishes", withHome(async dir => {
    const { removeOwnedConfigAfterDesktopCleanup } = await import("../../src/cli/uninstall-client-state");
    const { withClientLifecycle } = await import("../../src/client/lifecycle-lock");
    const { withConfigMutationLockSync } = await import("../../src/config/mutation-lock");
    const { setUninstallStepHookForTests } = await import("../../src/lib/config-ownership");
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    // An earlier uninstall stopped after deleting the owner marker: only its tombstoned manifest
    // (and the lock) remain, and other processes keep refusing to register.
    setUninstallStepHookForTests(step => { if (step === "owner-deleted") throw new Error("stopped"); });
    try { expect(removeOwnedConfigState(dir).status).toBe("partial"); } finally { setUninstallStepHookForTests(undefined); }
    expect(existsSync(join(dir, ".opencodex-owner.json"))).toBe(false);
    expect(manifest(dir).uninstallStartedAt).toEqual(expect.any(Number));
    expect(await spawnChild(dir, "config.json").exited).toBe(3);
    expect(await spawnChild(dir, "late").exited).toBe(3);
    expect(() => recordOwnedConfigPath(dir, join(dir, "late"))).toThrow(ConfigUninstallInProgressError);
    const lockPath = join(dirname(dir), "runtime", "lifecycle.sqlite");
    const result = await removeOwnedConfigAfterDesktopCleanup(
      { serviceStop: "stopped", serviceRemoval: "removed", proxyProvenDown: true, respawnWindowVerified: false },
      {
        readConnection: () => ({ kind: "disconnected" }),
        inspectDesktop: () => ({ kind: "absent" }),
        readReceipt: () => ({ kind: "absent" }),
        disconnect: async () => undefined,
        withLifecycle: work => withClientLifecycle(work, { lockPath }),
        cleanupIntegrations: async () => ({ attempted: 0, changed: 0 }),
        remove: () => removeOwnedConfigState(dir),
        aclReapPending: () => false,
        // Picker cleanup takes the config mutation lock, which recreates its listed database.
        removePickerArtifacts: async () => {
          withConfigMutationLockSync(() => undefined, dir);
          expect(existsSync(join(dir, "config-mutation.sqlite"))).toBe(true);
          return { ok: true };
        },
      } as never,
    );
    expect(result).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
  }));

  test("without the owner marker, an initially owned name is not claimed", withHome(dir => {
    mkdirSync(dir);
    writeFileSync(join(dir, CONFIG_OWNERSHIP_LOCK), "");
    writeFileSync(join(dir, "config.json"), "{}");
    expect(removeOwnedConfigState(dir).status).toBe("refused");
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  }));
});

describe("paths recorded after the uninstall snapshot (#8093)", () => {
  test("while uninstall holds the lock, a second uninstall and any registration are refused", withHome(async dir => {
    const { setUninstallStepHookForTests } = await import("../../src/lib/config-ownership");
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    writeFileSync(join(dir, "seed"), "x");
    const uninstallScript = "import { removeOwnedConfigState } from " + JSON.stringify(modulePath) + ";\n"
      + "console.log(removeOwnedConfigState(" + JSON.stringify(dir) + ").status);";
    const seen: Record<string, unknown> = {};
    setUninstallStepHookForTests(step => {
      if (step === "snapshot-removed") {
        seen.secondUninstall = Bun.spawnSync([process.execPath, "-e", uninstallScript]).stdout.toString().trim();
        // A listed path is read without the lock and refused by the tombstone; a new path needs the lock.
        seen.listed = Bun.spawnSync([process.execPath, "-e", childScript(dir, "config.json")]).exitCode;
      }
      if (step === "owner-deleted") {
        // Only the tombstoned manifest remains: that is an uninstall finishing, not an unowned home.
        seen.secondBetweenUnlinks = Bun.spawnSync([process.execPath, "-e", uninstallScript]).stdout.toString().trim();
        seen.betweenUnlinks = Bun.spawnSync([process.execPath, "-e", childScript(dir, "fresh-between")]).exitCode;
      }
    });
    let result;
    try { result = removeOwnedConfigState(dir); } finally { setUninstallStepHookForTests(undefined); }
    expect(seen).toEqual({ secondUninstall: "refused", listed: 3, secondBetweenUnlinks: "refused", betweenUnlinks: 3 });
    expect(result).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(join(dir, "fresh-between"))).toBe(false);
  }), 60_000);

  test.skipIf(process.platform === "win32")("a finishing uninstall leaves a lock file another installation created in place",
    withHome(async dir => {
      const { setUninstallStepHookForTests } = await import("../../src/lib/config-ownership");
      expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
      const lock = join(dir, CONFIG_OWNERSHIP_LOCK);
      setUninstallStepHookForTests(step => {
        if (step !== "owner-deleted") return;
        // A new generation's lock replaces the path this run holds.
        removeTreeWithRetry(lock);
        writeFileSync(lock, "new");
      });
      let result;
      try { result = removeOwnedConfigState(dir); } finally { setUninstallStepHookForTests(undefined); }
      expect(readFileSync(lock, "utf8")).toBe("new");
      expect(result).toEqual({ status: "partial", reason: "unowned files remain in the config directory", residualPaths: [lock] });
    }));

  test("a home cached as unowned picks up an owner marker written later", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const ownerText = readFileSync(join(dir, ".opencodex-owner.json"), "utf8");
    removeTreeWithRetry(join(dir, ".opencodex-owner.json"));
    // A fresh process sees the manifest without the owner marker, waits out the creation deadline and
    // caches the home as unowned; the marker then appears and its next registration must succeed.
    const script = [
      "import { writeFileSync } from \"node:fs\";",
      "import { recordOwnedConfigPath } from " + JSON.stringify(modulePath) + ";",
      "const first = recordOwnedConfigPath(" + JSON.stringify(dir) + ", " + JSON.stringify(join(dir, "early")) + ");",
      "writeFileSync(" + JSON.stringify(join(dir, ".opencodex-owner.json")) + ", " + JSON.stringify(ownerText) + ");",
      "const second = recordOwnedConfigPath(" + JSON.stringify(dir) + ", " + JSON.stringify(join(dir, "late-owner")) + ");",
      "console.log(JSON.stringify([first, second]));",
    ].join("\n");
    expect(Bun.spawnSync([process.execPath, "-e", script]).stdout.toString().trim()).toBe("[false,true]");
    expect(manifest(dir).paths).toContain("late-owner");
  }));

  test("rotation on a full manifest still rotates, and uninstall reports the unrecorded generation", withHome(async dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 400; i += 1) {
        if (!recordOwnedConfigPath(dir, join(dir, String(i).padStart(4, "0") + "-" + "n".repeat(220)))) break;
      }
      // Fill the remaining bytes with names shorter than "service.log.1", so it cannot fit either.
      for (let i = 0; i < 400; i += 1) if (!recordOwnedConfigPath(dir, join(dir, "z" + i))) break;
      const { startServiceLogging, SERVICE_LOG_MAX_BYTES } = await import("../../src/service/logging");
      const path = join(dir, "service.log");
      writeFileSync(path, "x".repeat(SERVICE_LOG_MAX_BYTES + 1));
      startServiceLogging(path, { OCX_SERVICE: "1" }, 60_000)();
      expect(existsSync(path + ".1")).toBe(true);
      expect(manifest(dir).paths).not.toContain("service.log.1");
      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toContain(path + ".1");
    } finally { console.warn = warn; }
  }), 60_000);
});

describe("a missing manifest without uninstall evidence (#8093)", () => {
  test("initially owned files are kept and the home is refused", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    writeFileSync(join(dir, "config.json"), "{\"keep\":true}");
    writeFileSync(join(dir, "auth.json"), "{}");
    // The manifest is lost for some other reason: the owner marker carries no evidence that
    // uninstall removed its snapshot.
    removeTreeWithRetry(join(dir, CONFIG_UNINSTALL_MANIFEST));
    expect(removeOwnedConfigState(dir).status).toBe("refused");
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe("{\"keep\":true}");
    expect(existsSync(join(dir, "auth.json"))).toBe(true);
  }));

  test("an uninstall stopped after deleting the owner marker resumes from its exact snapshot", withHome(async dir => {
    const { setUninstallStepHookForTests } = await import("../../src/lib/config-ownership");
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    // A manifest from an older version may omit an initially owned name; that file is not ours.
    writeFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), JSON.stringify({ ...manifest(dir), paths: manifest(dir).paths.filter(path => path !== "config.json") }, null, 2) + "\n");
    writeFileSync(join(dir, "config.json"), "{\"keep\":true}");
    setUninstallStepHookForTests(step => { if (step === "owner-deleted") throw new Error("stopped"); });
    try { expect(removeOwnedConfigState(dir).status).toBe("partial"); } finally { setUninstallStepHookForTests(undefined); }
    expect(existsSync(join(dir, ".opencodex-owner.json"))).toBe(false);
    expect(manifest(dir).uninstallStartedAt).toEqual(expect.any(Number));
    // A listed file recreated before the rerun is removed by it; the unlisted one stays.
    writeFileSync(join(dir, "config-mutation.sqlite"), "");
    const result = removeOwnedConfigState(dir);
    expect(result.status).toBe("partial");
    expect(result.residualPaths).toEqual([join(dir, "config.json")]);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe("{\"keep\":true}");
    expect(existsSync(join(dir, "config-mutation.sqlite"))).toBe(false);
  }));
});

describe("a busy ownership lock (#8093)", () => {
  test("an already listed path is still accepted while another process holds the lock", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    // Another process changes the manifest, so this process must consult it again.
    expect(Bun.spawnSync([process.execPath, "-e", childScript(dir, "other")]).exitCode).toBe(0);
    const release = holdLock(dir);
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "usage.jsonl"))).toBe(true);
      expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
      expect(() => recordOwnedConfigPath(dir, join(dir, "brand-new"))).toThrow(ConfigOwnershipLockError);
    } finally { release(); }
  }));

  test("a usage row is persisted while another process holds the ownership lock", withHome(async dir => {
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
      expect(Bun.spawnSync([process.execPath, "-e", childScript(dir, "other")]).exitCode).toBe(0);
      const { appendUsageEntry } = await import("../../src/usage/log");
      const release = holdLock(dir);
      try {
        appendUsageEntry({ requestId: "busy-lock-row", timestamp: 1_700_000_000_000, provider: "a", model: "m1", status: 200, durationMs: 1, usageStatus: "reported" } as never);
      } finally { release(); }
      expect(readFileSync(join(dir, "usage.jsonl"), "utf8")).toContain("busy-lock-row");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
    }
  }));
});

describe("an uninstall stopped after deleting the owner marker (#8093)", () => {
  /** Uninstall in another process that stops right after deleting the owner marker. */
  const stopAfterOwnerDeleted = (dir: string) => Bun.spawnSync([process.execPath, "-e", [
    "import { removeOwnedConfigState, setUninstallStepHookForTests } from " + JSON.stringify(modulePath) + ";",
    "setUninstallStepHookForTests(step => { if (step === \"owner-deleted\") throw new Error(\"stopped\"); });",
    "console.log(removeOwnedConfigState(" + JSON.stringify(dir) + ").status);",
  ].join("\n")]).stdout.toString().trim();

  test("a process that cached the ownership earlier is refused, listed and new paths alike", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
    expect(stopAfterOwnerDeleted(dir)).toBe("partial");
    expect(existsSync(join(dir, ".opencodex-owner.json"))).toBe(false);
    expect(() => recordOwnedConfigPath(dir, join(dir, "late-credential.json"))).toThrow(ConfigUninstallInProgressError);
    expect(() => recordOwnedConfigPath(dir, join(dir, "config.json"))).toThrow(ConfigUninstallInProgressError);
    expect(manifest(dir).paths).not.toContain("late-credential.json");
  }));

  test("the rerun's cleanup records a file the snapshot lacks, and never adopts an existing one", withHome(async dir => {
    const { beginConfigOwnershipTeardown } = await import("../../src/lib/config-ownership");
    const { withConfigMutationLockSync } = await import("../../src/config/mutation-lock");
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    // An older snapshot without the config mutation database.
    writeFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), JSON.stringify({
      ...manifest(dir), paths: manifest(dir).paths.filter(path => !path.startsWith("config-mutation.sqlite")),
    }, null, 2) + "\n");
    expect(stopAfterOwnerDeleted(dir)).toBe("partial");
    writeFileSync(join(dir, "user-file"), "keep");
    const end = beginConfigOwnershipTeardown();
    let result;
    try {
      withConfigMutationLockSync(() => undefined, dir);
      expect(existsSync(join(dir, "config-mutation.sqlite"))).toBe(true);
      expect(manifest(dir).paths).toContain("config-mutation.sqlite");
      expect(recordOwnedConfigPath(dir, join(dir, "user-file"))).toBe(false);
      expect(manifest(dir).paths).not.toContain("user-file");
      result = removeOwnedConfigState(dir);
    } finally { end(); }
    expect(result).toEqual({ status: "partial", reason: "unowned files remain in the config directory", residualPaths: [join(dir, "user-file")] });
    expect(existsSync(join(dir, "config-mutation.sqlite"))).toBe(false);
    expect(readFileSync(join(dir, "user-file"), "utf8")).toBe("keep");
  }));
});

describe("ownership edge cases from review (#8093)", () => {
  // SQLite itself manages the -journal and -wal names of a database it opens; -shm it leaves to us.
  test("a lock sidecar holding data is kept and reported by uninstall", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    writeFileSync(join(dir, CONFIG_OWNERSHIP_LOCK + "-shm"), "user data");
    expect(removeOwnedConfigState(dir)).toEqual({
      status: "partial", reason: "unowned files remain in the config directory", residualPaths: [join(dir, CONFIG_OWNERSHIP_LOCK + "-shm")],
    });
    expect(readFileSync(join(dir, CONFIG_OWNERSHIP_LOCK + "-shm"), "utf8")).toBe("user data");
  }));

  test("an empty lock sidecar is removed by uninstall", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    writeFileSync(join(dir, CONFIG_OWNERSHIP_LOCK + "-shm"), "");
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
  }));

  test.skipIf(process.platform === "win32")("a finishing uninstall unlinks its lock file before releasing it", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    // A process that takes the old file after release must see the path change and retry, so the
    // path is gone while this run still holds the lock.
    const seen: Array<{ lockPresent: boolean; secondUninstall: string }> = [];
    setUninstallStepHookForTests(step => {
      if (step !== "lock-retired") return;
      seen.push({ lockPresent: existsSync(join(dir, CONFIG_OWNERSHIP_LOCK)), secondUninstall: uninstallElsewhere(dir) });
    });
    let result;
    try { result = removeOwnedConfigState(dir); } finally { setUninstallStepHookForTests(undefined); }
    expect(seen).toEqual([{ lockPresent: false, secondUninstall: "refused" }]);
    expect(result).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
  }));

  /** An older manifest without the config mutation database, optionally filled to the path cap. */
  const olderManifest = (dir: string, fill: boolean) => {
    const paths = manifest(dir).paths.filter(path => !path.startsWith("config-mutation.sqlite"));
    while (fill && paths.length < 1024) paths.push("filler-" + paths.length);
    writeFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), JSON.stringify({ ...manifest(dir), paths: paths.sort() }, null, 2) + "\n");
  };
  /** Stop an uninstall at `step` in this process, as a crash would (it never reports "removed"). */
  const stopAt = (dir: string, step: "snapshot-removed" | "owner-deleted") => {
    setUninstallStepHookForTests(seen => { if (seen === step) throw new Error("stopped"); });
    try { expect(removeOwnedConfigState(dir).status).not.toBe("removed"); } finally { setUninstallStepHookForTests(undefined); }
    expect(manifest(dir).uninstallStartedAt).toEqual(expect.any(Number));
  };

  test.each(["snapshot-removed", "owner-deleted"] as const)("a rerun stopped at %s records the database its cleanup creates in a full older manifest",
    step => withHome(async dir => {
      const { beginConfigOwnershipTeardown } = await import("../../src/lib/config-ownership");
      const { withConfigMutationLockSync } = await import("../../src/config/mutation-lock");
      expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
      olderManifest(dir, true);
      expect(manifest(dir).paths).toHaveLength(1024);
      stopAt(dir, step);
      const end = beginConfigOwnershipTeardown();
      let result;
      try {
        withConfigMutationLockSync(() => undefined, dir);
        expect(existsSync(join(dir, "config-mutation.sqlite"))).toBe(true);
        expect(manifest(dir).paths).toContain("config-mutation.sqlite");
        // Only initially owned names may use the reserve.
        expect(recordOwnedConfigPath(dir, join(dir, "not-initially-owned"))).toBe(false);
        result = removeOwnedConfigState(dir);
      } finally { end(); }
      expect(result).toEqual({ status: "removed", residualPaths: [] });
      expect(existsSync(dir)).toBe(false);
    })());

  test("a rerun stopped with the owner marker kept never adopts an existing unlisted database", withHome(async dir => {
    const { beginConfigOwnershipTeardown } = await import("../../src/lib/config-ownership");
    const { withConfigMutationLockSync } = await import("../../src/config/mutation-lock");
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    olderManifest(dir, false);
    // A database an older version created without listing it.
    const db = new Database(join(dir, "config-mutation.sqlite"));
    db.exec("CREATE TABLE kept (id INTEGER)");
    db.close();
    stopAt(dir, "snapshot-removed");
    expect(existsSync(join(dir, ".opencodex-owner.json"))).toBe(true);
    const end = beginConfigOwnershipTeardown();
    let result;
    try {
      withConfigMutationLockSync(() => undefined, dir);
      expect(manifest(dir).paths).not.toContain("config-mutation.sqlite");
      result = removeOwnedConfigState(dir);
    } finally { end(); }
    expect(result?.status).toBe("partial");
    expect(result?.residualPaths).toContain(join(dir, "config-mutation.sqlite"));
    expect(existsSync(join(dir, "config-mutation.sqlite"))).toBe(true);
  }));

  test.skipIf(process.platform === "win32")("a listed symlink whose target is gone is removed", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "linked"))).toBe(true);
    symlinkSync(join(dirname(dir), "missing-target"), join(dir, "linked"));
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
  }));

  test("a home cached as unowned is claimed once it is empty", withHome(dir => {
    mkdirSync(dir);
    writeFileSync(join(dir, "foreign"), "x");
    expect(recordOwnedConfigPath(dir, join(dir, "early"))).toBe(false);
    removeTreeWithRetry(join(dir, "foreign"));
    expect(recordOwnedConfigPath(dir, join(dir, "later"))).toBe(true);
    expect(manifest(dir).paths).toContain("later");
  }));

  test("a first registration waits for a home another process is still creating", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    removeTreeWithRetry(join(dir, ".opencodex-owner.json"));
    // A fresh process finds the manifest without the owner marker (creation in progress) and waits
    // out the creation deadline before giving up; a lower bound on its runtime is load-independent.
    const script = "import { recordOwnedConfigPath } from " + JSON.stringify(modulePath) + ";\n"
      + "const started = performance.now();\n"
      + "const recorded = recordOwnedConfigPath(" + JSON.stringify(dir) + ", " + JSON.stringify(join(dir, "waiting")) + ");\n"
      + "console.log(JSON.stringify({ recorded, waited: performance.now() - started }));";
    const result = JSON.parse(Bun.spawnSync([process.execPath, "-e", script]).stdout.toString()) as { recorded: boolean; waited: number };
    expect(result.recorded).toBe(false);
    expect(result.waited).toBeGreaterThanOrEqual(90);
  }));
});

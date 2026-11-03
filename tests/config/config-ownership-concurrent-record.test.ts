import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONFIG_OWNERSHIP_LOCK,
  CONFIG_UNINSTALL_MANIFEST,
  ConfigOwnershipLockError,
  ConfigUninstallInProgressError,
  recordOwnedConfigPath,
  removeOwnedConfigState,
} from "../../src/lib/config-ownership";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8093: every manifest read-modify-write runs under one cross-process lock, and uninstall
// tombstones the manifest under that lock before it snapshots the paths it removes.
const modulePath = repoPath("src/lib/config-ownership.ts");
const BARRIER_MS = 20_000;
// Exit codes: 0 recorded, 2 not recorded, 3 refused by the uninstall tombstone, 1 anything else.
// With a gate, the child creates its file, announces it, and records only once the gate opens.
const childScript = (dir: string, rel: string, gate?: { ready: string; go: string }) => [
  "import { existsSync, writeFileSync } from \"node:fs\";",
  "import { ConfigUninstallInProgressError, recordOwnedConfigPath } from " + JSON.stringify(modulePath) + ";",
  "const path = " + JSON.stringify(join(dir, rel)) + ";",
  gate ? "writeFileSync(path, \"child\"); writeFileSync(" + JSON.stringify(gate.ready) + ", \"\");" : "",
  gate ? "const until = Date.now() + " + BARRIER_MS + "; while (!existsSync(" + JSON.stringify(gate.go) + ") && Date.now() < until) Bun.sleepSync(5);" : "",
  "let code = 1;",
  "try { code = recordOwnedConfigPath(" + JSON.stringify(dir) + ", path) ? 0 : 2; }",
  "catch (error) { code = error instanceof ConfigUninstallInProgressError ? 3 : 1; if (code === 1) console.error(error); }",
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

  test("an interrupted uninstall refuses registrations, cached paths included, and a rerun finishes it",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
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

  test("a registration that cannot get the lock fails without writing", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    const before = readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8");
    const release = holdLock(dir);
    try {
      expect(() => recordOwnedConfigPath(dir, join(dir, "blocked"))).toThrow(ConfigOwnershipLockError);
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

  test("a rerun finishes an uninstall that stopped after deleting the manifest", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    expect(existsSync(join(dir, CONFIG_OWNERSHIP_LOCK))).toBe(true);
    removeTreeWithRetry(join(dir, CONFIG_UNINSTALL_MANIFEST));
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
  }));

  test("leftover metadata next to any other file is still refused untouched", withHome(dir => {
    expect(recordOwnedConfigPath(dir, join(dir, "seed"))).toBe(true);
    removeTreeWithRetry(join(dir, CONFIG_UNINSTALL_MANIFEST));
    writeFileSync(join(dir, "user-notes.txt"), "keep");
    expect(removeOwnedConfigState(dir).status).toBe("refused");
    expect(existsSync(join(dir, "user-notes.txt"))).toBe(true);
    expect(existsSync(join(dir, ".opencodex-owner.json"))).toBe(true);
  }));
});

describe("upgraded homes near the manifest byte limit (#8093)", () => {
  test("an interrupted uninstall of a near-limit manifest still resumes after the tombstone",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
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
    writeFileSync(temp, "{}");
    expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(dir)).toBe(false);
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

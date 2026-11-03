import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
// Exit codes: 0 recorded, 2 not recorded, 3 refused by the uninstall tombstone, 1 anything else.
const childScript = (dir: string, rel: string, createFirst: boolean) => [
  "import { writeFileSync } from \"node:fs\";",
  "import { ConfigUninstallInProgressError, recordOwnedConfigPath } from " + JSON.stringify(modulePath) + ";",
  "const path = " + JSON.stringify(join(dir, rel)) + ";",
  createFirst ? "writeFileSync(path, \"child\");" : "",
  "let code = 1;",
  "try { code = recordOwnedConfigPath(" + JSON.stringify(dir) + ", path) ? 0 : 2; }",
  "catch (error) { code = error instanceof ConfigUninstallInProgressError ? 3 : 1; if (code === 1) console.error(error); }",
  "process.exit(code);",
].join("\n");
const spawnChild = (dir: string, rel: string, createFirst = false) =>
  Bun.spawn([process.execPath, "-e", childScript(dir, rel, createFirst)], { stderr: "pipe" });
const manifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")) as { paths: string[]; uninstallStartedAt?: number };

function holdLock(dir: string): () => void {
  const database = new Database(join(dir, CONFIG_OWNERSHIP_LOCK), { create: false, readwrite: true });
  database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  return () => { database.exec("ROLLBACK"); database.close(); };
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
    expect(Bun.spawnSync([process.execPath, "-e", childScript(dir, "other", false)]).exitCode).toBe(0);
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
    // Children create their file, then block on the held lock; uninstall contends with them.
    const release = holdLock(dir);
    let children: ReturnType<typeof spawnChild>[];
    try {
      children = names.map(name => spawnChild(dir, name, true));
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && !names.every(name => existsSync(join(dir, name)))) Bun.sleepSync(10);
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
  }));

  test("an interrupted uninstall keeps refusing registrations and a rerun finishes it",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    withHome(async dir => {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(join(dir, "config.json"), "{}");
      // "artifacts" is an initially owned path; an unwritable directory makes removal stop midway.
      mkdirSync(join(dir, "artifacts"));
      writeFileSync(join(dir, "artifacts", "image.png"), "png");
      chmodSync(join(dir, "artifacts"), 0o500);
      try {
        expect(removeOwnedConfigState(dir).status).toBe("partial");
      } finally { chmodSync(join(dir, "artifacts"), 0o700); }
      const tombstoned = readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8");
      expect(manifest(dir).uninstallStartedAt).toEqual(expect.any(Number));

      expect(await spawnChild(dir, "late").exited).toBe(3);
      expect(() => recordOwnedConfigPath(dir, join(dir, "late-local"))).toThrow(ConfigUninstallInProgressError);
      expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")).toBe(tombstoned);

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

  test("refusing a home without ownership metadata creates no lock file", withHome(dir => {
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), "{}");
    expect(removeOwnedConfigState(dir).status).toBe("refused");
    expect(existsSync(join(dir, CONFIG_OWNERSHIP_LOCK))).toBe(false);
  }));
});

import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeConfigOwnership, removeOwnedConfigState } from "../../src/lib/config-ownership";
import { helperPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { copySeededAffinityHome, removeSeededAffinityTemplates } from "../helpers/codex-affinity-seed";

afterAll(removeSeededAffinityTemplates);

const names = ["codex-affinity.sqlite", "codex-affinity.sqlite-journal", "codex-affinity.sqlite-wal", "codex-affinity.sqlite-shm"];
const memoryOnly = "Codex affinity persistence unavailable; continuing in memory.";
// Windows creates a file THROUGH a link at its name; other platforms refuse. Workers that may create
// the store run with that behaviour emulated, so a create-before-check mistake fails everywhere.
const windowsCreate = process.platform === "win32" ? [] : ["--preload", helperPath("windows-link-create-preload.ts")];
function spawnWorker(home: string, file: string, action: string, preload: string[] = []) {
  return Bun.spawnSync([process.execPath, ...preload, helperPath(file), action], { env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
}
function worker(home: string, file: string, action: string): any {
  const result = spawnWorker(home, file, action);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.length ? JSON.parse(result.stdout.toString()) : undefined;
}
function seed(home: string) { return copySeededAffinityHome("write", home); }
function matrix(home: string, action: string) { return worker(home, "codex-affinity-matrix-worker.ts", action); }
function inHome(fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-extra-"));
  try { fn(home); } finally { if (existsSync(home)) removeTreeWithRetry(home); }
}

test("a restored shared binding survives a model eligibility detour", () => inHome(home => {
  expect(seed(home).account).toBe("a");
  matrix(home, "shared-write");
  const result = matrix(home, "model-excluded");
  expect(result.before).toBe("a");
  expect(result.result).toMatchObject({ status: "selected", accountId: "b" });
  expect(result.shared).toBe("a");
}));

test("fresh and existing owned homes list and remove all affinity paths", () => inHome(home => {
  expect(initializeConfigOwnership(home)).toBe(true);
  let manifest = JSON.parse(readFileSync(join(home, ".opencodex-uninstall.json"), "utf8"));
  for (const name of names) expect(manifest.paths).toContain(name);
  // Simulate an older owned home that predates these paths.
  manifest.paths = manifest.paths.filter((path: string) => !names.includes(path));
  writeFileSync(join(home, ".opencodex-uninstall.json"), JSON.stringify(manifest));
  matrix(home, "probe");
  manifest = JSON.parse(readFileSync(join(home, ".opencodex-uninstall.json"), "utf8"));
  for (const name of names) expect(manifest.paths).toContain(name);
  for (const name of names.slice(1)) writeFileSync(join(home, name), "sidecar");
  expect(removeOwnedConfigState(home).status).toBe("removed");
  for (const name of names) expect(existsSync(join(home, name))).toBe(false);
}));

function probeMemoryOnly(home: string): void {
  const result = spawnWorker(home, "codex-affinity-matrix-worker.ts", "probe", windowsCreate);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toContain(memoryOnly);
}

for (const kind of ["symlink", "symlink-existing", "hardlink", "junction", "directory"] as const) {
  test(`${kind} at the database path disables the store`, () => inHome(home => {
    expect(initializeConfigOwnership(home)).toBe(true);
    const file = join(home, names[0]!);
    const target = join(home, "outside-target");
    if (kind === "symlink") symlinkSync(target, file);
    else if (kind === "symlink-existing" || kind === "hardlink") {
      writeFileSync(target, "outside");
      if (kind === "hardlink") linkSync(target, file);
      else symlinkSync(target, file);
    } else if (kind === "junction") {
      // A junction on Windows, a directory symlink elsewhere.
      mkdirSync(target);
      symlinkSync(target, file, "junction");
    } else mkdirSync(file);
    probeMemoryOnly(home);
    if (kind === "symlink") expect(existsSync(target)).toBe(false);
    else if (kind === "junction") expect(readdirSync(target)).toEqual([]);
    else if (kind !== "directory") expect(readFileSync(target, "utf8")).toBe("outside");
  }));
}

for (const name of names.slice(1)) {
  test(`a link at ${name} disables the store before anything is created`, () => inHome(home => {
    expect(initializeConfigOwnership(home)).toBe(true);
    const target = join(home, "outside-target");
    symlinkSync(target, join(home, name));
    probeMemoryOnly(home);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(home, names[0]!))).toBe(false);
  }));
}

test("a journal link planted while the store is open is refused before the next write", () => inHome(home => {
  seed(home);
  const file = join(home, names[0]!);
  expect(matrix(home, "late-journal-link")).toEqual({ planted: true });
  expect(existsSync(join(home, "outside-target"))).toBe(false);
  // With the link gone, the database itself shows the release never committed clean, so the next
  // owner discards the rows rather than restoring a pin the refused write could not record.
  unlinkSync(`${file}-journal`);
  const db = new Database(file, { readonly: true });
  expect(db.query("SELECT value FROM meta WHERE name='clean'").get()).toEqual({ value: 0 });
  db.close();
  expect(matrix(home, "read").before).toBeUndefined();
}));

test("a hard link added to the open database stops every later write", () => inHome(home => {
  seed(home);
  const file = join(home, names[0]!);
  expect(matrix(home, "late-hard-link")).toEqual({ planted: true });
  const db = new Database(file, { readonly: true });
  // Neither the bind to b nor the clean release reached the twice-linked file.
  expect(db.query("SELECT DISTINCT account_id FROM threads").all()).toEqual([{ account_id: "a" }]);
  expect(db.query("SELECT value FROM meta WHERE name='clean'").get()).toEqual({ value: 0 });
  db.close();
}));

test("a hot rollback journal from an interrupted writer is recovered, not refused", () => inHome(home => {
  seed(home);
  const file = join(home, names[0]!);
  // A one-page cache makes the open transaction spill into the database file, so the killed writer
  // leaves a hot journal that SQLite must roll back on the next open.
  const writer = Bun.spawnSync([process.execPath, "-e", [
    "const { Database } = require('bun:sqlite');",
    "const db = new Database(process.argv[1]);",
    "db.exec('PRAGMA cache_size=1; BEGIN');",
    "const insert = db.query(\"INSERT INTO issuers VALUES (?, 'b', 'fence', 0)\");",
    "for (let i = 0; i < 4000; i++) insert.run('interrupted-' + i);",
    "process.kill(process.pid, 'SIGKILL');",
  ].join(" "), file], { stdout: "pipe", stderr: "pipe" });
  expect(writer.exitCode).not.toBe(0);
  expect(lstatSync(`${file}-journal`).isFile()).toBe(true);
  expect(matrix(home, "read").before).toBe("a");
  const db = new Database(file, { readonly: true });
  expect(db.query("SELECT count(*) AS n FROM issuers WHERE row_key LIKE 'interrupted-%'").get()).toEqual({ n: 0 });
  db.close();
}));

test("a home without an ownership manifest still persists affinity and gains no manifest", () => inHome(home => {
  writeFileSync(join(home, "unowned"), "keep");
  expect(worker(home, "codex-affinity-restart-worker.ts", "write").account).toBe("a");
  expect(existsSync(join(home, names[0]!))).toBe(true);
  expect(worker(home, "codex-affinity-restart-worker.ts", "read").account).toBe("a");
  expect(existsSync(join(home, ".opencodex-uninstall.json"))).toBe(false);
}));

for (const kind of ["extra-table", "wrong-column"] as const) {
  test(`v1 ${kind} is rejected without changing schema, metadata, or rows`, () => inHome(home => {
    seed(home);
    const file = join(home, names[0]!);
    let db = new Database(file);
    if (kind === "extra-table") db.exec("CREATE TABLE extra(value TEXT)");
    else db.exec("ALTER TABLE threads RENAME COLUMN account_id TO wrong_account");
    db.close();
    const before = readFileSync(file);
    matrix(home, "probe");
    expect(readFileSync(file).equals(before)).toBe(true);
  }));
}

test("pruning keeps newest issuers and prioritizes ordinary bindings over detours", () => inHome(home => {
  seed(home);
  const file = join(home, names[0]!);
  let db = new Database(file);
  const now = Date.now() - 5000;
  db.exec("BEGIN");
  const insertThread = db.query("INSERT INTO threads VALUES (?, ?, 'a', 'fence', ?, ?)");
  const insertIssuer = db.query("INSERT INTO issuers VALUES (?, 'a', 'fence', ?)");
  for (let i = 0; i < 2052; i++) {
    const key = `bulk-${String(i).padStart(4, "0")}`;
    insertThread.run(key, i < 4 ? "model-detour:shared:gpt-test" : "shared", now, now + i);
    insertIssuer.run(key, now + i);
  }
  db.exec("COMMIT"); db.close();
  matrix(home, "probe");
  db = new Database(file);
  expect(db.query("SELECT count(*) AS n FROM threads").get()).toEqual({ n: 2048 });
  expect(db.query("SELECT count(*) AS n FROM issuers").get()).toEqual({ n: 2048 });
  expect(db.query("SELECT count(*) AS n FROM threads WHERE scope LIKE 'model-detour:%'").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM issuers WHERE row_key LIKE 'bulk-%' AND row_key < 'bulk-0004'").get()).toEqual({ n: 0 });
  db.close();
}));

test("oversized database is disabled without changing its bytes", () => inHome(home => {
  seed(home);
  const file = join(home, names[0]!);
  truncateSync(file, 8 * 1024 * 1024 + 1);
  const before = readFileSync(file);
  matrix(home, "probe");
  expect(readFileSync(file).equals(before)).toBe(true);
}));

test("open immediately removes expired and excess rows", () => inHome(home => {
  seed(home);
  const db = new Database(join(home, names[0]!));
  const now = Date.now() - 5000;
  db.exec("BEGIN");
  const thread = db.query("INSERT INTO threads VALUES (?, 'shared', 'a', 'fence', ?, ?)");
  const issuer = db.query("INSERT INTO issuers VALUES (?, 'a', 'fence', ?)");
  for (let i = 0; i < 2050; i++) { thread.run(`bulk-${i}`, now, now); issuer.run(`bulk-${i}`, now); }
  thread.run("expired", now - 90_000_000, now - 90_000_000);
  issuer.run("expired", now - 90_000_000);
  db.exec("COMMIT"); db.close();
  const result = matrix(home, "open-count");
  expect(result.threads.n).toBe(2048);
  expect(result.issuers.n).toBe(2048);
  expect(result.expired.n).toBe(0);
}));

test("hourly timer prunes an idle open store", () => inHome(home => {
  seed(home);
  const result = matrix(home, "hourly");
  expect(result.scheduled).toBe(true);
  expect(result.threads.n).toBe(0);
  expect(result.issuers.n).toBe(0);
}));

test("adoption enumerates every stored scope for a row key", () => inHome(home => {
  seed(home);
  const db = new Database(join(home, names[0]!));
  const row = db.query("SELECT row_key, account_id, fence, created_at, last_used_at FROM threads LIMIT 1").get() as { row_key: string; account_id: string; fence: string; created_at: number; last_used_at: number };
  const insert = db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < 80; i++) insert.run(row.row_key, `model-detour:shared:model-${i}`, row.account_id, row.fence, row.created_at, row.last_used_at - i - 1);
  db.close();
  const scopes = matrix(home, "scopes").scopes;
  expect(scopes).toHaveLength(81);
  expect(scopes).toContain("model-detour:shared:model-0");
  expect(scopes).toContain("model-detour:shared:model-79");
}));

test("restoration accepts a 512-byte model component and rejects 513 bytes", () => inHome(home => {
  seed(home);
  const file = join(home, names[0]!);
  let db = new Database(file);
  const row = db.query("SELECT row_key, account_id, fence, created_at, last_used_at FROM threads LIMIT 1").get() as { row_key: string; account_id: string; fence: string; created_at: number; last_used_at: number };
  const insert = db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)");
  const valid = `model-detour:shared:${"é".repeat(256)}`;
  const invalid = `${valid}x`;
  insert.run(row.row_key, valid, row.account_id, row.fence, row.created_at, row.last_used_at);
  insert.run(row.row_key, invalid, row.account_id, row.fence, row.created_at, row.last_used_at);
  db.close();
  const result = matrix(home, "scopes");
  expect(result.scopes).toContain(valid);
  expect(result.scopes).not.toContain(invalid);
  db = new Database(file);
  expect(db.query("SELECT count(*) AS n FROM threads WHERE scope=?").get(invalid)).toEqual({ n: 0 });
  db.close();
}));

test("home switching drops pending writes and does not carry recorded anchors across homes", () => inHome(homeA => inHome(homeB => {
  worker(homeA, "codex-affinity-restart-worker.ts", "write");
  worker(homeB, "codex-affinity-restart-worker.ts", "write");
  const secrets: unknown[] = [];
  for (const home of [homeA, homeB]) {
    const db = new Database(join(home, names[0]!));
    secrets.push((db.query("SELECT value FROM meta WHERE name='secret'").get() as { value: unknown }).value);
    db.exec("DELETE FROM threads; DELETE FROM issuers");
    db.close();
  }
  expect(secrets[0]).not.toEqual(secrets[1]);
  const result = Bun.spawnSync([process.execPath, helperPath("codex-affinity-home-switch-worker.ts"), homeB], {
    env: { ...process.env, OPENCODEX_HOME: homeA, CODEX_HOME: homeA }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ first: "a", rowsB: 1, restoredB: "a" });
})));

for (const mutation of ["bind", "delete", "issuer"] as const) {
  test(`late ${mutation} after release is what a reacquired lease persists`, () => inHome(home => {
    seed(home);
    // Live memory keeps the change made while no lease was held. The database could not record it,
    // so the next lease clears it: a restart restores nothing rather than the replaced row.
    const expected = {
      bind: { pin: "b", issuer: "a", restoredPin: undefined, restoredIssuer: undefined },
      delete: { pin: undefined, issuer: "a", restoredPin: undefined, restoredIssuer: undefined },
      issuer: { pin: "a", issuer: "b", restoredPin: undefined, restoredIssuer: undefined },
    }[mutation];
    expect(matrix(home, `late-${mutation}`)).toEqual({ pin: expected.pin, issuer: expected.issuer });
    const restored = matrix(home, "read");
    expect(restored.before).toBe(expected.restoredPin);
    expect(restored.issuer).toBe(expected.restoredIssuer);
  }));
}

for (const path of ["responses", "compact"] as const) {
  for (const issuer of ["unknown", "known"] as const) {
    test(`${path} handler ${issuer} restored issuer with an uploaded file`, () => inHome(home => {
      if (path === "responses" && issuer === "unknown") worker(home, "codex-affinity-restart-worker.ts", "unknown-write");
      else copySeededAffinityHome(issuer === "unknown" ? "unknown-write" : "write", home);
      const result = worker(home, "codex-affinity-handler-worker.ts", path);
      expect(result.status).toBe(400);
      expect(result.bodies).toHaveLength(0);
    }));
  }
}

for (const path of ["responses", "compact"] as const) {
  test(`${path} permits a file for the same stored account with unknown issuer`, () => inHome(home => {
    copySeededAffinityHome("unknown-write", home);
    const result = Bun.spawnSync([process.execPath, helperPath("codex-affinity-handler-worker.ts"), path, "same"], { env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const parsed = JSON.parse(result.stdout.toString());
    expect(parsed.status, parsed.responseBody).toBe(200);
    expect(parsed.bodies).toHaveLength(1);
  }));
}

test("touching an unknown restored issuer extends its durable lifetime", () => inHome(home => {
  worker(home, "codex-affinity-restart-worker.ts", "unknown-write");
  expect(worker(home, "codex-affinity-restart-worker.ts", "touch-unknown").issuer).toBe("__unknown_codex_conversation_state_issuer__");
  expect(worker(home, "codex-affinity-restart-worker.ts", "read-unknown").issuer).toBe("__unknown_codex_conversation_state_issuer__");
}));

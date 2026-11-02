import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeConfigOwnership, removeOwnedConfigState } from "../../src/lib/config-ownership";
import { helperPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const names = ["codex-affinity.sqlite", "codex-affinity.sqlite-journal", "codex-affinity.sqlite-wal", "codex-affinity.sqlite-shm"];
function worker(home: string, file: string, action: string): any {
  const result = Bun.spawnSync([process.execPath, helperPath(file), action], { env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.length ? JSON.parse(result.stdout.toString()) : undefined;
}
function seed(home: string) { return worker(home, "codex-affinity-restart-worker.ts", "write"); }
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

for (const kind of ["symlink", "directory"] as const) {
  test(`${kind} at the database path disables the store`, () => inHome(home => {
    expect(initializeConfigOwnership(home)).toBe(true);
    const target = join(home, "outside-target");
    if (kind === "symlink") symlinkSync(target, join(home, names[0]!));
    else mkdirSync(join(home, names[0]!));
    matrix(home, "probe");
    expect(existsSync(target)).toBe(false);
  }));
}

test("a home without an ownership manifest still persists affinity and gains no manifest", () => inHome(home => {
  writeFileSync(join(home, "unowned"), "keep");
  expect(seed(home).account).toBe("a");
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
  seed(homeA); seed(homeB);
  for (const home of [homeA, homeB]) {
    const db = new Database(join(home, names[0]!));
    db.exec("DELETE FROM threads; DELETE FROM issuers");
    db.close();
  }
  const result = Bun.spawnSync([process.execPath, helperPath("codex-affinity-home-switch-worker.ts"), homeB], {
    env: { ...process.env, OPENCODEX_HOME: homeA, CODEX_HOME: homeA }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ first: "a", rowsB: 1, restoredB: "a" });
})));

for (const mutation of ["bind", "delete", "issuer"] as const) {
  test(`late ${mutation} after release is what a reacquired lease persists`, () => inHome(home => {
    seed(home);
    // Memory wins when a later lease opens the database: the change made while no lease was held is
    // what this process routes with, and a restart must restore exactly that, never the older row.
    const expected = {
      bind: { pin: "b", issuer: "a", restoredPin: "b", restoredIssuer: "a" },
      delete: { pin: undefined, issuer: "a", restoredPin: undefined, restoredIssuer: "a" },
      issuer: { pin: "a", issuer: "b", restoredPin: "a", restoredIssuer: "__unknown_codex_conversation_state_issuer__" },
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
      worker(home, "codex-affinity-restart-worker.ts", issuer === "unknown" ? "unknown-write" : "write");
      const result = worker(home, "codex-affinity-handler-worker.ts", path);
      expect(result.status).toBe(400);
      expect(result.bodies).toHaveLength(0);
    }));
  }
}

for (const path of ["responses", "compact"] as const) {
  test(`${path} permits a file for the same stored account with unknown issuer`, () => inHome(home => {
    worker(home, "codex-affinity-restart-worker.ts", "unknown-write");
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

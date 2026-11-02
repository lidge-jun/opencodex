import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

test("an unowned nonempty home cannot create an affinity database", () => inHome(home => {
  writeFileSync(join(home, "unowned"), "keep");
  matrix(home, "probe");
  expect(existsSync(join(home, names[0]!))).toBe(false);
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

for (const path of ["responses", "compact"] as const) {
  for (const issuer of ["unknown", "known"] as const) {
    test(`${path} handler ${issuer} restored issuer with an uploaded file`, () => inHome(home => {
      worker(home, "codex-affinity-restart-worker.ts", issuer === "unknown" ? "unknown-write" : "write");
      const result = worker(home, "codex-affinity-handler-worker.ts", path);
      if (issuer === "known") {
        expect(result.status).toBe(400);
        expect(result.bodies).toHaveLength(0);
      } else {
        expect(result.status, result.responseBody).toBe(200);
        expect(result.bodies).toHaveLength(1);
        expect(result.bodies[0].previous_response_id).toBeUndefined();
        expect(result.turnStates).toEqual([null]);
        expect(result.bodies[0].client_metadata?.["x-codex-turn-state"]).toBeUndefined();
        expect(JSON.stringify(result.bodies[0].input)).toContain("file-test");
      }
    }));
  }
}

test("touching an unknown restored issuer extends its durable lifetime", () => inHome(home => {
  worker(home, "codex-affinity-restart-worker.ts", "unknown-write");
  expect(worker(home, "codex-affinity-restart-worker.ts", "touch-unknown").issuer).toBe("__unknown_codex_conversation_state_issuer__");
  expect(worker(home, "codex-affinity-restart-worker.ts", "read-unknown").issuer).toBe("__unknown_codex_conversation_state_issuer__");
}));

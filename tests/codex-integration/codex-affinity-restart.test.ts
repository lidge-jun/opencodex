import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { helperPath } from "../helpers/repo-root";
import { Database } from "bun:sqlite";
import { removeOwnedConfigState } from "../../src/lib/config-ownership";
import { copySeededAffinityHome, removeSeededAffinityTemplates } from "../helpers/codex-affinity-seed";

afterAll(removeSeededAffinityTemplates);

function run(home: string, mode: string) {
  const result = Bun.spawnSync([process.execPath, helperPath("codex-affinity-restart-worker.ts"), mode], {
    env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("pool binding and issuer survive a clean restart", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-restart-"));
  try {
    const first = run(home, "write");
    expect(first.exit, first.stderr).toBe(0);
    const second = run(home, "read");
    expect(second.exit, second.stderr).toBe(0);
    const before = JSON.parse(first.stdout);
    const after = JSON.parse(second.stdout);
    expect(after.account).toBe(before.account);
    expect(after.issuer).toBe(before.account);
    expect(after.sameScrub).toBe(false);
    expect(after.otherScrub).toBe(true);
    expect(after.otherFileRefusal).toBe(400);
  } finally { removeTreeWithRetry(home); }
});

test("an unclean owner discards persisted affinity", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-crash-"));
  try {
    const first = run(home, "crash");
    expect(first.exit).not.toBe(0);
    const second = run(home, "read");
    expect(second.exit, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).issuer).toBeUndefined();
    expect(JSON.parse(second.stdout).account).toBe("b");
  } finally { removeTreeWithRetry(home); }
});

test("unknown issuer scrubs continuation and refuses files on account moves", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-unknown-"));
  try {
    const first = run(home, "unknown-write");
    expect(first.exit, first.stderr).toBe(0);
    const second = run(home, "unknown-read");
    expect(second.exit, second.stderr).toBe(0);
    const result = JSON.parse(second.stdout);
    expect(result.issuer).toBe("__unknown_codex_conversation_state_issuer__");
    expect(result.sameScrub).toBe(true);
    expect(result.fileRefusal).toBeUndefined();
    expect(result.retryRefusal).toBe(400);
    expect(result.otherFileRefusal).toBe(400);
  } finally { removeTreeWithRetry(home); }
});

test("a replacement identity invalidates the old pin and makes its issuer unknown", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-relogin-"));
  try {
    const first = run(home, "relogin");
    expect(first.exit, first.stderr).toBe(0);
    const second = run(home, "read");
    expect(second.exit, second.stderr).toBe(0);
    const before = JSON.parse(first.stdout);
    const after = JSON.parse(second.stdout);
    expect(after.account).not.toBe(before.account);
    expect(after.issuer).toBe("__unknown_codex_conversation_state_issuer__");
  } finally { removeTreeWithRetry(home); }
});

function matrix(home: string, action: string) {
  const result = Bun.spawnSync([process.execPath, helperPath("codex-affinity-matrix-worker.ts"), action], {
    env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.length ? JSON.parse(result.stdout.toString()) : undefined;
}

function withSeededHome(body: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-matrix-"));
  try {
    expect(copySeededAffinityHome("write", home).account).toBe("a");
    body(home);
  } finally { removeTreeWithRetry(home); }
}

test("a copied seed home keeps its ownership and restores like a seeded one", () => {
  const homeA = mkdtempSync(join(tmpdir(), "ocx-affinity-copy-"));
  const homeB = mkdtempSync(join(tmpdir(), "ocx-affinity-copy-"));
  try {
    copySeededAffinityHome("write", homeA);
    for (const name of [".opencodex-owner.json", ".opencodex-uninstall.json"]) {
      expect(JSON.parse(readFileSync(join(homeA, name), "utf8")).root).toBe(realpathSync.native(homeA));
    }
    expect(matrix(homeA, "read").before).toBe("a");
    copySeededAffinityHome("write", homeB);
    expect(removeOwnedConfigState(homeB).status).toBe("removed");
  } finally { removeTreeWithRetry(homeA); removeTreeWithRetry(homeB); }
});

for (const action of ["delete", "delete-account", "clear-account", "clear"] as const) {
  test(`${action} reconciles a restored pin before its first lookup`, () => withSeededHome(home => {
    const result = matrix(home, action);
    expect(result.before).toBeUndefined();
    expect(result.selected).toBe("b");
    expect(result.rows).toBe(0);
    expect(result.issuer).toBe(action === "clear" ? undefined : "a");
  }));
}

test("a new bind and issuer replace unadopted restored rows", () => {
  withSeededHome(home => {
    const result = matrix(home, "bind");
    expect(result.before).toBe("b");
    expect(result.selected).toBe("b");
    expect(result.rows).toBe(0);
  });
  withSeededHome(home => expect(matrix(home, "issuer").issuer).toBe("b"));
  withSeededHome(home => {
    const result = matrix(home, "clear-issuer");
    expect(result.issuer).toBeUndefined();
    expect(result.issuers).toBe(0);
  });
});

for (const action of ["removed", "relogin", "paused", "plan", "reauth", "cooldown"] as const) {
  test(`${action} makes the resolver leave a restored account`, () => withSeededHome(home => {
    const result = matrix(home, action);
    expect(result.selected).toBe("b");
    expect(result.rows).toBe(0);
  }));
}

test("transient failure detours a restored pin while retaining its owner", () => withSeededHome(home => {
  const result = matrix(home, "transient");
  expect(result.before).toBe("a");
  expect(result.selected).toBe("b");
  expect(result.after).toBe("a");
}));

test("a legacy account without an identity falls back and removes its stored row", () => withSeededHome(home => {
  const file = join(home, "codex-accounts.json");
  const records = JSON.parse(readFileSync(file, "utf8"));
  delete records.a.quotaHistoryIdentity;
  writeFileSync(file, JSON.stringify(records));
  const result = matrix(home, "read");
  expect(result.before).toBeUndefined();
  expect(result.selected).toBe("b");
  expect(result.rows).toBe(0);
}));

// Offsets, not timestamps: each case computes its time when it runs, because the subprocess
// workers can take long enough on a loaded host for a load-time "future" value to become past.
for (const [label, offsetMs] of [["expired", -25 * 60 * 60_000], ["future", 60 * 60_000]] as const) {
  test(`${label} restored pin falls back and is deleted`, () => withSeededHome(home => {
    const timestamp = Date.now() + offsetMs;
    const db = new Database(join(home, "codex-affinity.sqlite"));
    db.query("UPDATE threads SET last_used_at=?").run(timestamp);
    db.close();
    const result = matrix(home, "read");
    expect(result.before).toBeUndefined();
    expect(result.selected).toBe("b");
    expect(result.rows).toBe(0);
  }));
}

test("main account bindings and issuers do not survive release", () => withSeededHome(home => {
  matrix(home, "write-main");
  const result = matrix(home, "read");
  expect(result.before).toBeUndefined();
  expect(result.issuer).toBeUndefined();
}));

test("session-less depth one restores while depth two places independently", () => {
  for (const [action, expected] of [["depth-one", "a"], ["depth-two", "b"]] as const) withSeededHome(home => {
    matrix(home, "depth-write");
    expect(matrix(home, action).selected).toBe(expected);
  });
});

test("passive affinity operations leave a populated database untouched under a lease", () => withSeededHome(home => {
  expect(matrix(home, "passive").unchanged).toBe(true);
  expect(matrix(home, "read").before).toBe("a");
}));

test.skipIf(process.platform !== "win32")("Windows releases affinity handles before directory removal", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-windows-"));
  const first = run(home, "write");
  expect(first.exit, first.stderr).toBe(0);
  removeTreeWithRetry(home);
});

for (const action of ["race-relogin", "race-delete-add"] as const) {
  test(`${action} invalidates a binding written before the identity changed`, () => withSeededHome(home => {
    matrix(home, action);
    const result = matrix(home, "read");
    expect(result.before).toBeUndefined();
    expect(result.selected).toBe("b");
  }));
}

for (const action of ["race-refresh", "race-external"] as const) {
  test(`${action} keeps a binding when the account identity is unchanged`, () => withSeededHome(home => {
    matrix(home, action);
    expect(matrix(home, "read").before).toBe("a");
  }));
}

test("issuer completion with a superseded credential restores as unknown", () => withSeededHome(home => {
  matrix(home, "race-issuer");
  expect(matrix(home, "read").issuer).toBe("__unknown_codex_conversation_state_issuer__");
}));

test("only the last lease flushes and a token from the prior lease is refused", () => withSeededHome(home => {
  // Remove the seeded binding through the public API before testing a pending bind.
  matrix(home, "clear");
  const db = new Database(join(home, "codex-affinity.sqlite"));
  db.exec("DELETE FROM threads");
  db.close();
  expect(matrix(home, "lease")).toEqual({ before: 0, rejected: true });
  expect(matrix(home, "read").before).toBe("a");
}));

test("resolver reuse persists its updated last-used time on release", () => withSeededHome(home => {
  const db = new Database(join(home, "codex-affinity.sqlite"));
  db.query("UPDATE threads SET last_used_at=?").run(Date.now() - 10_000);
  db.close();
  const result = matrix(home, "touch");
  expect(result.row.timestamp).toBe(result.timestamp);
}));

for (const [label, offsetMs] of [["expired", -25 * 60 * 60_000], ["future", 60 * 60_000]] as const) {
  test(`${label} issuer is removed when read`, () => withSeededHome(home => {
    const timestamp = Date.now() + offsetMs;
    const db = new Database(join(home, "codex-affinity.sqlite"));
    db.query("UPDATE issuers SET last_used_at=?").run(timestamp);
    db.close();
    const result = matrix(home, "read");
    expect(result.issuer).toBeUndefined();
    expect(result.issuers).toBe(0);
  }));
}

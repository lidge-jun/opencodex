import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "bun:sqlite";

import {
  beginCodexTransition,
  openCodexCoordinatorTransaction,
  readCodexTransitionState,
  updateCodexHistoryTransition,
} from "../src/codex/transition-state";
import { resolveCodexHistoryTransition } from "../src/codex/history-transition";
import { historyBackupPathFor } from "../src/codex/history-provider";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";

let codexHome = "";
let opencodexHome = "";
let coordinatorPath = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ocx-transition-state-codex-home-"));
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-transition-state-opencodex-home-"));
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  coordinatorPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${coordinatorPath}${suffix}`, { force: true });
  }
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(opencodexHome, { recursive: true, force: true });
});

function transition(txId: string) {
  return {
    txId,
    direction: "apply" as const,
    authoritySnapshotId: `authority-${txId}`,
    nextRetryAt: "2026-08-04T12:00:00.000Z",
  };
}

test("resolve persists zero counts only for a verified-noop proof", () => {
  const started = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-proof"),
  );
  expect(started.kind).toBe("updated");
  resolveCodexHistoryTransition(
    { nativeGeneration: 1, currentTxId: "tx-proof" },
    {
      kind: "converged", rows: 0, files: 0,
      proof: {
        kind: "verified-noop", pendingRows: 0, backupEntries: 0,
        canonicalStateDbPath: join(codexHome, "state_5.sqlite"), stateDbPresent: true,
        canonicalBackupPath: historyBackupPathFor(join(codexHome, "state_5.sqlite")), backupPresent: false,
      },
    },
  );
  const after = readCodexTransitionState();
  expect(after.kind).toBe("ready");
  if (after.kind === "ready") {
    expect(after.state.history).toMatchObject({
      status: "converged", txId: "tx-proof", pendingRows: 0, backupEntries: 0,
    });
  }
});

test("ordinary zero-mutation convergence keeps history counts unknown", () => {
  const started = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-ordinary"),
  );
  expect(started.kind).toBe("updated");
  resolveCodexHistoryTransition(
    { nativeGeneration: 1, currentTxId: "tx-ordinary" },
    { kind: "converged", rows: 0, files: 0 },
  );
  const after = readCodexTransitionState();
  expect(after.kind).toBe("ready");
  if (after.kind === "ready") {
    expect(after.state.history.pendingRows).toBeNull();
    expect(after.state.history.backupEntries).toBeNull();
  }
});

test("a missing database initializes only from clean integration and native state", () => {
  expect(readCodexTransitionState()).toEqual({
    kind: "ready",
    state: {
      nativeGeneration: 0,
      currentTxId: null,
      history: {
        status: "unknown",
        attempts: 0,
        nextRetryAt: null,
        txId: null,
        pendingRows: null,
        backupEntries: null,
      },
      historySchedule: null,
    },
  });

  const result = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-winner"),
  );
  expect(result.kind).toBe("updated");
  if (result.kind === "updated") {
    expect(result.state.nativeGeneration).toBe(1);
    expect(result.state.currentTxId).toBe("tx-winner");
    expect(result.state.historySchedule?.direction).toBe("apply");
  }
});

/**
 * The missing-row review fixture carried the old JSON pair and history. Before
 * this regression, initialization silently replaced that evidence with
 * `{0,null}`, making an interrupted legacy transition look clean.
 */
test("a missing database with legacy JSON transition fields is legacy-ambiguous", () => {
  const integrations = join(opencodexHome, "integrations");
  mkdirSync(integrations, { recursive: true });
  writeFileSync(join(integrations, "codex.json"), JSON.stringify({
    version: 1,
    nativeGeneration: 7,
    currentTxId: "legacy",
    history: { status: "pending", txId: "legacy" },
  }));

  expect(readCodexTransitionState()).toEqual({
    kind: "legacy-ambiguous",
    message: "A missing coordinator row cannot be initialized over legacy or invalid Codex integration state.",
  });
});

/**
 * Absence of the coordinator file also said nothing about native bytes. The
 * exact marker-owned routing grammar is authoritative residue and must prevent
 * a fresh zero row from claiming no transition ever happened.
 */
test("a missing database with native routed residue is legacy-ambiguous", () => {
  writeFileSync(join(codexHome, "config.toml"), [
    "# Auto-injected by opencodex",
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    "",
  ].join("\n"));

  expect(readCodexTransitionState()).toEqual({
    kind: "legacy-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});

test("an existing database without the singleton row is legacy-ambiguous", () => {
  const database = new Database(coordinatorPath, { create: true });
  database.exec("PRAGMA user_version = 1");
  database.close();
  if (process.platform !== "win32") chmodSync(coordinatorPath, 0o600);

  expect(readCodexTransitionState()).toEqual({
    kind: "legacy-ambiguous",
    message: "The existing coordinator database has no authoritative transition row.",
  });
});

test("a zero-row conditional update reports conflict and preserves the winner", () => {
  const winner = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-newer"),
  );
  expect(winner.kind).toBe("updated");

  const stale = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-stale"),
  );
  expect(stale.kind).toBe("conflict");
  if (stale.kind === "conflict") {
    expect(stale.current.currentTxId).toBe("tx-newer");
    expect(stale.current.historySchedule?.authoritySnapshotId).toBe("authority-tx-newer");
  }
  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 1, currentTxId: "tx-newer" },
  });
});

/**
 * The C-phase review found the conflict tests PARTIAL: every stale caller they
 * exercised disagreed on BOTH halves of the expected pair, so dropping either
 * `native_generation = ?` or `current_tx_id IS ?` from the CAS predicate left
 * them green. A CAS on a two-part version has to be proven one part at a time.
 */
test("a native CAS with a matching generation but the wrong txId still conflicts", () => {
  expect(beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-a"),
  ).kind).toBe("updated");
  expect(beginCodexTransition(
    { nativeGeneration: 1, currentTxId: "tx-a" },
    transition("tx-b"),
  ).kind).toBe("updated");

  // Generation 2 is current, so only the txId half disagrees. Removing the
  // `current_tx_id IS ?` predicate makes this succeed.
  const wrongTxId = beginCodexTransition(
    { nativeGeneration: 2, currentTxId: "tx-a" },
    transition("tx-forged"),
  );
  expect(wrongTxId.kind).toBe("conflict");

  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 2, currentTxId: "tx-b" },
  });
});

for (const generation of [1, 2, 4]) {
  test(`a native CAS at generation ${generation} never treats a null txId as a wildcard`, () => {
    let currentTxId: string | null = null;
    for (let nextGeneration = 1; nextGeneration <= generation; nextGeneration++) {
      const nextTxId = `tx-current-${nextGeneration}`;
      expect(beginCodexTransition(
        { nativeGeneration: nextGeneration - 1, currentTxId },
        transition(nextTxId),
      ).kind).toBe("updated");
      currentTxId = nextTxId;
    }

    const nullTxId = beginCodexTransition(
      { nativeGeneration: generation, currentTxId: null },
      transition("tx-forged"),
    );
    expect(nullTxId.kind).toBe("conflict");

    expect(readCodexTransitionState()).toMatchObject({
      kind: "ready",
      state: { nativeGeneration: generation, currentTxId },
    });
  });
}

test("a native CAS with a matching txId but the wrong generation still conflicts", () => {
  expect(beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-a"),
  ).kind).toBe("updated");
  expect(beginCodexTransition(
    { nativeGeneration: 1, currentTxId: "tx-a" },
    transition("tx-b"),
  ).kind).toBe("updated");

  // `tx-b` really is the current txId, so only the generation half disagrees.
  // Removing the `native_generation = ?` predicate makes this succeed.
  const wrongGeneration = beginCodexTransition(
    { nativeGeneration: 1, currentTxId: "tx-b" },
    transition("tx-forged"),
  );
  expect(wrongGeneration.kind).toBe("conflict");

  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 2, currentTxId: "tx-b" },
  });
});

test("a positive generation cannot carry a null direction", () => {
  expect(beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-direction"),
  ).kind).toBe("updated");

  const database = new Database(coordinatorPath);
  try {
    expect(() => database.run(
      "UPDATE codex_transition_state SET history_direction = NULL WHERE singleton = 1",
    )).toThrow();
    expect(database.query<{ history_direction: string }, []>(
      "SELECT history_direction FROM codex_transition_state WHERE singleton = 1",
    ).get()?.history_direction).toBe("apply");
  } finally {
    database.close();
  }
});

/**
 * The test above proves the SQL CHECK constraint and nothing else. The row
 * validator in `rowToState` is a SECOND, independent gate that exists because a
 * database written by another build, an older schema, or a hand-edit can hold a
 * row the current CHECKs would have rejected at write time. Dropping the
 * validator left the suite green, so it is proven here directly: the row is
 * corrupted with the constraints switched off, and the reader must still refuse.
 */
test("the row validator refuses a malformed row the CHECK constraints never saw", () => {
  expect(beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-validator"),
  ).kind).toBe("updated");

  const database = new Database(coordinatorPath);
  try {
    // `ignore_check_constraints` lets a write land that the schema forbids,
    // which is exactly the state a foreign writer can leave behind.
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.run(
      "UPDATE codex_transition_state SET history_direction = NULL WHERE singleton = 1",
    );
    expect(database.query<{ history_direction: string | null }, []>(
      "SELECT history_direction FROM codex_transition_state WHERE singleton = 1",
    ).get()?.history_direction).toBeNull();
  } finally {
    database.close();
  }

  // The CHECK did not stop it; the validator must.
  expect(readCodexTransitionState()).toEqual({ kind: "unavailable", reason: "database" });
});

for (const direction of ["sideways", "reverse", "forward", "APPLY", ""] as const) {
  test(`the row validator refuses unknown history direction ${JSON.stringify(direction)}`, () => {
    expect(beginCodexTransition(
      { nativeGeneration: 0, currentTxId: null },
      transition("tx-unknown-direction"),
    ).kind).toBe("updated");

    const database = new Database(coordinatorPath);
    try {
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.query(
        "UPDATE codex_transition_state SET history_direction = ? WHERE singleton = 1",
      ).run(direction);
      expect(database.query<{ history_direction: string }, []>(
        "SELECT history_direction FROM codex_transition_state WHERE singleton = 1",
      ).get()?.history_direction).toBe(direction);
    } finally {
      database.close();
    }

    expect(readCodexTransitionState()).toEqual({ kind: "unavailable", reason: "database" });
  });
}

test("the row validator refuses every whitespace-only txId", () => {
  expect(beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-blank"),
  ).kind).toBe("updated");

  const trimRemovedCodePoints: Array<[string, string]> = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
    const character = String.fromCodePoint(codePoint);
    if (character.trim() === "") {
      trimRemovedCodePoints.push([
        `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
        character,
      ]);
    }
  }
  expect(trimRemovedCodePoints.some(([, value]) => value === "\r")).toBe(true);

  for (const [label, txId] of trimRemovedCodePoints) {
    const database = new Database(coordinatorPath);
    try {
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.query(
        "UPDATE codex_transition_state SET current_tx_id = ?, history_tx_id = ? WHERE singleton = 1",
      ).run(txId, txId);
    } finally {
      database.close();
    }

    // The public reader re-resolves Windows identity through PowerShell for
    // every code point, which makes this exhaustive loop exceed its timeout.
    // Opening the already-resolved path still runs the same row validator.
    expect(() => openCodexCoordinatorTransaction(coordinatorPath), label)
      .toThrow("The positive coordinator row lacks its complete history schedule.");
  }
}, 15_000);

/**
 * A capability backed by a nominal transaction is not opaque if its caller can
 * simply open another connection. The C-phase review found the old test only
 * checked a boolean in one object and never exercised SQLite exclusion.
 */
test("the opaque coordinator capability cannot reach a second connection", () => {
  expect(readCodexTransitionState().kind).toBe("ready");
  const controller = openCodexCoordinatorTransaction(coordinatorPath);
  try {
    expect(() => {
      const second = openCodexCoordinatorTransaction(coordinatorPath);
      second.close();
    }).toThrow();
  } finally {
    controller.close();
  }
});

/**
 * SQLite exclusion is only half of "opaque". The other half is that the
 * capability object itself must not hand its caller a usable handle on the open
 * connection: a caller who can reach the `Database` can write the native pair
 * behind the CAS, on the very transaction that is supposed to serialize it.
 * The previous test passed while the connection was reachable.
 */
test("the opaque capability never exposes a reachable database handle", () => {
  expect(readCodexTransitionState().kind).toBe("ready");
  const controller = openCodexCoordinatorTransaction(coordinatorPath);
  try {
    const ownKeys = Reflect.ownKeys(controller.capability);
    const stringKeys = ownKeys.filter((key): key is string => typeof key === "string");
    const symbolKeys = ownKeys.filter((key): key is symbol => typeof key === "symbol");

    expect(stringKeys).toEqual(["beginTransition"]);
    expect(symbolKeys).toHaveLength(1);
    expect(symbolKeys[0]?.description).toBe("CodexCoordinatorTransaction");

    for (const key of ownKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(controller.capability, key);
      expect(descriptor).toBeDefined();
      expect("get" in descriptor!).toBe(false);
      expect("set" in descriptor!).toBe(false);
    }
    expect(Reflect.getOwnPropertyDescriptor(controller.capability, "beginTransition")).toEqual({
      value: expect.any(Function),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Reflect.getOwnPropertyDescriptor(controller.capability, symbolKeys[0]!)).toEqual({
      value: true,
      writable: true,
      enumerable: true,
      configurable: true,
    });

    let prototype: object | null = controller.capability;
    while (prototype !== null) {
      for (const key of Reflect.ownKeys(prototype)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key)!;
        const intrinsicLegacyProtoAccessor = prototype === Object.prototype && key === "__proto__";
        if (!intrinsicLegacyProtoAccessor) {
          expect(descriptor.get, `getter ${String(key)} on capability prototype chain`).toBeUndefined();
          expect(descriptor.set, `setter ${String(key)} on capability prototype chain`).toBeUndefined();
        }
      }
      prototype = Reflect.getPrototypeOf(prototype);
    }

    const reachable = new Set<unknown>();
    const walk = (value: unknown, depth: number): void => {
      if (depth > 4 || value === null || reachable.has(value)) return;
      const kind = typeof value;
      if (kind !== "object" && kind !== "function") return;
      reachable.add(value);
      for (const key of Reflect.ownKeys(value as object)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value as object, key);
        if (descriptor && "value" in descriptor) walk(descriptor.value, depth + 1);
      }
      walk(Reflect.getPrototypeOf(value as object), depth + 1);
    };
    walk(controller.capability, 0);

    for (const value of reachable) {
      expect(value).not.toBeInstanceOf(Database);
    }
  } finally {
    controller.close();
  }
});

test("the opaque coordinator capability is one-shot", () => {
  const controller = openCodexCoordinatorTransaction(coordinatorPath);
  try {
    const expectation = controller.expectation();
    const expected = { nativeGeneration: expectation.nativeBefore, currentTxId: null };
    const next = transition(expectation.txId);
    expect(controller.capability.beginTransition(expected, next).kind).toBe("updated");
    expect(() => controller.capability.beginTransition(expected, next))
      .toThrow("already been consumed");
    controller.assertPublished(expectation);
    controller.commit();
  } finally {
    controller.close();
  }
});

/**
 * The C-phase reviewer found this by running the code rather than the suite:
 * `new Database(path, { create: false })` is SQLITE_MISUSE on Bun 1.3.14
 * because the flags name no read mode. Every history update therefore failed
 * before reaching its conditional UPDATE and returned `unavailable/database`,
 * so no terminal history state could ever be recorded.
 *
 * Eighteen tests were green while that was true, because none of them called
 * `updateCodexHistoryTransition` at all. That is the gap this file closes.
 */
test("a history transition update reaches its conditional UPDATE and records terminal state", () => {
  const started = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-history"),
  );
  expect(started.kind).toBe("updated");

  const updated = updateCodexHistoryTransition(
    { nativeGeneration: 1, currentTxId: "tx-history" },
    {
      status: "converged",
      attempts: 1,
      nextRetryAt: null,
      txId: "tx-history",
      pendingRows: 0,
      backupEntries: 0,
    },
  );

  // Before the fix this was `unavailable` with reason `database`, every time.
  expect(updated.kind).toBe("updated");

  const after = readCodexTransitionState();
  expect(after.kind).toBe("ready");
  if (after.kind === "ready") {
    expect(after.state.history.status).toBe("converged");
    expect(after.state.history.txId).toBe("tx-history");
    expect(after.state.history.pendingRows).toBe(0);
  }
});

/**
 * The overtaking case the substrate exists for: a stale Worker finishing after
 * a newer transition committed must NOT publish its terminal state over the
 * winner's schedule. It must report conflict.
 */
test("a stale history update conflicts and leaves the newer transition's schedule intact", () => {
  beginCodexTransition({ nativeGeneration: 0, currentTxId: null }, transition("tx-a"));
  const newer = beginCodexTransition(
    { nativeGeneration: 1, currentTxId: "tx-a" },
    { ...transition("tx-b"), direction: "remove" as const },
  );
  expect(newer.kind).toBe("updated");

  const stale = updateCodexHistoryTransition(
    { nativeGeneration: 1, currentTxId: "tx-a" },
    {
      status: "converged",
      attempts: 1,
      nextRetryAt: null,
      txId: "tx-a",
      pendingRows: 0,
      backupEntries: 0,
    },
  );
  expect(stale.kind).toBe("conflict");

  const after = readCodexTransitionState();
  expect(after.kind).toBe("ready");
  if (after.kind === "ready") {
    expect(after.state.currentTxId).toBe("tx-b");
    expect(after.state.historySchedule?.direction).toBe("remove");
    // The stale worker must not have published its own terminal status.
    expect(after.state.history.status).not.toBe("converged");
  }
});

/**
 * Reviewer finding: the happy-path update test still passed with the
 * conditional WHERE removed, so it did not prove the update is conditional.
 * This one fails the moment the guard stops matching on BOTH columns.
 */
test("a begin whose txId matches but whose generation does not is rejected", () => {
  beginCodexTransition({ nativeGeneration: 0, currentTxId: null }, transition("tx-one"));

  const wrongGeneration = beginCodexTransition(
    { nativeGeneration: 7, currentTxId: "tx-one" },
    transition("tx-two"),
  );
  expect(wrongGeneration.kind).toBe("conflict");

  const after = readCodexTransitionState();
  expect(after.kind).toBe("ready");
  if (after.kind === "ready") expect(after.state.currentTxId).toBe("tx-one");
});

/**
 * A permissive coordinator is never LEFT permissive.
 *
 * The flake fix relaxed WHEN mode is judged, not whether. Two processes reaching
 * first use together both see ENOENT, and the loser can lstat the winner's file
 * before its chmod lands; refusing there reported `unsafe-path` for what was only
 * a schedule (1-in-12 on a 16-core box). Ownership is still decided before the
 * open — a file owned by somebody else is not a race and waiting cannot make it
 * ours — while mode is narrowed once below the open and judged on the settled
 * state.
 *
 * This asserts the outcome that matters and can actually be observed: after a
 * read, the file is owner-only again. Removing the narrowing leaves it 0644 and
 * turns this red.
 */
test.skipIf(process.platform === "win32")(
  "a coordinator found group-readable is narrowed back to owner-only",
  () => {
    expect(readCodexTransitionState().kind).toBe("ready");

    chmodSync(coordinatorPath, 0o644);
    expect(statSync(coordinatorPath).mode & 0o777).toBe(0o644);

    const read = readCodexTransitionState();
    expect(read.kind).toBe("ready");
    expect(statSync(coordinatorPath).mode & 0o777).toBe(0o600);
  },
);

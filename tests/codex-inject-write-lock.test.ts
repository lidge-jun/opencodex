/**
 * The production call edge, proven by contention rather than by a spy.
 *
 * `withCodexWriteLock` shipped with zero production callers, and every test it
 * had exercised it with a fabricated snapshot. The property that matters is not
 * "the lock function was invoked" — a pass-through mock satisfies that — but
 * that two real processes running the real injection cannot both write.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import {
  boundProvenanceEntries,
  CODEX_PROVENANCE_MAX_BYTES,
  CODEX_PROVENANCE_MAX_TRANSACTIONS,
  STABLE_ZERO_BYTE_COORDINATOR_AGE_MS,
} from "../src/codex/inject-coordination";
import { SPAWN_BUDGET_MS } from "./helpers/test-budget";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = join(import.meta.dir, "..");
const CHILD = join(repoRoot, "tests", "helpers", "codex-inject-race-child.ts");
const LOCK_CHILD = join(repoRoot, "tests", "helpers", "codex-write-lock-child.ts");
// Leave teardown and assertion headroom inside the surrounding test budget. A real
// Bun child can take several seconds to start and settle on a loaded Windows runner.
const SPAWN_TIMEOUT_MS = SPAWN_BUDGET_MS - 5_000;
// The contender uses a much shorter bound because production contention is
// fail-fast (lockTimeoutMs=0). Keep the holder alive well beyond that bound so a
// slow child launch cannot turn an intended busy result into a post-release apply.
const CONTENTION_CHILD_TIMEOUT_MS = 10_000;
const CONTENTION_HOLDER_MARGIN_MS = 5_000;
const CONTENTION_HOLD_MS = SPAWN_TIMEOUT_MS - CONTENTION_HOLDER_MARGIN_MS;

setDefaultTimeout(SPAWN_BUDGET_MS);

let root = "";
let codexHome = "";
let opencodexHome = "";
const cleanup: string[] = [];
const coordinatorCleanup: string[] = [];

function seedNative(): void {
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
}

function runChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = SPAWN_TIMEOUT_MS,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    windowsHide: true,
  });
}

function childDiagnostics(result: ReturnType<typeof spawnSync>): string {
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const error = result.error instanceof Error
    ? result.error.message
    : result.error
      ? String(result.error)
      : "";
  return [
    `status=${String(result.status)}`,
    `signal=${String(result.signal)}`,
    error ? `error=${error}` : "",
    `stdout=${stdout || "<empty>"}`,
    `stderr=${stderr || "<empty>"}`,
  ].filter(Boolean).join("; ");
}

function requireChildSuccess(result: ReturnType<typeof spawnSync>, label: string): string {
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed: ${childDiagnostics(result)}`);
  }
  return String(result.stdout ?? "");
}

function parseChildJson<T>(result: ReturnType<typeof spawnSync>, label: string): T {
  const stdout = requireChildSuccess(result, label);
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) {
    throw new Error(`${label} produced no JSON output: ${childDiagnostics(result)}`);
  }
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} produced invalid JSON (${reason}): ${childDiagnostics(result)}`);
  }
}

function runInject(
  port: number,
  lockTimeoutMs = 0,
  timeoutMs = SPAWN_TIMEOUT_MS,
): { success: boolean; status?: "skipped"; retryable: boolean; message: string } {
  return parseChildJson<{ success: boolean; status?: "skipped"; retryable: boolean; message: string }>(
    runChild([CHILD], {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
      OCX_INJECT_RACE_PAYLOAD: JSON.stringify({ port, lockTimeoutMs }),
    }, timeoutMs),
    `inject child (port=${port})`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-inject-race-"));
  cleanup.push(root);
  codexHome = join(root, ".codex");
  opencodexHome = join(root, ".opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(opencodexHome, { recursive: true });
});

afterEach(() => {
  while (coordinatorCleanup.length) {
    const path = coordinatorCleanup.pop()!;
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
  while (cleanup.length) {
    const dir = cleanup.pop()!;
    // `force` covers a missing path, not a locked one: a child that is still exiting
    // can hold a coordinator file open for a few milliseconds, and Windows answers
    // EBUSY rather than unlinking underneath it. Retry briefly, then leave the temp
    // directory to the OS -- failing teardown would blame whichever test ran here.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        removeTreeWithRetry(dir);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
        if (attempt < 4) Bun.sleepSync(50 * (attempt + 1));
      }
    }
  }
});

describe("the lock is on the production path", () => {
  test("a persisted OFF observed under N skips the real injector without writing", () => {
    seedNative();
    const configPath = join(codexHome, "config.toml");
    const before = readFileSync(configPath, "utf8");
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      providers: {}, defaultProvider: "openai", clientIntegrations: { codex: false },
    }));

    const result = runInject(20200);

    expect(result).toMatchObject({ success: true, status: "skipped" });
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("a clean first apply coordinates and records a transition", () => {
    seedNative();
    mkdirSync(join(opencodexHome, "integrations"), { recursive: true });
    writeFileSync(join(opencodexHome, "integrations", "codex.json"), JSON.stringify({
      version: 1,
      futureSection: { owner: "newer-writer" },
    }));
    const result = runInject(10100);
    expect(result.success).toBeTrue();

    // The row is the proof that the lock ran, not that the function was called.
    const state = runChild(["--eval", `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `], {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
    });
    const row = parseChildJson<{
      kind?: string;
      state?: { nativeGeneration?: number; currentTxId?: string | null };
    }>(state, "read transition state after clean apply");
    expect(row.kind).toBe("ready");
    expect(row.state?.nativeGeneration).toBeGreaterThan(0);
    // Guessing null passes on a fresh machine and fails on a real one, so the
    // id being present is part of the claim.
    expect(typeof row.state?.currentTxId).toBe("string");

    const record = JSON.parse(
      readFileSync(join(opencodexHome, "integrations", "codex.json"), "utf8"),
    ) as {
      futureSection?: unknown;
      provenance?: { entries?: Array<{ txId?: string; artifact?: { kind?: string } }> };
    };
    expect(record.futureSection).toEqual({ owner: "newer-writer" });
    const matching = record.provenance?.entries?.filter(entry =>
      entry.txId === row.state?.currentTxId) ?? [];
    expect(matching.map(entry => entry.artifact?.kind).sort()).toEqual([
      "config",
      "generated-profile",
      "injection-journal",
    ]);
  });

  test("a provenance append failure does not undo an admitted transaction", () => {
    seedNative();
    expect(runInject(10100).success).toBeTrue();

    const readTransition = () => parseChildJson<{
      kind?: string;
      state?: { nativeGeneration?: number; currentTxId?: string | null };
    }>(runChild(["--eval", `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `], {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
    }), "read transition state around failed provenance append");
    const admitted = readTransition();
    expect(typeof admitted.state?.currentTxId).toBe("string");

    writeFileSync(join(opencodexHome, "integrations", "codex.json"), "{ malformed", "utf8");
    const append = parseChildJson<{ kind?: string }>(runChild(["--eval", `
      const {
        captureCodexPreImages,
        recordCodexNativeTransactionProvenance,
      } = require("./src/codex/inject-coordination");
      console.log(JSON.stringify(recordCodexNativeTransactionProvenance(
        captureCodexPreImages(),
        process.env.OCX_TEST_TX_ID,
      )));
    `], {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
      OCX_TEST_TX_ID: admitted.state!.currentTxId!,
    }), "failed provenance append");
    expect(append.kind).toBe("invalid");
    expect(readTransition()).toEqual(admitted);
    expect(readFileSync(join(opencodexHome, "integrations", "codex.json"), "utf8"))
      .toBe("{ malformed");
  });

  test("irreducible ledger extension overhead refuses the append without rewriting", () => {
    seedNative();
    const recordPath = join(opencodexHome, "integrations", "codex.json");
    mkdirSync(join(opencodexHome, "integrations"), { recursive: true });
    writeFileSync(recordPath, JSON.stringify({
      version: 1,
      provenance: {
        futureLedger: "x".repeat(CODEX_PROVENANCE_MAX_BYTES + 1),
        entries: [{
          artifact: { kind: "config" },
          baseline: { kind: "absent" },
          postImage: null,
          txId: "tx-existing",
          at: "2026-08-30T00:00:00.000Z",
        }],
      },
    }));
    const before = readFileSync(recordPath, "utf8");

    const result = parseChildJson<{ kind?: string; entryCount?: number }>(
      runChild(["--eval", `
        const {
          captureCodexPreImages,
          recordCodexNativeTransactionProvenance,
        } = require("./src/codex/inject-coordination");
        const result = recordCodexNativeTransactionProvenance(
          captureCodexPreImages(),
          "tx-must-not-append",
        );
        console.log(JSON.stringify({
          kind: result.kind,
          entryCount: result.kind === "updated"
            ? result.record.provenance?.entries?.length
            : undefined,
        }));
      `], {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENCODEX_HOME: opencodexHome,
      }),
      "irreducible ledger extension overhead",
    );

    expect(result.kind).toBe("updated");
    expect(result.entryCount).toBe(1);
    // Exact bytes, not just semantics: a no-op must not pretty-print/rewrite the oversized file.
    expect(readFileSync(recordPath, "utf8")).toBe(before);
  });

  /**
   * The contention proof. A real second process holds N through the production
   * lock module while a real injection runs; the injection must report busy and
   * must not have written its candidate bytes.
   */
  test("a held lock makes real injection report busy and write nothing", async () => {
    seedNative();
    // Establish the coordinator first: a clean home has no row, and the holder
    // needs one to contend over.
    expect(runInject(10100).success).toBeTrue();
    const afterFirst = readFileSync(join(codexHome, "config.toml"), "utf-8");

    const holdMarker = join(root, "held");
    const releaseMarker = join(root, "release");
    const holder = Bun.spawn([process.execPath, LOCK_CHILD], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENCODEX_HOME: opencodexHome,
        OCX_LOCK_CHILD_PAYLOAD: JSON.stringify({
          timeoutMs: 5_000,
          holdMarker,
          releaseMarker,
          // Keep a slow Windows contender from outliving the hold, while staying
          // below the 40s child bound and the 45s test budget.
          holdMs: CONTENTION_HOLD_MS,
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    let primaryFailed = false;
    let primaryError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(holdMarker) && Date.now() < deadline) {
        requireChildSuccess(runChild(["--eval", "Bun.sleepSync(20)"], process.env), "hold-marker wait child");
      }
      expect(existsSync(holdMarker)).toBeTrue();

      // PROCESS-UNIQUE bytes: a different port means different candidate bytes, so
      // the loser's work is identifiable rather than assumed.
      const contender = runInject(20200, 0, CONTENTION_CHILD_TIMEOUT_MS);

      expect(contender.success).toBeFalse();
      expect(contender.retryable).toBeTrue();
      // Its bytes are absent: the file still names the first winner's port.
      const finalConfig = readFileSync(join(codexHome, "config.toml"), "utf-8");
      expect(finalConfig).not.toContain("20200");
      expect(finalConfig).toBe(afterFirst);
    } catch (error) {
      // Preserve the first assertion/helper failure after cleanup completes.
      primaryFailed = true;
      primaryError = error;
    } finally {
      try {
        writeFileSync(releaseMarker, "go");
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
      try {
        // Always release and reap the holder, including when marker wait,
        // contender startup, or an assertion fails. Otherwise teardown races a
        // live child that still owns the coordinator database on Windows.
        await holder.exited;
      } catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupError = error;
        }
      }
    }
    if (primaryFailed) throw primaryError;
    if (cleanupFailed) throw cleanupError;
  }, SPAWN_BUDGET_MS);
});

describe("pre-substrate home adoption", () => {
  /**
   * Every install predating this substrate is routed with no coordinator row,
   * and that row cannot be created over routed bytes. Gating on the lock there
   * would have broken re-injection for the entire installed base.
   */
  test("a pre-substrate routed home adopts and records a coordinated transition", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "opencodex"',
      'model = "gpt-5.5"',
      "",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"));

    const result = runInject(10100);
    expect(result.success).toBeTrue();
    expect(readFileSync(join(codexHome, "config.toml"), "utf-8")).toContain("openai_base_url");
    const coordinatorPath = resolveCodexCoordinatorDatabasePath(
      resolveEffectiveUserIdentity(),
      realpathSync.native(codexHome),
    );
    coordinatorCleanup.push(coordinatorPath);
    expect(existsSync(coordinatorPath)).toBeTrue();
    const state = parseChildJson<{
      kind: string;
      state?: { nativeGeneration: number; history: { status: string } };
    }>(runChild(["--eval", `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `], {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
    }), "read adopted transition");
    expect(state).toMatchObject({ kind: "ready", state: { nativeGeneration: 1 } });
  });

  test("a zero-byte coordinator remnant does not wedge a pre-substrate routed home", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "opencodex"',
      'model = "gpt-5.5"',
      "",
      "[model_providers.opencodex]",
      'name = "OpenCodex Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"));
    const coordinatorPath = resolveCodexCoordinatorDatabasePath(
      resolveEffectiveUserIdentity(),
      realpathSync.native(codexHome),
    );
    coordinatorCleanup.push(coordinatorPath);
    writeFileSync(coordinatorPath, "");
    if (process.platform !== "win32") chmodSync(coordinatorPath, 0o600);
    // Fresh zero-byte files remain on the coordinated path because they may
    // belong to a live SQLite creator. This fixture represents an old remnant.
    Bun.sleepSync(STABLE_ZERO_BYTE_COORDINATOR_AGE_MS + 100);

    const result = runInject(10100);

    expect(result.success).toBeTrue();
    expect(readFileSync(join(codexHome, "config.toml"), "utf-8")).toContain("openai_base_url");
    expect(readFileSync(coordinatorPath)).toHaveLength(0);
  });
});

describe("the transition is resolved, not left pending", () => {
  /**
   * `updateCodexHistoryTransition` had no production caller, so every completed
   * or skipped job left the row permanently `pending` — a transition published
   * and never resolved. The row must now show what the job actually did.
   */
  test("a completed apply leaves a converged row, not a pending one", () => {
    seedNative();
    expect(runInject(10100).success).toBeTrue();

    const state = runChild(["--eval", `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `], {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
    });
    const row = parseChildJson<{
      kind?: string;
      state?: { history?: { status?: string } };
    }>(state, "read transition state after completed apply");
    expect(row.kind).toBe("ready");
    expect(row.state?.history?.status).not.toBe("pending");
  });

  test("an opted-out apply records the opt-out as converged, not blocked", () => {
    seedNative();
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
      syncResumeHistory: false,
    }, null, 2));

    const result = runChild([CHILD], {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
      OCX_INJECT_RACE_PAYLOAD: JSON.stringify({ port: 10100, lockTimeoutMs: 0 }),
    });
    requireChildSuccess(result, "opted-out inject child");

    const state = runChild(["--eval", `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `], {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
    });
    const row = parseChildJson<{
      kind?: string;
      state?: { history?: { status?: string; attempts?: number } };
    }>(state, "read transition state after opted-out apply");
    expect(row.kind).toBe("ready");
    // Opt-out is a completed decision, not a failure: converged, never blocked,
    // and never left pending for a job that chose to do nothing.
    expect(row.state?.history?.status).toBe("converged");
  });
});

/**
 * The ledger is evidence, not an archive (#2622).
 *
 * Each admitted transaction appends three entries, and a `present` baseline carries the artifact's
 * exact bytes as base64 — a 25 KB `config.toml` is roughly 100 KB per transaction. Unbounded, a
 * machine that syncs on every start grows this file forever, and since the record is re-read and
 * re-serialized on every append, the cost is quadratic rather than merely large.
 */
describe("provenance ledger bound", () => {
  const entry = (txId: string, kind: "config" | "generated-profile" | "injection-journal") => ({
    artifact: { kind },
    baseline: { kind: "absent" as const },
    postImage: null,
    txId,
    at: "2026-08-26T00:00:00.000Z",
  });
  const transaction = (txId: string) => [
    entry(txId, "config"),
    entry(txId, "generated-profile"),
    entry(txId, "injection-journal"),
  ];

  test("keeps the newest transactions and drops the oldest whole", () => {
    const entries = Array.from({ length: 20 }, (_, i) => transaction(`tx-${i}`)).flat();
    const bounded = boundProvenanceEntries(entries, 16);

    const kept = [...new Set(bounded.map(e => e.txId))];
    expect(kept).toHaveLength(16);
    expect(kept[0]).toBe("tx-4");
    expect(kept.at(-1)).toBe("tx-19");
    // Whole transactions only. A half-trimmed transaction would claim it touched two artifacts
    // when it touched three, which reads as complete and is worse than dropping it.
    for (const txId of kept) {
      expect(bounded.filter(e => e.txId === txId)).toHaveLength(3);
    }
  });

  test("a ledger within the window is returned unchanged", () => {
    const entries = Array.from({ length: 16 }, (_, i) => transaction(`tx-${i}`)).flat();
    expect(boundProvenanceEntries(entries, 16)).toBe(entries);
  });

  test("an oversized baseline is omitted whole rather than amplified into the record", () => {
    // The native artifacts sit outside this proxy's trust boundary, so a `config.toml` grown to
    // an arbitrary size would otherwise be copied into the record as base64 and re-serialized on
    // every append — the transaction window alone does not bound that.
    const huge = transaction("tx-huge");
    huge[0] = {
      ...huge[0]!,
      baseline: {
        kind: "present" as const,
        sha256: "0".repeat(64),
        bytesBase64: "A".repeat(CODEX_PROVENANCE_MAX_BYTES + 1),
      },
    };
    // The baseline-size prefilter must reject this transaction before JSON.stringify reaches
    // the tripwire. Only one sibling is oversized; all three must still be omitted together.
    Object.defineProperty(huge[0]!, "toJSON", {
      value: () => {
        throw new Error("oversized transaction was serialized");
      },
    });
    const entries = [...transaction("tx-small"), ...huge];

    const bounded = boundProvenanceEntries(entries, 16);

    expect(bounded.map(e => e.txId)).toEqual(["tx-small", "tx-small", "tx-small"]);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf-8"))
      .toBeLessThanOrEqual(CODEX_PROVENANCE_MAX_BYTES);
  });

  test("backfills the transaction window after an oversized newest transaction is skipped", () => {
    const maxBytes = 64 * 1024;
    const oversized = transaction("tx-16");
    oversized[0] = {
      ...oversized[0]!,
      baseline: {
        kind: "present" as const,
        sha256: "0".repeat(64),
        bytesBase64: "A".repeat(maxBytes + 1),
      },
    };
    const entries = [
      ...Array.from({ length: 16 }, (_, i) => transaction(`tx-${i}`)).flat(),
      ...oversized,
    ];

    const bounded = boundProvenanceEntries(entries, 16, maxBytes);
    const kept = [...new Set(bounded.map(entry => entry.txId))];

    expect(kept).toEqual(Array.from({ length: 16 }, (_, i) => `tx-${i}`));
    for (const txId of kept) expect(bounded.filter(entry => entry.txId === txId)).toHaveLength(3);
  });

  test("the byte ceiling drops whole transactions, oldest first", () => {
    const padded = (txId: string) => transaction(txId).map(entry => ({
      ...entry,
      baseline: {
        kind: "present" as const,
        sha256: "0".repeat(64),
        bytesBase64: "A".repeat(Math.floor(CODEX_PROVENANCE_MAX_BYTES / 4)),
      },
    }));
    const entries = Array.from({ length: 4 }, (_, i) => padded(`tx-${i}`)).flat();

    const bounded = boundProvenanceEntries(entries, 16);
    const kept = [...new Set(bounded.map(e => e.txId))];

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(4);
    // Newest survive; the dropped ones are the oldest, and each survivor is whole.
    expect(kept.at(-1)).toBe("tx-3");
    for (const txId of kept) expect(bounded.filter(e => e.txId === txId)).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf-8"))
      .toBeLessThanOrEqual(CODEX_PROVENANCE_MAX_BYTES);
  });

  test("the ceiling measures structured extensions in the pretty-printed record shape", () => {
    const extended = (txId: string) => transaction(txId).map((entry, index) => ({
      ...entry,
      // Integration records preserve unknown structured fields. Compact JSON can fit while the
      // writer's two-space indentation does not, so the bound must use the actual write shape.
      extension: index === 0
        ? { rows: Array.from({ length: 400 }, () => ({ left: "x", right: "y" })) }
        : undefined,
    }));
    const entries = [...extended("tx-old"), ...extended("tx-new")];
    const oneTransactionBytes = Buffer.byteLength(`${JSON.stringify({
      version: 1,
      provenance: { entries: extended("tx-new") },
    }, null, 2)}\n`, "utf-8");
    const bothCompactBytes = Buffer.byteLength(JSON.stringify(entries), "utf-8");
    const bothPrettyBytes = Buffer.byteLength(`${JSON.stringify({
      version: 1,
      provenance: { entries },
    }, null, 2)}\n`, "utf-8");
    const maxBytes = Math.max(oneTransactionBytes, bothCompactBytes);

    expect(bothPrettyBytes).toBeGreaterThan(maxBytes);
    const bounded = boundProvenanceEntries(entries, 16, maxBytes);

    expect([...new Set(bounded.map(entry => entry.txId))]).toEqual(["tx-new"]);
  });

  test("unknown ledger extensions consume the same byte budget as entries", () => {
    const entries = [...transaction("tx-old"), ...transaction("tx-new")];
    const ledger = {
      entries,
      futureLedger: {
        rows: Array.from({ length: 200 }, () => ({ left: "x", right: "y" })),
      },
    };
    const writeBytes = (candidate: readonly (typeof entries)[number][]) =>
      Buffer.byteLength(`${JSON.stringify({
        version: 1,
        provenance: { ...ledger, entries: candidate },
      }, null, 2)}\n`, "utf-8");
    const newest = transaction("tx-new");
    const maxBytes = writeBytes(newest);

    expect(writeBytes(entries)).toBeGreaterThan(maxBytes);
    const bounded = boundProvenanceEntries(entries, 16, maxBytes, ledger);

    expect([...new Set(bounded.map(entry => entry.txId))]).toEqual(["tx-new"]);
    expect(writeBytes(bounded)).toBeLessThanOrEqual(maxBytes);
  });

  test("a full window of ordinary transactions is still kept whole", () => {
    // The ceiling exists to refuse pathological artifacts, not to shrink the window above it.
    // This pins the two together: the 25 KB `config.toml` the window comment describes measures
    // about 100 KiB per transaction, so a full window is roughly 1.6 MiB and must survive intact.
    const ordinary = Buffer.from("x".repeat(25 * 1024)).toString("base64");
    const entries = Array.from(
      { length: CODEX_PROVENANCE_MAX_TRANSACTIONS },
      (_, i) => transaction(`tx-${i}`).map(entry => ({
        ...entry,
        baseline: { kind: "present" as const, sha256: "0".repeat(64), bytesBase64: ordinary },
        postImage: "0".repeat(64),
      })),
    ).flat();

    const bounded = boundProvenanceEntries(entries);

    expect(bounded).toBe(entries);
    expect(new Set(bounded.map(e => e.txId)).size).toBe(CODEX_PROVENANCE_MAX_TRANSACTIONS);
    expect(bounded).toHaveLength(entries.length);
  });
});

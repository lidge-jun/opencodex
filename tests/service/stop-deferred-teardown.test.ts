import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopProxyGracefully } from "../../src/lib/process-control";
import { performStopTeardown } from "../../src/server/stop-teardown";
import type { CodexNativeRestoreResult } from "../../src/codex/inject";
import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../../src/update/stop-contract.mjs";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath, repoPath } from "../helpers/repo-root";

/**
 * Behavioural cover for the deferred shared teardown (#3008).
 *
 * The wiring assertions in tests/providers/xai/grok-lifecycle.test.ts read source text, which cannot
 * tell a working deferral from a plausible-looking one. These tests call the real
 * functions: the graceful-stop client that builds the URL, the teardown decision the
 * route delegates to, and the on-disk receipts that decide whether a deferral is an owned
 * obligation or an unbacked request.
 */

const ENDPOINT = { hostname: "127.0.0.1", port: 10100 };
const FOREIGN_NONCE = "ffffffffffffffffffffffffffffffff";
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-deferred-teardown-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function restoreResult(success: boolean): CodexNativeRestoreResult {
  return {
    success,
    message: success ? "native Codex restored" : "config restore failed",
    artifacts: {
      config: { state: success ? "restored" : "failed" },
      catalog: { state: "restored" },
      history: { state: "restored" },
    },
  } as unknown as CodexNativeRestoreResult;
}

async function runParentStop(options: { receipt: boolean; response: unknown; restore: CodexNativeRestoreResult; status?: number }) {
  const child = spawnSync(process.execPath, [fixturePath("parent-stop-runner.ts")], {
    cwd: repoPath(),
    env: { ...process.env, OPENCODEX_HOME: home },
    input: JSON.stringify(options),
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.signal, child.stderr).toBeNull();
  const reportPath = join(home, "parent-stop-result.json");
  expect(existsSync(reportPath), child.stderr).toBe(true);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    calls: { killed: number; native: number; grok: number; cleared: number; exited: number };
    urls: string[]; nonce?: string; receiptExists: boolean; unexpectedIo: string[];
  };
  expect(report.unexpectedIo, child.stderr).toEqual([]);
  expect(report.urls, child.stderr).toHaveLength(1);
  return { ...report, exitCode: child.status, stderr: child.stderr };
}

describe("parent CLI shared teardown completion", () => {
  test("receipt failure and unconfirmed child teardown cause real parent restoration without a kill", async () => {
    const outcome = await runParentStop({ receipt: false,
      response: { success: false, sharedTeardown: "performed" }, restore: restoreResult(true) });
    expect(outcome.urls).toEqual(["http://127.0.0.1:10100/api/stop"]);
    expect(outcome.calls).toMatchObject({ killed: 0, exited: 1, native: 1, grok: 1, cleared: 0 });
    expect(outcome.exitCode).toBe(0);
  });

  test("a confirmed performed teardown prevents duplicate parent restoration", async () => {
    const outcome = await runParentStop({ receipt: false,
      response: { success: true, sharedTeardown: "performed" }, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ killed: 0, native: 0, grok: 0 });
    expect(outcome.exitCode).toBe(0);
  });

  test("a failed parent restoration leaves its actual receipt outstanding", async () => {
    const outcome = await runParentStop({ receipt: true,
      response: { success: false, sharedTeardown: "performed" }, restore: restoreResult(false) });
    expect(outcome.urls[0]).toContain(`teardownNonce=${outcome.nonce}`);
    expect(outcome.calls).toMatchObject({ killed: 0, native: 1, grok: 1, cleared: 0 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.receiptExists).toBe(true);
  });

  test("confirmed deferral leaves restoration and receipt discharge to the parent", async () => {
    const outcome = await runParentStop({ receipt: true,
      response: { success: true, sharedTeardown: "deferred" }, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ killed: 0, native: 1, grok: 1, cleared: 1 });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.receiptExists).toBe(false);
  });

  test("history-only parent failure preserves its distinct exit and discharges restored client state", async () => {
    const restore = { ...restoreResult(false), artifacts: {
      config: { state: "restored" }, catalog: { state: "restored" }, history: { state: "failed" },
    } } as unknown as CodexNativeRestoreResult;
    const outcome = await runParentStop({ receipt: true,
      response: { success: false, sharedTeardown: "performed" }, restore });
    expect(outcome.calls).toMatchObject({ killed: 0, native: 1, grok: 1, cleared: 1 });
    expect(outcome.exitCode).toBe(STOP_HISTORY_INCOMPLETE_EXIT_CODE);
    expect(outcome.receiptExists).toBe(false);
  });

  test("a refused stop keeps the parent from restoring or discharging its receipt", async () => {
    const outcome = await runParentStop({ receipt: true, status: 409,
      response: { success: false, message: "Run the stop outside the installed service." }, restore: restoreResult(true) });
    expect(outcome.calls).toMatchObject({ killed: 0, exited: 0, native: 0, grok: 0, cleared: 0 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.receiptExists).toBe(true);
    expect(outcome.stderr).toContain("Run the stop outside the installed service.");
  });
});

describe("stopProxyGracefully deferral flag", () => {
  test("the default stop asks for no deferral", async () => {
    const urls: string[] = [];
    await stopProxyGracefully(11, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ success: true, sharedTeardown: "performed" }), { status: 200 });
      }) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(urls).toEqual(["http://127.0.0.1:10100/api/stop"]);
  });

  test("a claimed nonce is carried in the query the route reads", async () => {
    const urls: string[] = [];
    await stopProxyGracefully(11, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ success: true, sharedTeardown: "deferred" }), { status: 200 });
      }) as typeof fetch,
      waitExit: () => true,
      env: {},
      deferSharedTeardownNonce: FOREIGN_NONCE,
    });
    expect(urls).toEqual([`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${FOREIGN_NONCE}`]);
  });

  test("the caller's endpoint snapshot is used instead of re-reading the runtime file", async () => {
    const urls: string[] = [];
    // The receipt records the endpoint the stop contacted. If this call re-read the
    // runtime record it could contact a different one, and recovery would then probe an
    // endpoint that was never stopped.
    await stopProxyGracefully(11, {
      readRuntime: () => ({ port: 19999, hostname: "127.0.0.1" }),
      runtimeEndpoint: { hostname: "127.0.0.1", port: 10100 },
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ success: true, sharedTeardown: "performed" }), { status: 200 });
      }) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(urls).toEqual(["http://127.0.0.1:10100/api/stop"]);
  });
});

describe("performStopTeardown", () => {
  test("an ordinary stop restores native Codex and strips the Grok fence", async () => {
    let restored = 0;
    let stripped = 0;
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => { stripped += 1; return { ok: true, changed: true, message: "Grok config restored" }; },
    });
    expect(restored).toBe(1);
    expect(stripped).toBe(1);
    expect(body.sharedTeardown).toBe("performed");
    expect(body.message).toContain("native Codex restored");
  });

  test("a receipt-backed deferral touches neither config and says so", async () => {
    let restored = 0;
    let stripped = 0;
    const body = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${FOREIGN_NONCE}`), {
      ownsReceipt: nonce => nonce === FOREIGN_NONCE,
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => { stripped += 1; return { ok: true, changed: true, message: "Grok config restored" }; },
    });
    expect(restored).toBe(0);
    expect(stripped).toBe(0);
    expect(body.sharedTeardown).toBe("deferred");
    expect(body.message).toContain("deferred to the stopping client");
    // The old response claimed a restore that never happened; an operator reading it
    // would believe native Codex was back while the deferral was still outstanding.
    expect(body.message).not.toContain("native Codex restored");
  });

  test("the real ownership check accepts only a nonce with a readable receipt on disk", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    let restored = 0;
    const deferred = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${claimed.nonce}`), {
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(deferred.sharedTeardown).toBe("deferred");
    expect(restored).toBe(0);

    // Another caller riding on the existence of that obligation gets nothing: it does not
    // own the nonce, so it cannot hand its teardown to anyone.
    const ridden = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${FOREIGN_NONCE}`), {
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(ridden.sharedTeardown).toBe("performed");
    expect(restored).toBe(1);
  });

  test("the query alone does not buy a deferral without a receipt", async () => {
    let restored = 0;
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop?deferSharedTeardown=1"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    // An authenticated caller that sets the flag and exits must not be able to leave
    // client config pointed at a proxy that is going away.
    expect(restored).toBe(1);
    expect(body.sharedTeardown).toBe("performed");
  });

  test("an unreadable receipt does not authorize a deferral", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    writeFileSync(mod.pendingTeardownPathFor(claimed.nonce), "{not json");
    let restored = 0;
    const body = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${claimed.nonce}`), {
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(restored).toBe(1);
    expect(body.sharedTeardown).toBe("performed");
  });

  test("a failed restore still reports failure and the remediation", async () => {
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => restoreResult(false),
      stripGrok: () => ({ ok: false, changed: false, message: "grok home is read-only" }),
    });
    expect(body.success).toBe(false);
    expect(body.message).toContain("ocx restore");
    expect(body.message).toContain("Grok config cleanup failed");
  });

  test("a Grok-only failure is not reported as a successful teardown", async () => {
    // The native restore succeeding said nothing about the fence. Deciding success from
    // the native half alone let a caller read success: true while Grok still pointed at a
    // proxy that was exiting — the previous test masked it by failing both halves.
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => restoreResult(true),
      stripGrok: () => ({ ok: false, changed: false, message: "grok home is read-only" }),
    });
    expect(body.success).toBe(false);
    expect(body.sharedTeardown).toBe("performed");
    expect(body.message).toContain("Grok fence was not removed");
    expect(body.message).toContain("ocx restore");
  });

  test("both halves succeeding is the only success", async () => {
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      ownsReceipt: () => false,
      restoreNativeCodex: async () => restoreResult(true),
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(body.success).toBe(true);
    expect(body.message).not.toContain("Grok config cleanup failed");
  });
});

describe("receipt naming is shared by both update lanes", () => {
  test("the launcher's scan and the TypeScript listing agree on what is outstanding", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const names = await import("../../src/config/pending-teardown-names.mjs");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);

    // bin/ocx.mjs runs under plain Node and cannot import the TypeScript module, so the
    // naming rule lives in one shared .mjs. Spelling it twice is exactly how the npm lane
    // ended up watching a filename that no longer existed.
    expect(names.hasPendingTeardownIn(readdirSync, home)).toBe(true);
    expect(mod.pendingTeardownOutstanding()).toBe(true);

    // The retired singleton name is not a receipt.
    expect(names.isPendingTeardownFileName("pending-teardown.json")).toBe(false);
    expect(names.isPendingTeardownFileName(`pending-teardown-${claimed.nonce}.json`)).toBe(true);
    // A quarantined receipt is no longer READ by the recovery loop...
    const quarantinedName = `pending-teardown-${claimed.nonce}.unreadable.json`;
    expect(names.isPendingTeardownFileName(quarantinedName)).toBe(false);
    // ...but it is still an obligation, so it still blocks an update.
    expect(names.isQuarantinedTeardownFileName(quarantinedName)).toBe(true);
    expect(names.isAnyTeardownObligationFileName(quarantinedName)).toBe(true);

    mod.quarantinePendingTeardown(claimed.nonce);
    expect(mod.listPendingTeardowns()).toHaveLength(0);
    // Both lanes still refuse to install over a teardown that never ran.
    expect(names.hasPendingTeardownIn(readdirSync, home)).toBe(true);
    expect(mod.pendingTeardownOutstanding()).toBe(true);
    expect(mod.listQuarantinedTeardowns()).toHaveLength(1);

    // Only a human removing the file ends the enforcement.
    rmSync(mod.listQuarantinedTeardowns()[0]!);
    expect(names.hasPendingTeardownIn(readdirSync, home)).toBe(false);
    expect(mod.pendingTeardownOutstanding()).toBe(false);
  });

  test("a scan that fails is not an empty scan", async () => {
    const names = await import("../../src/config/pending-teardown-names.mjs");
    // Only a missing home is honestly empty. Any other failure may be hiding an
    // obligation, and reporting "none" would let an update install over a teardown that
    // never ran — absence of proof is not proof of absence.
    const enoent = Object.assign(new Error("no such directory"), { code: "ENOENT" });
    expect(names.hasPendingTeardownIn(() => { throw enoent; }, home)).toBe(false);
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(names.hasPendingTeardownIn(() => { throw denied; }, home)).toBe(true);
    expect(names.hasPendingTeardownIn(() => { throw new Error("no code at all"); }, home)).toBe(true);
  });

  test("a home that cannot be scanned is its own state, not a fabricated receipt", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const previous = process.env.OPENCODEX_HOME;
    // A file where the home should be: readdir fails with ENOTDIR, which is not absence.
    const notADir = join(home, "not-a-directory");
    writeFileSync(notADir, "");
    process.env.OPENCODEX_HOME = notADir;
    try {
      const listed = mod.listPendingTeardowns();
      // handleStop must see something blocking rather than an empty set it would restore over.
      expect(listed).toHaveLength(1);
      // Not "invalid": that carries a nonce, and a synthesized one would be handed to the
      // quarantine and clear paths, which could rename or delete a real receipt.
      expect(listed[0]!.state).toBe("unscannable");
      expect(listed[0]).not.toHaveProperty("nonce");
      expect(mod.isPendingTeardownAbandoned(listed[0]!, () => false, 1)).toBe(true);
      expect(mod.pendingTeardownOutstanding()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
    }
  });
});

describe("endpoint provenance", () => {
  test("a guessed endpoint is recorded as such and is not exact evidence", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const guessed = mod.claimPendingTeardown({ hostname: "127.0.0.1", port: 10100 }, "guessed", 1234);
    const read = mod.readPendingTeardown(guessed.nonce);
    expect(read.state === "valid" && read.receipt.endpointSource).toBe("guessed");

    // A proxy started with an explicit --port can be respawned there while the configured
    // address refuses, so a dead probe of THIS address proves nothing. handleStop reads
    // the provenance and fails closed rather than restoring on it.
    const exact = mod.claimPendingTeardown({ hostname: "127.0.0.1", port: 19999 }, "exact", 1234);
    expect(mod.readPendingTeardown(exact.nonce)).toMatchObject({ state: "valid" });
  });

  test("a receipt without provenance is invalid, so an old-format file cannot be trusted", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    writeFileSync(
      mod.pendingTeardownPathFor(claimed.nonce),
      JSON.stringify({ ownerPid: 1234, nonce: claimed.nonce, createdAt: "t", endpoint: ENDPOINT }),
    );
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
    writeFileSync(
      mod.pendingTeardownPathFor(claimed.nonce),
      JSON.stringify({ ownerPid: 1234, nonce: claimed.nonce, createdAt: "t", endpoint: ENDPOINT, endpointSource: "maybe" }),
    );
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
  });
});

describe("post-stop update decision", () => {
  test("an outstanding obligation aborts the install even when the stop succeeded", async () => {
    const { decidePostStopUpdate } = await import("../../src/update/stop-decision.mjs");
    // A quarantined receipt lets the stop itself succeed — there is nothing left to stop —
    // so checking only BEFORE the stop let the retry sail through and install over a
    // teardown that never ran.
    expect(decidePostStopUpdate({ status: 0, hasRuntimeState: false, liveness: "dead", teardownOutstanding: true }))
      .toEqual({ proceed: false, reason: "teardown-outstanding" });
    expect(decidePostStopUpdate({ status: 0, hasRuntimeState: false, liveness: "dead", teardownOutstanding: false }))
      .toEqual({ proceed: true, reason: "ok" });
    // Omitting the field keeps the previous behaviour for any caller that has not adopted it.
    expect(decidePostStopUpdate({ status: 0, hasRuntimeState: false, liveness: "dead" }))
      .toEqual({ proceed: true, reason: "ok" });
    // A real stop failure still wins: it is the stronger signal.
    expect(decidePostStopUpdate({ status: 1, hasRuntimeState: false, liveness: "dead", teardownOutstanding: true }))
      .toEqual({ proceed: false, reason: "stop-failed" });
  });
});

describe("pending teardown receipts", () => {
  test("a claim is durable and carries the endpoint it was stopping", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    expect(claimed.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(existsSync(mod.pendingTeardownPathFor(claimed.nonce))).toBe(true);
    const read = mod.readPendingTeardown(claimed.nonce);
    expect(read.state).toBe("valid");
    expect(read.state === "valid" && read.receipt.endpoint).toEqual(ENDPOINT);
    expect(mod.pendingTeardownOutstanding()).toBe(true);
  });

  test("a clear names one obligation, so a concurrent claim cannot be deleted by it", async () => {
    const mod = await import("../../src/config/pending-teardown");
    // Review round 8 reproduced the delete-the-wrong-receipt bug; round 10 pointed out
    // that a read-compare-unlink against ONE shared path is still racy, because the file
    // can be replaced between the compare and the unlink. The nonce is the filename now,
    // so the replacement is a DIFFERENT file and the delete cannot reach it — no ordering
    // of the two operations matters.
    const abandoned = mod.claimPendingTeardown(ENDPOINT, "exact", 1111);
    const concurrent = mod.claimPendingTeardown(ENDPOINT, "exact", 2222);
    expect(mod.listPendingTeardowns()).toHaveLength(2);

    expect(mod.clearPendingTeardown(abandoned.nonce)).toBe(true);
    const survivors = mod.listPendingTeardowns();
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.state === "valid" && survivors[0]!.receipt.nonce).toBe(concurrent.nonce);
  });

  test("clearing reports whether the obligation is actually gone", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    expect(mod.clearPendingTeardown(claimed.nonce)).toBe(true);
    // Already gone is still "gone" — an idempotent discharge is not a failure.
    expect(mod.clearPendingTeardown(claimed.nonce)).toBe(true);
    // A receipt that cannot be removed must be reported, or recovery repeats forever.
    const stuck = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    rmSync(mod.pendingTeardownPathFor(stuck.nonce));
    mkdirSync(mod.pendingTeardownPathFor(stuck.nonce), { recursive: true });
    mkdirSync(join(mod.pendingTeardownPathFor(stuck.nonce), "child"), { recursive: true });
    expect(mod.clearPendingTeardown(stuck.nonce)).toBe(false);
    removeTreeWithRetry(mod.pendingTeardownPathFor(stuck.nonce));
  });

  test("an unreadable receipt is invalid, outstanding, and quarantinable", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    writeFileSync(mod.pendingTeardownPathFor(claimed.nonce), "{not json");
    const read = mod.readPendingTeardown(claimed.nonce);
    expect(read.state).toBe("invalid");
    expect(mod.pendingTeardownOutstanding()).toBe(true);
    // It names no endpoint, so nothing can prove its proxy down. Quarantine stops the
    // recovery loop from re-reading garbage on every stop, but the obligation REMAINS
    // outstanding: filing it away to unblock an update would let the next install land
    // over a teardown that never ran.
    const moved = mod.quarantinePendingTeardown(claimed.nonce);
    expect(moved).toBeTruthy();
    expect(existsSync(moved!)).toBe(true);
    expect(mod.listPendingTeardowns()).toHaveLength(0);
    expect(mod.pendingTeardownOutstanding()).toBe(true);
    expect(readdirSync(home).some(n => n.endsWith(".unreadable.json"))).toBe(true);
  });

  test("a directory where a receipt belongs is invalid, not missing", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    rmSync(mod.pendingTeardownPathFor(claimed.nonce));
    mkdirSync(mod.pendingTeardownPathFor(claimed.nonce), { recursive: true });
    // Reading that as absence hides an obligation that may still be outstanding.
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
    expect(mod.pendingTeardownOutstanding()).toBe(true);
    removeTreeWithRetry(mod.pendingTeardownPathFor(claimed.nonce));
  });

  test("a receipt whose body disagrees with its filename is invalid", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    writeFileSync(
      mod.pendingTeardownPathFor(claimed.nonce),
      JSON.stringify({ ownerPid: 1234, nonce: FOREIGN_NONCE, createdAt: "t", endpoint: ENDPOINT, endpointSource: "exact" }),
    );
    // Otherwise an edited body could claim an identity the file name does not carry.
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
    expect(mod.deferralMatchesReceipt(claimed.nonce)).toBe(false);
  });

  test("a receipt without a usable endpoint is invalid, because recovery could not locate it", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 1234);
    const path = mod.pendingTeardownPathFor(claimed.nonce);
    const base = { ownerPid: 7, nonce: claimed.nonce, createdAt: "t", endpointSource: "exact" };
    writeFileSync(path, JSON.stringify(base));
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
    writeFileSync(path, JSON.stringify({ ...base, endpoint: { hostname: "", port: 10100 } }));
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
    writeFileSync(path, JSON.stringify({ ...base, endpoint: { hostname: "127.0.0.1", port: 0 } }));
    expect(mod.readPendingTeardown(claimed.nonce).state).toBe("invalid");
  });

  test("only an abandoned receipt is recoverable", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 4242);
    const live = mod.readPendingTeardown(claimed.nonce);

    // A stop that is still running owns its own obligation; finishing it from here would
    // restore client config while that stop is still deciding whether a proxy survived.
    expect(mod.isPendingTeardownAbandoned(live, () => true, 1)).toBe(false);
    // This process's own receipt is not "abandoned" either.
    expect(mod.isPendingTeardownAbandoned(live, () => false, 4242)).toBe(false);
    // A dead owner left the obligation behind: recover it.
    expect(mod.isPendingTeardownAbandoned(live, () => false, 1)).toBe(true);
    expect(mod.isPendingTeardownAbandoned({ state: "missing" }, () => false, 1)).toBe(false);
  });

  test("deferralMatchesReceipt needs a well-formed nonce that names a readable receipt", async () => {
    const mod = await import("../../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, "exact", 7);
    expect(mod.deferralMatchesReceipt(claimed.nonce)).toBe(true);
    expect(mod.deferralMatchesReceipt(FOREIGN_NONCE)).toBe(false);
    expect(mod.deferralMatchesReceipt(null)).toBe(false);
    // A path-shaped "nonce" must not be able to reach outside the receipt namespace.
    expect(mod.deferralMatchesReceipt("../config")).toBe(false);
    expect(mod.deferralMatchesReceipt("")).toBe(false);
  });
});

describe("self-unloading manager refusal (#4023)", () => {
  test("a darwin proxy running AS the launchd job reports a self-unload risk", async () => {
    // `stopServiceIfInstalledDetailed()` calls `launchctl unload` on the plist that owns
    // THIS process, so the manager stop can terminate the request handler before the
    // shared teardown two statements later restores native Codex. The Windows guard that
    // prevents exactly this returned early for every non-Windows platform.
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" },
      exists: () => true,
    })).toBe("self-unload");
  });

  test("linux systemd is exempted identically and gets the same answer", async () => {
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "linux", {
      env: { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" },
      exists: () => true,
    })).toBe("self-unload");
  });

  test("a manually started proxy is unaffected, even with a service installed", async () => {
    // Only the plist and unit write OCX_SERVICE_MANAGED. Without it this process is not
    // the managed job, so no unload can reach it and the inline stop stays available.
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: {},
      exists: () => true,
    })).toBe("none");
  });

  test("the managed job with no service definition on disk is not at risk", async () => {
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" },
      exists: () => false,
    })).toBe("none");
  });

  test("Windows classification is untouched by the new branch", async () => {
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "present" }) as never, "win32", {
      env: { OCX_SERVICE: "1" },
      exists: () => true,
    })).toBe("respawnable");
    expect(installedServiceRespawnRisk(() => ({ status: "unknown" }) as never, "win32")).toBe("unknown");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "win32")).toBe("none");
  });

  
  test("a proxy spawned by an ensure path is not the managed job", async () => {
    // Both `ocx claude` and `ocx opencode` set OCX_SERVICE=1 on their detached child to
    // borrow its routing-preservation meaning (src/cli/claude.ts, src/cli/opencode.ts),
    // so that variable cannot identify the managed job. A user with the service installed
    // but stopped, running one of those commands, must keep a working dashboard Stop.
    const { installedServiceRespawnRisk } = await import("../../src/service");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "darwin", {
      env: { OCX_SERVICE: "1" },
      exists: () => true,
    })).toBe("none");
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "linux", {
      env: { OCX_SERVICE: "1" },
      exists: () => true,
    })).toBe("none");
  });


test("the route refuses a self-unload before the manager is touched", () => {
    const source = readFileSync(repoPath("src", "server", "management-api.ts"), "utf8");
    const from = source.indexOf('"/api/stop"');
    const handler = source.slice(from, source.indexOf("/api/codex-auth/", from));
    expect(handler).toContain('code: "self_unload_service"');
    // Same invariant the Windows guard carries: refuse BEFORE acting, and say so.
    expect(handler.indexOf('code: "self_unload_service"'))
      .toBeLessThan(handler.indexOf("stopServiceIfInstalledDetailed()"));
    const branch = handler.slice(handler.indexOf('code: "self_unload_service"'), handler.indexOf('code: "self_unload_service"') + 600);
    expect(branch).toContain("Nothing was changed.");
    expect(branch).toContain("ocx stop");
  });

  test("a receipt-backed ocx stop keeps its deferral path", () => {
    // `ocx stop` claims a receipt, defers the teardown, and performs it itself once the
    // proxy is proven down — so it must not be refused by the new branch.
    const source = readFileSync(repoPath("src", "server", "management-api.ts"), "utf8");
    expect(source).toContain('const respawnRisk = holdsReceipt ? "none" : installedServiceRespawnRisk();');
  });
});

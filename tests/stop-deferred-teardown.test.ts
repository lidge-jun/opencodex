import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopProxyGracefully } from "../src/lib/process-control";
import { performStopTeardown } from "../src/server/stop-teardown";
import type { CodexNativeRestoreResult } from "../src/codex/inject";

/**
 * Behavioural cover for the deferred shared teardown (#3008).
 *
 * The wiring assertions in tests/grok-lifecycle.test.ts read source text, which cannot
 * tell a working deferral from a plausible-looking one. These tests call the real
 * functions: the graceful-stop client that builds the URL, the teardown decision the
 * route delegates to, and the on-disk receipt that decides whether the deferral is an
 * obligation or an unbacked request.
 */

let home: string;
let previousHome: string | undefined;
const NONCE = "0123456789abcdef0123456789abcdef";
const ENDPOINT = { hostname: "127.0.0.1", port: 10100 };

function validRead(nonce = NONCE, ownerPid = 4242) {
  return { state: "valid" as const, receipt: { ownerPid, nonce, createdAt: new Date().toISOString(), endpoint: ENDPOINT } };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-deferred-teardown-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
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

describe("stopProxyGracefully deferral flag", () => {
  test("the default stop asks for no deferral", async () => {
    const urls: string[] = [];
    await stopProxyGracefully(11, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
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
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch,
      waitExit: () => true,
      env: {},
      deferSharedTeardownNonce: "0123456789abcdef0123456789abcdef",
    });
    expect(urls).toEqual([
      "http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=0123456789abcdef0123456789abcdef",
    ]);
  });
});

describe("performStopTeardown", () => {
  test("an ordinary stop restores native Codex and strips the Grok fence", async () => {
    let restored = 0;
    let stripped = 0;
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      readReceipt: () => ({ state: "missing" }),
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
    const body = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${NONCE}`), {
      readReceipt: () => validRead(),
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

  test("the query alone does not buy a deferral without a receipt", async () => {
    let restored = 0;
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop?deferSharedTeardown=1"), {
      readReceipt: () => ({ state: "missing" }),
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    // An authenticated caller that sets the flag and exits must not be able to leave
    // client config pointed at a proxy that is going away.
    expect(restored).toBe(1);
    expect(body.sharedTeardown).toBe("performed");
  });

  test("another stop's outstanding receipt does not buy this caller a deferral", async () => {
    let restored = 0;
    // Presence alone would let any authenticated caller ride on somebody else's
    // obligation: it gets the deferral, owns no recovery, and the real owner's receipt is
    // discharged by a teardown that never happened.
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop?deferSharedTeardown=1"), {
      readReceipt: () => validRead(),
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(restored).toBe(1);
    expect(body.sharedTeardown).toBe("performed");
  });

  test("a wrong nonce is refused like no nonce at all", async () => {
    let restored = 0;
    const wrong = "ffffffffffffffffffffffffffffffff";
    const body = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${wrong}`), {
      readReceipt: () => validRead(),
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(restored).toBe(1);
    expect(body.sharedTeardown).toBe("performed");
  });

  test("an unparseable receipt on disk does not authorize a deferral", async () => {
    let restored = 0;
    const body = await performStopTeardown(new URL(`http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=${NONCE}`), {
      readReceipt: () => ({ state: "invalid", fingerprint: "abc" }),
      restoreNativeCodex: async () => { restored += 1; return restoreResult(true); },
      stripGrok: () => ({ ok: true, changed: true, message: "Grok config restored" }),
    });
    expect(restored).toBe(1);
    expect(body.sharedTeardown).toBe("performed");
  });

  test("a failed restore still reports failure and the remediation", async () => {
    const body = await performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"), {
      readReceipt: () => ({ state: "missing" }),
      restoreNativeCodex: async () => restoreResult(false),
      stripGrok: () => ({ ok: false, changed: false, message: "grok home is read-only" }),
    });
    expect(body.success).toBe(false);
    expect(body.message).toContain("ocx restore");
    expect(body.message).toContain("Grok config cleanup failed");
  });
});

describe("pending teardown receipt", () => {
  test("a claim is durable and cleared only by the exact receipt that was read", async () => {
    const mod = await import("../src/config/pending-teardown");
    const claimed = mod.claimPendingTeardown(ENDPOINT, 1234);
    expect(existsSync(mod.getPendingTeardownPath())).toBe(true);
    expect(mod.readPendingTeardown()?.ownerPid).toBe(1234);
    expect(claimed.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(mod.readPendingTeardown()?.endpoint).toEqual(ENDPOINT);

    // A concurrent stop must not delete an obligation it never accepted.
    mod.clearPendingTeardown(validRead("ffffffffffffffffffffffffffffffff"));
    expect(existsSync(mod.getPendingTeardownPath())).toBe(true);

    mod.clearPendingTeardown({ state: "valid", receipt: claimed });
    expect(existsSync(mod.getPendingTeardownPath())).toBe(false);
    expect(mod.readPendingTeardown()).toBeNull();
  });

  test("two successive claims get different identities", async () => {
    const mod = await import("../src/config/pending-teardown");
    const first = mod.claimPendingTeardown(ENDPOINT, 1111);
    const second = mod.claimPendingTeardown(ENDPOINT, 2222);
    expect(second.nonce).not.toBe(first.nonce);
    // The stale receipt names an obligation that no longer exists, so it clears nothing.
    mod.clearPendingTeardown({ state: "valid", receipt: first });
    expect(mod.readPendingTeardown()?.ownerPid).toBe(2222);
  });

  test("a recovery run cannot delete a receipt written after the one it read", async () => {
    const mod = await import("../src/config/pending-teardown");
    // The exact scenario review round 8 reproduced: owner 1111 is abandoned, a recovery
    // run reads it, another stop replaces the receipt with 2222 mid-restore, and the
    // recovery finishes. Clearing "whatever is there now" would drop 2222's live
    // obligation on the floor.
    const abandoned = mod.claimPendingTeardown(ENDPOINT, 1111);
    const replacement = mod.claimPendingTeardown(ENDPOINT, 2222);
    mod.clearPendingTeardown({ state: "valid", receipt: abandoned });
    const survivor = mod.readPendingTeardown();
    expect(survivor?.ownerPid).toBe(2222);
    expect(survivor?.nonce).toBe(replacement.nonce);
  });

  test("an unparseable receipt is identified by its bytes, so a replacement survives", async () => {
    const mod = await import("../src/config/pending-teardown");
    // Round 9 finding 2: force-clearing an invalid snapshot recreated the same race, this
    // time against a VALID receipt a concurrent stop wrote during restoration.
    mod.claimPendingTeardown(ENDPOINT, 1111);
    writeFileSync(mod.getPendingTeardownPath(), "{not json");
    const invalidSnapshot = mod.readPendingTeardownState();
    expect(invalidSnapshot.state).toBe("invalid");

    const replacement = mod.claimPendingTeardown(ENDPOINT, 2222);
    mod.clearPendingTeardown(invalidSnapshot);
    expect(mod.readPendingTeardown()?.nonce).toBe(replacement.nonce);
  });

  test("a read that cannot reach the file is invalid, not missing", async () => {
    const mod = await import("../src/config/pending-teardown");
    // Round 9 finding 4, reproduced: a directory where the receipt belongs. Reading that
    // as absence hides an obligation that may still be outstanding.
    mkdirSync(mod.getPendingTeardownPath(), { recursive: true });
    expect(existsSync(mod.getPendingTeardownPath())).toBe(true);
    expect(mod.readPendingTeardownState().state).toBe("invalid");
    expect(mod.pendingTeardownOutstanding()).toBe(true);
    rmSync(mod.getPendingTeardownPath(), { recursive: true, force: true });
  });

  test("a receipt without an endpoint is invalid, because recovery could not locate it", async () => {
    const mod = await import("../src/config/pending-teardown");
    writeFileSync(mod.getPendingTeardownPath(), JSON.stringify({ ownerPid: 7, nonce: NONCE, createdAt: "t" }));
    expect(mod.readPendingTeardownState().state).toBe("invalid");
    writeFileSync(mod.getPendingTeardownPath(), JSON.stringify({ ownerPid: 7, nonce: NONCE, createdAt: "t", endpoint: { hostname: "", port: 10100 } }));
    expect(mod.readPendingTeardownState().state).toBe("invalid");
    writeFileSync(mod.getPendingTeardownPath(), JSON.stringify({ ownerPid: 7, nonce: NONCE, createdAt: "t", endpoint: { hostname: "127.0.0.1", port: 0 } }));
    expect(mod.readPendingTeardownState().state).toBe("invalid");
  });

  test("garbage on disk is invalid, not absent", async () => {
    const mod = await import("../src/config/pending-teardown");
    mod.claimPendingTeardown(ENDPOINT, 1234);
    writeFileSync(mod.getPendingTeardownPath(), "{not json");
    // Reading it as "no receipt" would let the route perform an immediate teardown while
    // leaving an unattributable obligation on disk forever.
    expect(mod.readPendingTeardownState().state).toBe("invalid");
    expect(mod.readPendingTeardown()).toBeNull();
    expect(mod.pendingTeardownOutstanding()).toBe(true);

    writeFileSync(mod.getPendingTeardownPath(), JSON.stringify({ ownerPid: -1, nonce: NONCE, createdAt: "x", endpoint: ENDPOINT }));
    expect(mod.readPendingTeardownState().state).toBe("invalid");
    writeFileSync(mod.getPendingTeardownPath(), JSON.stringify({ ownerPid: 5, nonce: "short", createdAt: "x", endpoint: ENDPOINT }));
    expect(mod.readPendingTeardownState().state).toBe("invalid");
  });

  test("an invalid receipt is recoverable and clears only against its own bytes", async () => {
    const mod = await import("../src/config/pending-teardown");
    mod.claimPendingTeardown(ENDPOINT, 1234);
    writeFileSync(mod.getPendingTeardownPath(), "{not json");
    const snapshot = mod.readPendingTeardownState();
    // It names no live owner to wait on, so it is abandoned by definition.
    expect(mod.isPendingTeardownAbandoned(snapshot, () => true, 1)).toBe(true);
    // A valid receipt's identity cannot clear it.
    mod.clearPendingTeardown(validRead());
    expect(existsSync(mod.getPendingTeardownPath())).toBe(true);
    // Neither can a different invalid file.
    writeFileSync(mod.getPendingTeardownPath(), "{different garbage");
    mod.clearPendingTeardown(snapshot);
    expect(existsSync(mod.getPendingTeardownPath())).toBe(true);
    mod.clearPendingTeardown(mod.readPendingTeardownState());
    expect(existsSync(mod.getPendingTeardownPath())).toBe(false);
  });

  test("only an abandoned receipt is recoverable", async () => {
    const mod = await import("../src/config/pending-teardown");
    const live = validRead();

    // A stop that is still running owns its own obligation; finishing it from here would
    // restore client config while that stop is still deciding whether a proxy survived.
    expect(mod.isPendingTeardownAbandoned(live, () => true, 1)).toBe(false);
    // This process's own receipt is not "abandoned" either.
    expect(mod.isPendingTeardownAbandoned(live, () => false, 4242)).toBe(false);
    // A dead owner left the obligation behind: recover it.
    expect(mod.isPendingTeardownAbandoned(live, () => false, 1)).toBe(true);
    expect(mod.isPendingTeardownAbandoned({ state: "missing" }, () => false, 1)).toBe(false);
  });

  test("deferralMatchesReceipt needs the exact nonce of a valid receipt", async () => {
    const mod = await import("../src/config/pending-teardown");
    const valid = validRead(NONCE, 7);
    expect(mod.deferralMatchesReceipt(NONCE, valid)).toBe(true);
    expect(mod.deferralMatchesReceipt("ffffffffffffffffffffffffffffffff", valid)).toBe(false);
    expect(mod.deferralMatchesReceipt(null, valid)).toBe(false);
    expect(mod.deferralMatchesReceipt(NONCE, { state: "missing" })).toBe(false);
    expect(mod.deferralMatchesReceipt(NONCE, { state: "invalid", fingerprint: "abc" })).toBe(false);
  });
});

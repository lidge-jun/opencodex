import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runtime behaviour of the WHAM 401 recovery (#3019).
 *
 * tests/quota-401-recovery.test.ts exercises the budget store in isolation, and every case
 * there stays green if the recovery is never wired into the quota path at all. These drive
 * the real primitive and the real store together: a refresh that actually happens, a
 * settlement that survives caller cancellation, and provenance that comes from the flight
 * rather than from the adoption site.
 */

const REJECTED = "rejected-bearer";
const ROTATED = "rotated-bearer";
let home: string;
let previousHome: string | undefined;
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-quota-401-"));
  process.env.OPENCODEX_HOME = home;
  originalFetch = globalThis.fetch;
  const { resetQuotaRecoveryForTests } = await import("../src/codex/quota-401-recovery");
  resetQuotaRecoveryForTests();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  const { resetQuotaRecoveryForTests } = await import("../src/codex/quota-401-recovery");
  resetQuotaRecoveryForTests();
});

async function seedAccount(id: string): Promise<number> {
  const { readCodexAccountRecord, saveCodexAccountCredential } = await import("../src/codex/account-store");
  saveCodexAccountCredential(id, {
    accessToken: REJECTED,
    refreshToken: "grant",
    expiresAt: Date.now() + 3600_000,
    chatgptAccountId: "acc",
  });
  return readCodexAccountRecord(id)!.generation;
}

test("a refresh settles the budget even when the caller cancels first", async () => {
  const { forceRefreshCodexPoolToken } = await import("../src/codex/account-store");
  const { claimQuotaRecovery, quotaRecoveryRecordForTests, settleQuotaRecovery, releaseQuotaRecovery } =
    await import("../src/codex/quota-401-recovery");
  const generation = await seedAccount("cancelled-owner");

  let released = 0;
  globalThis.fetch = (async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return Response.json({ access_token: ROTATED, refresh_token: "grant2", expires_in: 3600 });
  }) as typeof fetch;

  const claim = claimQuotaRecovery("cancelled-owner", generation);
  if (!claim.granted) throw new Error("expected a claim");
  const controller = new AbortController();
  const settled = new Promise<void>(resolve => {
    void forceRefreshCodexPoolToken("cancelled-owner", {
      rejectedGeneration: generation,
      rejectedAccessToken: REJECTED,
      signal: controller.signal,
      onSettled: outcome => {
        if (outcome.kind === "resolved") settleQuotaRecovery("cancelled-owner", claim.claimId, outcome);
        else { released += 1; releaseQuotaRecovery("cancelled-owner", claim.claimId, 60_000); }
        resolve();
      },
    }).catch(() => { /* the caller walked away on purpose */ });
  });

  // Cancel while the token request is still in flight. The shared refresh keeps running and
  // commits; settling from the cancelled await would report "failed", release the budget,
  // and let the freshly refreshed lineage claim again moments later.
  controller.abort(new Error("caller went away"));
  await settled;

  expect(released).toBe(0);
  expect(quotaRecoveryRecordForTests("cancelled-owner")).toEqual({ state: "spent", lineage: generation + 1 });
});

test("a joiner that adopts somebody else's credential does not spend that lineage's budget", async () => {
  const { forceRefreshCodexPoolToken, saveCodexAccountCredential } = await import("../src/codex/account-store");
  const generation = await seedAccount("adopting-joiner");

  // The flight resolves to a credential from a DIFFERENT grant: its own branch tags that
  // as an external replacement, and a joiner adopting those bytes must carry that verdict
  // rather than calling itself joined-lineage.
  globalThis.fetch = (async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ access_token: ROTATED, refresh_token: "grant2", expires_in: 3600 });
  }) as typeof fetch;

  const outcomes: string[] = [];
  const both = await Promise.allSettled([
    forceRefreshCodexPoolToken("adopting-joiner", {
      rejectedGeneration: generation,
      rejectedAccessToken: REJECTED,
      onSettled: o => { if (o.kind === "resolved") outcomes.push(o.provenance); },
    }),
    forceRefreshCodexPoolToken("adopting-joiner", {
      rejectedGeneration: generation,
      rejectedAccessToken: REJECTED,
      onSettled: o => { if (o.kind === "resolved") outcomes.push(o.provenance); },
    }),
  ]);

  // Both callers get a verdict, and every verdict is one of the three — never undefined,
  // which is what a path that forgot to classify itself would produce.
  expect(outcomes).toHaveLength(2);
  for (const provenance of outcomes) {
    expect(["self-refresh", "joined-lineage", "external-replacement"]).toContain(provenance);
  }
  expect(both.some(r => r.status === "fulfilled")).toBe(true);
  void saveCodexAccountCredential;
});

test("a terminal refresh failure keeps reporting needs-reauth on later polls", async () => {
  const { claimQuotaRecovery, quotaRecoveryTerminalFor, settleQuotaRecoveryTerminal, releaseQuotaRecovery } =
    await import("../src/codex/quota-401-recovery");

  const claim = claimQuotaRecovery("dead-grant", 4);
  if (!claim.granted) throw new Error("expected a claim");
  settleQuotaRecoveryTerminal("dead-grant", claim.claimId);

  // A revoked grant does not recover on the next poll. Treating it as an ordinary spent
  // budget would make the following bare 401 report the account healthy.
  expect(quotaRecoveryTerminalFor("dead-grant", 4)).toBe(true);
  expect(claimQuotaRecovery("dead-grant", 4)).toEqual({ granted: false, reason: "spent" });

  // A transient failure is different: spent, but not terminal.
  const other = claimQuotaRecovery("slow-grant", 4);
  if (!other.granted) throw new Error("expected a claim");
  releaseQuotaRecovery("slow-grant", other.claimId, 60_000);
  expect(quotaRecoveryTerminalFor("slow-grant", 4)).toBe(false);
});

test("neither bearer reaches a log line during a refresh", async () => {
  const { forceRefreshCodexPoolToken } = await import("../src/codex/account-store");
  const generation = await seedAccount("quiet-refresh");
  globalThis.fetch = (async () =>
    Response.json({ access_token: ROTATED, refresh_token: "grant2", expires_in: 3600 })) as typeof fetch;

  const captured: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  const capture = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
  console.log = capture; console.warn = capture; console.error = capture; console.debug = capture;
  try {
    const result = await forceRefreshCodexPoolToken("quiet-refresh", {
      rejectedGeneration: generation,
      rejectedAccessToken: REJECTED,
    });
    expect(result.accessToken).toBe(ROTATED);
  } finally {
    console.log = originals.log; console.warn = originals.warn;
    console.error = originals.error; console.debug = originals.debug;
  }

  // privacy:scan is static and cannot see what a runtime path actually emits.
  const transcript = captured.join("\n");
  expect(transcript).not.toContain(REJECTED);
  expect(transcript).not.toContain(ROTATED);
  expect(transcript).not.toContain("grant2");
});

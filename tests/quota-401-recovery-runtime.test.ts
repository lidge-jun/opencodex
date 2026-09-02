import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
  removeTreeWithRetry(home);
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

/** Register the account in config too, so the account-list API actually returns a row. */
async function seedListedAccount(id: string): Promise<number> {
  const generation = await seedAccount(id);
  const { loadConfig, saveConfig } = await import("../src/config");
  const config = loadConfig();
  const accounts = [...(config.codexAccounts ?? []).filter(a => a.id !== id), { id, label: id }];
  saveConfig({ ...config, codexAccounts: accounts });
  return generation;
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
  let callerRejected: unknown;
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
    }).then(
      () => { callerRejected = "resolved"; },
      error => { callerRejected = error; },
    );
  });

  // Cancel while the token request is still in flight. The shared refresh keeps running and
  // commits; settling from the cancelled await would report "failed", release the budget,
  // and let the freshly refreshed lineage claim again moments later.
  const abortReason = new Error("caller went away");
  controller.abort(abortReason);
  await settled;

  // The caller really was cancelled — otherwise this test would also pass against an
  // implementation that simply ignores the signal.
  expect(callerRejected).toBe(abortReason);
  expect(released).toBe(0);
  expect(quotaRecoveryRecordForTests("cancelled-owner")).toEqual({ state: "spent", lineage: generation + 1 });
});

test("exactly one of two callers on a shared flight performed the CAS", async () => {
  const { forceRefreshCodexPoolToken } = await import("../src/codex/account-store");
  const generation = await seedAccount("adopting-joiner");

  globalThis.fetch = (async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return Response.json({ access_token: ROTATED, refresh_token: "grant2", expires_in: 3600 });
  }) as typeof fetch;

  const outcomes: string[] = [];
  await Promise.allSettled([
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

  // Only one caller can have moved the credential. Accepting "any of the three enum
  // values" would pass against the bug where a joiner copies the flight's own
  // `self-refresh` and reports a CAS it never performed.
  expect(outcomes).toHaveLength(2);
  expect(outcomes.filter(p => p === "self-refresh")).toHaveLength(1);
  // Specifically joined-lineage: an "external-replacement" joiner is also non-self, and
  // would wrongly leave this lineage's budget unspent.
  expect(outcomes.filter(p => p === "joined-lineage")).toHaveLength(1);
});

test("a revoked grant routes to terminal settlement, a slow one does not", async () => {
  const { forceRefreshCodexPoolToken } = await import("../src/codex/account-store");
  const { claimQuotaRecovery, quotaRecoveryRecordForTests } = await import("../src/codex/quota-401-recovery");

  // Drive the real primitive to a real refresh failure and route it exactly the way
  // recoverPoolQuotaFrom401 does, so a wiring that never calls terminal settlement fails.
  const { TokenRefreshError } = await import("../src/codex/account-store");
  const { releaseQuotaRecovery, settleQuotaRecoveryTerminal, quotaRecoveryTerminalFor } =
    await import("../src/codex/quota-401-recovery");
  const route = (accountId: string, claimId: string, error: unknown) => {
    if (error instanceof TokenRefreshError && /invalid_grant|revoked|expired|invalid_refresh_token/i.test(String(error.message))) {
      settleQuotaRecoveryTerminal(accountId, claimId);
    } else {
      releaseQuotaRecovery(accountId, claimId, 60_000);
    }
  };

  const revokedGeneration = await seedAccount("dead-grant");
  globalThis.fetch = (async () => new Response("{\"error\":\"invalid_grant\"}", { status: 400 })) as typeof fetch;
  const revokedClaim = claimQuotaRecovery("dead-grant", revokedGeneration);
  if (!revokedClaim.granted) throw new Error("expected a claim");
  await forceRefreshCodexPoolToken("dead-grant", {
    rejectedGeneration: revokedGeneration,
    rejectedAccessToken: REJECTED,
    onSettled: o => { if (o.kind === "failed") route("dead-grant", revokedClaim.claimId, o.error); },
  }).catch(() => { /* the refresh is supposed to fail */ });

  expect(quotaRecoveryTerminalFor("dead-grant", revokedGeneration)).toBe(true);
  expect(quotaRecoveryRecordForTests("dead-grant")).toMatchObject({ state: "spent", terminal: true });

  const slowGeneration = await seedAccount("slow-grant");
  globalThis.fetch = (async () => { throw new Error("socket hang up"); }) as typeof fetch;
  const slowClaim = claimQuotaRecovery("slow-grant", slowGeneration);
  if (!slowClaim.granted) throw new Error("expected a claim");
  await forceRefreshCodexPoolToken("slow-grant", {
    rejectedGeneration: slowGeneration,
    rejectedAccessToken: REJECTED,
    onSettled: o => { if (o.kind === "failed") route("slow-grant", slowClaim.claimId, o.error); },
  }).catch(() => { /* transient by design */ });

  // A network failure proves nothing about the grant, so it must not fence the account.
  expect(quotaRecoveryTerminalFor("slow-grant", slowGeneration)).toBe(false);
  expect(quotaRecoveryRecordForTests("slow-grant")).toMatchObject({ state: "backoff" });
});

test("a revoked grant stays needs-reauth across polls, through the real quota path", async () => {
  const { listCodexAuthAccounts } = await import("../src/codex/auth-api");
  const { loadConfig } = await import("../src/config");
  await seedListedAccount("dead-grant");

  // Bare WHAM 401 -> token endpoint says invalid_grant -> the account list re-polls.
  // Routing this through listCodexAuthAccounts is the point: a local reimplementation of
  // the settlement callback stays green with the production wiring deleted.
  let tokenCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/wham/usage")) return new Response("{}", { status: 401 });
    tokenCalls += 1;
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  }) as typeof fetch;

  const config = loadConfig();
  const first = await listCodexAuthAccounts(config, true);
  expect(first.find(row => row.id === "dead-grant")?.needsReauth).toBe(true);

  // The evidence has to be DURABLE, not just present in the response that discovered it.
  // The recovery record alone cannot carry it: by the time the next poll runs, the claim is
  // spent and a spent budget reports transient. Assert the account-level mark directly, so
  // dropping markAccountNeedsReauth fails here rather than being masked by a cached quota.
  const { isAccountNeedsReauth } = await import("../src/codex/auth-api");
  expect(isAccountNeedsReauth("dead-grant")).toBe(true);

  const second = await listCodexAuthAccounts(config, true);
  expect(second.find(row => row.id === "dead-grant")?.needsReauth).toBe(true);
  // And the dead grant is not retried on every poll.
  expect(tokenCalls).toBe(1);
});

test("a transient refresh failure does not quarantine the account", async () => {
  const { listCodexAuthAccounts } = await import("../src/codex/auth-api");
  const { loadConfig } = await import("../src/config");
  const { quotaRecoveryRecordForTests } = await import("../src/codex/quota-401-recovery");
  await seedListedAccount("slow-grant");

  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/wham/usage")) return new Response("{}", { status: 401 });
    throw new Error("socket hang up");
  }) as typeof fetch;

  const rows = await listCodexAuthAccounts(loadConfig(), true);
  // A network failure proves nothing about the grant.
  expect(rows.find(row => row.id === "slow-grant")?.needsReauth).toBe(false);
  // Nor may it leave a durable quarantine behind.
  const { isAccountNeedsReauth } = await import("../src/codex/auth-api");
  expect(isAccountNeedsReauth("slow-grant")).toBe(false);
  expect(quotaRecoveryRecordForTests("slow-grant")).toMatchObject({ state: "backoff" });
});

test("an already-aborted caller starts no refresh at all", async () => {
  const { forceRefreshCodexPoolToken } = await import("../src/codex/account-store");
  const { claimQuotaRecovery, quotaRecoveryRecordForTests, releaseQuotaRecovery, settleQuotaRecovery } =
    await import("../src/codex/quota-401-recovery");
  const generation = await seedAccount("pre-aborted");

  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return Response.json({ access_token: ROTATED, refresh_token: "grant2", expires_in: 3600 });
  }) as typeof fetch;

  const claim = claimQuotaRecovery("pre-aborted", generation);
  if (!claim.granted) throw new Error("expected a claim");
  const reason = new Error("caller already gone");
  const controller = new AbortController();
  controller.abort(reason);

  let failures = 0;
  let rejected: unknown;
  await forceRefreshCodexPoolToken("pre-aborted", {
    rejectedGeneration: generation,
    rejectedAccessToken: REJECTED,
    signal: controller.signal,
    onSettled: outcome => {
      if (outcome.kind === "failed") { failures += 1; releaseQuotaRecovery("pre-aborted", claim.claimId, 60_000); }
      else settleQuotaRecovery("pre-aborted", claim.claimId, outcome);
    },
  }).catch(error => { rejected = error; });

  // Settlement runs on an uncancelled completion, which bypasses resolveCodexToken's own
  // pre-abort guard — so without an explicit check here a caller that is already gone
  // would rotate a credential nobody is waiting for.
  expect(fetches).toBe(0);
  expect(rejected).toBe(reason);
  expect(failures).toBe(1);
  // And the claim is not left held: it was released, not abandoned to its lease.
  expect(quotaRecoveryRecordForTests("pre-aborted")).toMatchObject({ state: "backoff" });
});

test("structured terminal evidence on the FIRST 401 needs no refresh and is generation-scoped", async () => {
  const { listCodexAuthAccounts, isAccountNeedsReauth } = await import("../src/codex/auth-api");
  const { loadConfig } = await import("../src/config");
  const generation = await seedListedAccount("structured-first");

  let tokenCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/wham/usage")) {
      return new Response(JSON.stringify({ detail: { code: "invalid_refresh_token" } }), { status: 401 });
    }
    tokenCalls += 1;
    return Response.json({ access_token: ROTATED, refresh_token: "grant2", expires_in: 3600 });
  }) as typeof fetch;

  const rows = await listCodexAuthAccounts(loadConfig(), true);
  expect(rows.find(row => row.id === "structured-first")?.needsReauth).toBe(true);
  // A body that says the grant is dead needs no refresh to prove it.
  expect(tokenCalls).toBe(0);
  expect(isAccountNeedsReauth("structured-first")).toBe(true);

  // The evidence is about THAT credential. A replacement must not inherit the quarantine.
  const { saveCodexAccountCredential } = await import("../src/codex/account-store");
  saveCodexAccountCredential("structured-first", {
    accessToken: "fresh-login",
    refreshToken: "fresh-grant",
    expiresAt: Date.now() + 3600_000,
    chatgptAccountId: "acc",
  });
  expect(isAccountNeedsReauth("structured-first")).toBe(false);
  void generation;
});

test("structured terminal evidence on the REPLAY is scoped to the refreshed credential", async () => {
  const { listCodexAuthAccounts, isAccountNeedsReauth } = await import("../src/codex/auth-api");
  const { loadConfig } = await import("../src/config");
  await seedListedAccount("structured-replay");

  let whamCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/wham/usage")) {
      whamCalls += 1;
      // Bare first, structured-terminal on the replay: only the second answer proves death.
      return whamCalls === 1
        ? new Response("{}", { status: 401 })
        : new Response(JSON.stringify({ detail: { code: "invalid_refresh_token" } }), { status: 401 });
    }
    return Response.json({ access_token: ROTATED, refresh_token: "grant2", expires_in: 3600 });
  }) as typeof fetch;

  const rows = await listCodexAuthAccounts(loadConfig(), true);
  expect(whamCalls).toBe(2);
  expect(rows.find(row => row.id === "structured-replay")?.needsReauth).toBe(true);
  expect(isAccountNeedsReauth("structured-replay")).toBe(true);

  const { saveCodexAccountCredential } = await import("../src/codex/account-store");
  saveCodexAccountCredential("structured-replay", {
    accessToken: "fresh-login",
    refreshToken: "fresh-grant",
    expiresAt: Date.now() + 3600_000,
    chatgptAccountId: "acc",
  });
  expect(isAccountNeedsReauth("structured-replay")).toBe(false);
});

test("no bearer reaches the console, the debug buffer, or a serialized account row", async () => {
  const { forceRefreshCodexPoolToken } = await import("../src/codex/account-store");
  const { getDebugLogEntries } = await import("../src/lib/debug-log-buffer");
  // Registered, not just credentialed: an unlisted account produces no row at all, and the
  // serializer assertion below would then be checking an empty list.
  const generation = await seedListedAccount("quiet-refresh");
  globalThis.fetch = (async () =>
    Response.json({ access_token: ROTATED, refresh_token: "grant2", expires_in: 3600 })) as typeof fetch;

  const before = getDebugLogEntries({ limit: 500 }).length;
  const captured: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  const capture = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
  console.log = capture; console.warn = capture; console.error = capture; console.debug = capture;
  let result: Awaited<ReturnType<typeof forceRefreshCodexPoolToken>>;
  try {
    result = await forceRefreshCodexPoolToken("quiet-refresh", {
      rejectedGeneration: generation,
      rejectedAccessToken: REJECTED,
    });
  } finally {
    console.log = originals.log; console.warn = originals.warn;
    console.error = originals.error; console.debug = originals.debug;
  }
  // The refresh really happened — otherwise this asserts silence about nothing.
  expect(result.accessToken).toBe(ROTATED);
  expect(result.rotated).toBe(true);

  const secrets = [REJECTED, ROTATED, "grant2", "grant"];
  // privacy:scan is static and cannot see what a runtime path actually emits.
  const transcript = captured.join("\n");
  for (const secret of secrets) expect(transcript).not.toContain(secret);

  // console is not the only sink: the dashboard reads this buffer over the management API.
  const debugText = JSON.stringify(getDebugLogEntries({ after: before, limit: 500 }));
  for (const secret of secrets) expect(debugText).not.toContain(secret);

  // And the REAL serializer, not a hand-built stand-in: a leak has to be caught in what
  // the management API actually returns.
  const { listCodexAuthAccounts } = await import("../src/codex/auth-api");
  const { loadConfig } = await import("../src/config");
  const rows = JSON.stringify(await listCodexAuthAccounts(loadConfig(), false));
  expect(rows).toContain("quiet-refresh");
  for (const secret of secrets) expect(rows).not.toContain(secret);
});

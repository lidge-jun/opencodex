import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as oauth from "../../../src/oauth";
import * as oauthStore from "../../../src/oauth/store";
import { handleAccountAuthCommand } from "../../../src/cli/account-auth";
import * as coupons from "../../../src/grok/reset-coupons";
import * as ledger from "../../../src/grok/reset-coupon-ledger";
import { ConfigMutationLockError, readConfigGenerationInCurrentMutationTransaction } from "../../../src/config/mutation-lock";
import { handleGrokCouponRoutes } from "../../../src/server/management/grok-coupon-routes";
import type { ManagementContext } from "../../../src/server/management/context";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { repoPath } from "../../helpers/repo-root";
import { watchdogMs } from "../../helpers/ci-watchdog";

const OP = "11111111-1111-4111-8111-111111111111";
const TOKEN = { tokenId: "fixture-coupon", validityStart: "2026-01-01T00:00:00Z", validityEnd: "2999-01-01T00:00:00Z" };
let home: string;
let previous: string | undefined;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-coupon-claim-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  if (previous === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(home);
});
function identity() { return { accountId: "fixture-account", tokenId: TOKEN.tokenId, operationId: OP }; }
function request(omitToken = false, omitOperation = false): ManagementContext {
  const url = new URL("http://localhost/api/grok/reset-coupons/consume");
  const body = { ...identity(), tokenId: omitToken ? undefined : TOKEN.tokenId,
    operationId: omitOperation ? undefined : OP };
  const req = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { req, url, config: {}, deps: {}, version: "test" } as ManagementContext;
}

function confirmedRedemption() {
  const auth = spyOn(oauth, "getValidAccessSnapshotForAccount").mockResolvedValue({ accessToken: "fixture-access-token" } as never);
  const remaining = spyOn(coupons, "getGrokRemainingResets").mockResolvedValue({ tokens: [TOKEN] });
  const redeem = spyOn(coupons, "redeemGrokResetCoupon").mockResolvedValue({ success: true, status: 0 });
  spies.push(auth, remaining, redeem);
  return redeem;
}
function busySettlement() {
  return new ConfigMutationLockError("Config mutation already in progress", { cause: { code: "SQLITE_BUSY" } });
}

for (const tokenId of [null, 42, {}, [], true, "", "   "]) {
  test(`invalid coupon token ${JSON.stringify(tokenId)} refuses before opening the ledger`, async () => {
    const redeem = confirmedRedemption();
    const ctx = request();
    const response = await handleGrokCouponRoutes({ ...ctx, req: new Request(ctx.url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...identity(), tokenId }),
    }) });
    expect(response!.status).toBe(400);
    expect((await response!.json()).error.code).toBe("invalid_token_id");
    expect(fs.existsSync(ledger.grokCouponJournalPath())).toBe(false);
    expect(oauth.getValidAccessSnapshotForAccount).not.toHaveBeenCalled();
    expect((await handleGrokCouponRoutes(request()))!.status).toBe(200);
    expect(redeem).toHaveBeenCalledTimes(1);
  });
}

test("an open-operation retry without a token reuses its journaled coupon", async () => {
  const redeem = confirmedRedemption();
  const remaining = spyOn(coupons, "getGrokRemainingResets")
    .mockRejectedValueOnce(new Error("fixture list failure"))
    .mockResolvedValue({ tokens: [{ ...TOKEN, tokenId: "fixture-other-coupon" }, TOKEN] });
  spies.push(remaining);
  expect((await handleGrokCouponRoutes(request()))!.status).toBe(502);
  const response = await handleGrokCouponRoutes(request(true));
  expect(response!.status).toBe(200);
  expect(redeem).toHaveBeenCalledTimes(1);
  expect(redeem.mock.calls[0]![0].tokenId).toBe(TOKEN.tokenId);
});

test("an omitted-account CLI retry recovers the operation's recorded account", async () => {
  let active = "fixture-original-account";
  const selection = spyOn(oauthStore, "captureOAuthAccountSelection")
    .mockImplementation(() => ({ accountId: active }) as never);
  const redeem = confirmedRedemption().mockRejectedValue(new Error("fixture lost response"));
  spies.push(selection);
  const calls: Array<Record<string, unknown>> = [];
  const responses: Array<{ status: number; code: string }> = [];
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  const deps = { baseUrl: "http://localhost", fetchImpl: (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    const ctx = request();
    const response = (await handleGrokCouponRoutes({ ...ctx, req: new Request(ctx.url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }) }))!;
    responses.push({ status: response.status, code: (await response.clone().json()).error.code });
    return response;
  }) as typeof fetch };
  try {
    expect(await handleAccountAuthCommand("grok-reset-coupons", ["--consume", "--yes", "--operation-id", OP], deps)).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain(OP);
    active = "fixture-new-active-account";
    expect(await handleAccountAuthCommand("grok-reset-coupons", ["--consume", "--yes", "--operation-id", OP], deps)).toBeGreaterThan(0);
  } finally { console.error = originalError; }
  expect(calls).toHaveLength(2);
  expect(calls.every(body => body.accountId === undefined)).toBe(true);
  expect(responses[0].code).toBe("attempt_unresolved");
  expect(responses[1]).toEqual({ status: 409, code: "attempt_in_progress" });
  expect(oauth.getValidAccessSnapshotForAccount).toHaveBeenLastCalledWith("xai", "fixture-original-account", { requireUsableAccount: true });
  expect(redeem).toHaveBeenCalledTimes(1);
});

test("the attempted claim flushes its file and parent before redemption", async () => {
  const sync = fs.fsyncSync;
  const flushed: string[] = [];
  const flush = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    flushed.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
    sync(fd);
  });
  const redeem = confirmedRedemption().mockImplementation(async () => {
    expect(flushed).toContain("file");
    if (process.platform !== "win32") expect(flushed).toContain("directory");
    expect(JSON.parse(readFileSync(ledger.grokCouponJournalPath(), "utf8")).operations[OP].status).toBe("attempted");
    return { success: true, status: 0 };
  });
  const remaining = spyOn(coupons, "getGrokRemainingResets").mockImplementation(async () => {
    // Ignore the initial open: these flushes must belong to the attempted claim.
    flushed.length = 0;
    return { tokens: [TOKEN] };
  });
  spies.push(flush, remaining);
  expect((await handleGrokCouponRoutes(request()))!.status).toBe(200);
  expect(redeem).toHaveBeenCalledTimes(1);
});

for (const failure of ["file", "directory"] as const) {
  test.skipIf(failure === "directory" && process.platform === "win32")(`a claim ${failure} fsync failure prevents redemption`, async () => {
    const redeem = confirmedRedemption();
    const sync = fs.fsyncSync;
    const remaining = spyOn(coupons, "getGrokRemainingResets").mockImplementation(async () => {
      const flush = spyOn(fs, "fsyncSync").mockImplementation(fd => {
        if (fs.fstatSync(fd).isDirectory() === (failure === "directory")) throw new Error("fixture flush failure");
        sync(fd);
      });
      spies.push(flush);
      return { tokens: [TOKEN] };
    });
    spies.push(remaining);
    const response = await handleGrokCouponRoutes(request());
    expect(response!.status).toBe(500);
    expect((await response!.json()).error.code).toBe("attempt_mark_failed");
    expect(redeem).not.toHaveBeenCalled();
  });
}

for (const tokenId of [TOKEN.tokenId, undefined]) {
  test(`a legacy version-one open with ${tokenId ? "known" : "unknown"} token never dispatches`, async () => {
    writeFileSync(ledger.grokCouponJournalPath(), JSON.stringify({ version: 1, operations: {
      [OP]: { accountId: "fixture-account", tokenId, status: "open", createdAt: Date.now() - 120_000, updatedAt: Date.now() - 120_000 },
    } }));
    const redeem = confirmedRedemption();
    const response = await handleGrokCouponRoutes(request());
    expect(response!.status).toBe(409);
    expect((await response!.json()).error.code).toBe("attempt_unresolved");
    expect(redeem).not.toHaveBeenCalled();
  });
}

test("a legacy redemption failure with unconfirmed delivery is quarantined", async () => {
  writeFileSync(ledger.grokCouponJournalPath(), JSON.stringify({ version: 1, operations: {
    [OP]: { ...identity(), status: "failed", code: "redeem_failed", createdAt: Date.now() - 120_000, updatedAt: Date.now() - 120_000 },
  } }));
  const redeem = confirmedRedemption();
  const response = await handleGrokCouponRoutes(request());
  expect(response!.status).toBe(409);
  expect((await response!.json()).error.code).toBe("attempt_unresolved");
  expect(redeem).not.toHaveBeenCalled();
});

for (const [status, code] of [["settled", "redeemed"], ["failed", "coupon_unavailable"]] as const) {
  test(`a legacy definitive ${status} outcome retains its replay`, async () => {
    writeFileSync(ledger.grokCouponJournalPath(), JSON.stringify({ version: 1, operations: {
      [OP]: { ...identity(), status, code, createdAt: Date.now(), updatedAt: Date.now() },
    } }));
    const redeem = confirmedRedemption();
    const response = await handleGrokCouponRoutes(request());
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ code, replayed: true });
    expect(redeem).not.toHaveBeenCalled();
  });
}

test("new pre-dispatch opens are stored in version two and remain claimable", () => {
  expect(ledger.openGrokResetCouponOperation(identity()).kind).toBe("execute");
  expect(JSON.parse(readFileSync(ledger.grokCouponJournalPath(), "utf8")).version).toBe(2);
  expect(ledger.openGrokResetCouponOperation(identity()).kind).toBe("execute");
  expect(ledger.markGrokResetCouponAttempt(OP, TOKEN.tokenId)).toBe(true);
  expect(ledger.openGrokResetCouponOperation(identity()).kind).toBe("replay");
});

test("uncertain redemption returns the generated operation id as its retry anchor", async () => {
  const redeem = confirmedRedemption().mockRejectedValue(new Error("fixture connection reset"));
  const response = await handleGrokCouponRoutes(request(false, true));
  const body = await response!.json();
  expect(response!.status).toBe(502);
  expect(body.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(body.error.code).toBe("attempt_unresolved");
  expect(JSON.parse(readFileSync(ledger.grokCouponJournalPath(), "utf8")).operations[body.operationId].status).toBe("attempted");
  const ctx = request();
  ctx.req = new Request(ctx.url, { method: "POST", body: JSON.stringify({ ...identity(), operationId: body.operationId }) });
  expect((await handleGrokCouponRoutes(ctx))!.status).toBe(409);
  expect(redeem).toHaveBeenCalledTimes(1);
});

test("confirmed redemption settles after a real child releases the config mutation lock", async () => {
  const redeem = confirmedRedemption();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let busyFailures = 0;
  const realSettlement = ledger.recordGrokResetCouponSettlement;
  const settle = spyOn(ledger, "recordGrokResetCouponSettlement").mockImplementation((...args) => {
    try { return realSettlement(...args); }
    catch (error) {
      expect(error).toBeInstanceOf(ConfigMutationLockError);
      expect((error as Error).cause).toMatchObject({ code: "SQLITE_BUSY" });
      busyFailures += 1;
      throw error;
    }
  });
  spies.push(settle);
  redeem.mockImplementation(async () => {
    const moduleUrl = pathToFileURL(repoPath("src/config/mutation-lock.ts")).href;
    const owned = Bun.spawn([process.execPath, "-e", `import { readSync } from "node:fs";
      import { withConfigMutationLockSync } from ${JSON.stringify(moduleUrl)};
      withConfigMutationLockSync(() => { process.stdout.write("held\\n"); readSync(0, Buffer.alloc(1), 0, 1, null); });`], {
      env: { ...process.env, OPENCODEX_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child = owned;
    killTimer = setTimeout(() => owned.kill(), watchdogMs(10_000));
    const reader = owned.stdout.getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n"); }
    finally { reader.releaseLock(); }
    // The retry wait is a barrier: release the actual SQLite owner and wait
    // for its exit before allowing the next settlement acquisition.
    const sleep = spyOn(Bun, "sleep").mockImplementation(async () => {
      owned.stdin.write("release");
      owned.stdin.end();
      expect(await owned.exited).toBe(0);
    });
    spies.push(sleep);
    return { success: true, status: 0 };
  });
  try {
    const response = await handleGrokCouponRoutes(request());
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ code: "redeemed", settlementRecorded: true });
    expect(busyFailures).toBe(1);
    expect(settle).toHaveBeenCalledTimes(2);
    const replay = await handleGrokCouponRoutes(request());
    expect(await replay!.json()).toMatchObject({ code: "redeemed", replayed: true });
    expect(redeem).toHaveBeenCalledTimes(1);
  } finally {
    clearTimeout(killTimer);
    child?.kill();
    if (child) await child.exited;
  }
});

for (const [label, error] of [
  ["ordinary write failure", new Error("fixture write failure")],
  ["lock error without a cause", new ConfigMutationLockError("fixture unavailable")],
  ["corrupt coordination database", new ConfigMutationLockError("fixture unavailable", { cause: { code: "SQLITE_CORRUPT" } })],
  ["unopenable coordination database", new ConfigMutationLockError("fixture unavailable", { cause: { code: "SQLITE_CANTOPEN" } })],
  ["busy cause outside the lock error class", new Error("fixture failure", { cause: { code: "SQLITE_BUSY" } })],
] as const) {
  test(`confirmed redemption stops settlement immediately on ${label}`, async () => {
    const redeem = confirmedRedemption();
    const settle = spyOn(ledger, "recordGrokResetCouponSettlement").mockImplementation(() => { throw error; });
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    spies.push(settle, sleep);
    const response = await handleGrokCouponRoutes(request());
    expect(await response!.json()).toMatchObject({ code: "redeemed", settlementRecorded: false });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    const attempted = readFileSync(ledger.grokCouponJournalPath(), "utf8");
    expect(JSON.parse(attempted).operations[OP].status).toBe("attempted");
    expect((await handleGrokCouponRoutes(request()))!.status).toBe(409);
    expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(attempted);
    expect(redeem).toHaveBeenCalledTimes(1);
  });
}

test("confirmed redemption exhausts five local settlement attempts without another spend", async () => {
  const redeem = confirmedRedemption();
  const settle = spyOn(ledger, "recordGrokResetCouponSettlement").mockImplementation(() => { throw busySettlement(); });
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  spies.push(settle, sleep);
  const response = await handleGrokCouponRoutes(request());
  expect(await response!.json()).toMatchObject({ code: "redeemed", settlementRecorded: false });
  expect(settle).toHaveBeenCalledTimes(5);
  expect(sleep.mock.calls).toEqual([[20], [20], [20], [20]]);
  const attempted = readFileSync(ledger.grokCouponJournalPath(), "utf8");
  expect(JSON.parse(attempted).operations[OP].status).toBe("attempted");
  expect((await handleGrokCouponRoutes(request()))!.status).toBe(409);
  expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(attempted);
  expect(redeem).toHaveBeenCalledTimes(1);
});

for (const changed of ["account", "token", "status"] as const) {
  test(`settlement retry stops when the ${changed} guard changes while waiting`, async () => {
    const redeem = confirmedRedemption();
    const realSettlement = ledger.recordGrokResetCouponSettlement;
    const settle = spyOn(ledger, "recordGrokResetCouponSettlement").mockImplementation(realSettlement)
      .mockImplementationOnce(() => { throw busySettlement(); });
    let guardedBytes = "";
    const sleep = spyOn(Bun, "sleep").mockImplementation(async () => {
      const state = JSON.parse(readFileSync(ledger.grokCouponJournalPath(), "utf8"));
      if (changed === "account") state.operations[OP].accountId = "another-fixture-account";
      if (changed === "token") state.operations[OP].tokenId = "another-fixture-token";
      if (changed === "status") Object.assign(state.operations[OP], { status: "settled", code: "redeemed" });
      guardedBytes = JSON.stringify(state);
      writeFileSync(ledger.grokCouponJournalPath(), guardedBytes);
    });
    spies.push(settle, sleep);
    const response = await handleGrokCouponRoutes(request());
    expect(await response!.json()).toMatchObject({ code: "redeemed", settlementRecorded: false });
    expect(settle).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(guardedBytes);
    expect(redeem).toHaveBeenCalledTimes(1);
  });
}

test("only one independently opened request can claim the spend", () => {
  expect(ledger.openGrokResetCouponOperation(identity()).kind).toBe("execute");
  expect(ledger.openGrokResetCouponOperation(identity()).kind).toBe("execute");
  expect(ledger.markGrokResetCouponAttempt(OP, TOKEN.tokenId)).toBe(true);
  const attempted = readFileSync(ledger.grokCouponJournalPath(), "utf8");
  expect(ledger.markGrokResetCouponAttempt(OP, TOKEN.tokenId)).toBe(false);
  expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(attempted);
});

test("settlement checks claim state and identity and never replaces a terminal result", () => {
  ledger.openGrokResetCouponOperation(identity());
  const confirmed = { operationId: OP, accountId: "fixture-account", tokenId: TOKEN.tokenId,
    code: "redeemed", status: "success" as const, expectedStatus: "attempted" as const };
  expect(ledger.recordGrokResetCouponSettlement(confirmed)).toBe(false);
  ledger.markGrokResetCouponAttempt(OP, TOKEN.tokenId);
  const attempted = readFileSync(ledger.grokCouponJournalPath(), "utf8");
  expect(ledger.recordGrokResetCouponSettlement({ ...confirmed, accountId: "another-fixture-account" })).toBe(false);
  expect(ledger.recordGrokResetCouponSettlement({ ...confirmed, tokenId: "another-fixture-token" })).toBe(false);
  expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(attempted);
  expect(ledger.recordGrokResetCouponSettlement(confirmed)).toBe(true);
  const settled = readFileSync(ledger.grokCouponJournalPath(), "utf8");
  expect(ledger.recordGrokResetCouponSettlement({ operationId: OP, accountId: "fixture-account",
    code: "no_coupons_available", status: "failed", expectedStatus: "open" })).toBe(false);
  expect(ledger.recordGrokResetCouponSettlement(confirmed)).toBe(false);
  expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(settled);
});

test("a route does not spend after a competing request claims during inspection", async () => {
  const auth = spyOn(oauth, "getValidAccessSnapshotForAccount").mockResolvedValue({ accessToken: "fixture-access-token" } as never);
  const remaining = spyOn(coupons, "getGrokRemainingResets").mockImplementation(async () => {
    // Claim the same shared ledger from a real second process while inspection waits.
    const moduleUrl = pathToFileURL(repoPath("src/grok/reset-coupon-ledger.ts")).href;
    const child = Bun.spawnSync([process.execPath, "-e", `import { markGrokResetCouponAttempt } from ${JSON.stringify(moduleUrl)};
      markGrokResetCouponAttempt(${JSON.stringify(OP)}, ${JSON.stringify(TOKEN.tokenId)}); console.log("marked");`], {
      env: { ...process.env, OPENCODEX_HOME: home }, timeout: watchdogMs(10_000), stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe("marked");
    return { tokens: [TOKEN] } as never;
  });
  const redeem = spyOn(coupons, "redeemGrokResetCoupon").mockResolvedValue(undefined as never);
  spies.push(auth, remaining, redeem);
  const response = await handleGrokCouponRoutes(request());
  expect(response!.status).toBe(409);
  expect((await response!.json()).error.code).toBe("attempt_in_progress");
  expect(redeem).not.toHaveBeenCalled();
});

test("a full ledger still replays its existing settled operation", () => {
  const operations = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i === 0 ? OP : `fixture-${i}`, {
    accountId: "fixture-account", tokenId: TOKEN.tokenId, status: "settled", code: "redeemed", createdAt: Date.now(), updatedAt: Date.now(),
  }]));
  writeFileSync(ledger.grokCouponJournalPath(), JSON.stringify({ version: 1, operations }));
  expect(ledger.openGrokResetCouponOperation(identity())).toMatchObject({ kind: "replay", code: "redeemed" });
});

test("an unreadable ledger refuses new spends and preserves its bytes", async () => {
  const path = ledger.grokCouponJournalPath();
  writeFileSync(path, "{interrupted-write");
  const auth = spyOn(oauth, "getValidAccessSnapshotForAccount").mockResolvedValue({ accessToken: "fixture-access-token" } as never);
  const remaining = spyOn(coupons, "getGrokRemainingResets").mockResolvedValue({ tokens: [TOKEN] } as never);
  const redeem = spyOn(coupons, "redeemGrokResetCoupon").mockResolvedValue(undefined as never);
  spies.push(auth, remaining, redeem);
  const response = await handleGrokCouponRoutes(request());
  expect(response!.status).toBe(503);
  expect((await response!.json()).error.code).toBe("ledger_unavailable");
  expect(readFileSync(path, "utf8")).toBe("{interrupted-write");
  expect(remaining).not.toHaveBeenCalled();
  expect(redeem).not.toHaveBeenCalled();
});

test("a transport failure remains attempted instead of recording a definitive failure", async () => {
  const auth = spyOn(oauth, "getValidAccessSnapshotForAccount").mockResolvedValue({ accessToken: "fixture-access-token" } as never);
  const remaining = spyOn(coupons, "getGrokRemainingResets").mockResolvedValue({ tokens: [TOKEN] } as never);
  const redeem = spyOn(coupons, "redeemGrokResetCoupon").mockRejectedValue(new Error("fixture timeout after dispatch"));
  spies.push(auth, remaining, redeem);
  const response = await handleGrokCouponRoutes(request());
  expect(response!.status).toBe(502);
  expect(ledger.openGrokResetCouponOperation(identity())).toMatchObject({ kind: "replay", code: undefined, tokenId: TOKEN.tokenId });
  expect(redeem).toHaveBeenCalledTimes(1);
  const retry = await handleGrokCouponRoutes(request());
  expect(retry!.status).toBe(409);
  expect(redeem).toHaveBeenCalledTimes(1);
});

test("an unconfirmed HTTP 200 redemption preserves attempted state rather than recording success", async () => {
  const realRedeem = coupons.redeemGrokResetCoupon;
  const auth = spyOn(oauth, "getValidAccessSnapshotForAccount").mockResolvedValue({ accessToken: "fixture-access-token" } as never);
  const remaining = spyOn(coupons, "getGrokRemainingResets").mockResolvedValue({ tokens: [TOKEN] } as never);
  const redeem = spyOn(coupons, "redeemGrokResetCoupon").mockImplementation(options => realRedeem({
    ...options, fetchFn: async () => new Response(null, { status: 200 }),
  }));
  spies.push(auth, remaining, redeem);
  const response = await handleGrokCouponRoutes(request());
  expect(response!.status).toBe(502);
  expect((await response!.json()).error.code).toBe("attempt_unresolved");
  expect(ledger.openGrokResetCouponOperation(identity())).toMatchObject({ kind: "replay", code: undefined });
  expect(JSON.parse(readFileSync(ledger.grokCouponJournalPath(), "utf8")).operations[OP].status).toBe("attempted");
  expect(redeem).toHaveBeenCalledTimes(1);
});

test("a stale attempt with a still-listed token is inspected without a second spend", async () => {
  ledger.openGrokResetCouponOperation(identity());
  ledger.markGrokResetCouponAttempt(OP, TOKEN.tokenId, Date.now() - 120_000);
  const auth = spyOn(oauth, "getValidAccessSnapshotForAccount").mockResolvedValue({ accessToken: "fixture-access-token" } as never);
  const remaining = spyOn(coupons, "getGrokRemainingResets").mockResolvedValue({ tokens: [TOKEN] } as never);
  const redeem = spyOn(coupons, "redeemGrokResetCoupon").mockResolvedValue(undefined as never);
  spies.push(auth, remaining, redeem);
  const response = await handleGrokCouponRoutes(request());
  // A listed token and an old local timestamp cannot rule out a delayed upstream completion.
  expect(redeem).not.toHaveBeenCalled();
  expect(response!.status).toBe(409);
  expect((await response!.json()).error.code).toBe("attempt_unresolved");
  expect(remaining).toHaveBeenCalledTimes(1);
});

for (const refusal of ["no_coupons_available", "coupon_unavailable"] as const) {
  for (const winnerState of ["attempted", "settled"] as const) {
    test(`late ${refusal} inspection preserves a competing ${winnerState} operation`, async () => {
      const omitToken = refusal === "no_coupons_available";
      let releaseInspection!: (value: { tokens: typeof TOKEN[] }) => void;
      let enteredInspection!: () => void;
      const inspectionStarted = new Promise<void>(resolve => { enteredInspection = resolve; });
      let releaseRedemption!: () => void;
      let enteredRedemption!: () => void;
      const redemptionStarted = new Promise<void>(resolve => { enteredRedemption = resolve; });
      let inspectionCalls = 0;
      const auth = spyOn(oauth, "getValidAccessSnapshotForAccount").mockResolvedValue({ accessToken: "fixture-access-token" } as never);
      const remaining = spyOn(coupons, "getGrokRemainingResets").mockImplementation(() => {
        if (++inspectionCalls === 1) {
          enteredInspection();
          return new Promise(resolve => { releaseInspection = resolve; });
        }
        return Promise.resolve({ tokens: [TOKEN] });
      });
      const redeem = spyOn(coupons, "redeemGrokResetCoupon").mockImplementation(() => new Promise(resolve => {
        releaseRedemption = () => resolve(undefined as never);
        enteredRedemption();
      }));
      spies.push(auth, remaining, redeem);
      const loser = handleGrokCouponRoutes(request(omitToken));
      await inspectionStarted;
      const winner = handleGrokCouponRoutes(request(omitToken));
      try {
        await redemptionStarted;
        if (winnerState === "settled") {
          releaseRedemption();
          expect((await winner)!.status).toBe(200);
        }
        const before = readFileSync(ledger.grokCouponJournalPath(), "utf8");
        expect(JSON.parse(before).operations[OP].status).toBe(winnerState);
        releaseInspection({ tokens: [] });
        const result = (await loser)!;
        expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(before);
        expect(result.status).toBe(winnerState === "settled" ? 200 : 409);
        const body = await result.json();
        if (winnerState === "settled") expect(body).toMatchObject({ code: "redeemed", replayed: true, tokenId: TOKEN.tokenId });
        else expect(body.error.code).toBe("operation_state_changed");
        expect(body.success).toBeUndefined();
        expect(redeem).toHaveBeenCalledTimes(1);
      } finally {
        releaseInspection({ tokens: [] });
        releaseRedemption();
        await Promise.all([loser, winner]);
      }
      expect(ledger.openGrokResetCouponOperation(identity())).toMatchObject({ kind: "replay", code: "redeemed" });
    });
  }
}

for (const omitToken of [false, true]) {
  test(`concurrent definitive refusals replay the terminal winner (omit token ${omitToken})`, async () => {
    let release!: (value: { tokens: typeof TOKEN[] }) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const auth = spyOn(oauth, "getValidAccessSnapshotForAccount").mockResolvedValue({ accessToken: "fixture-access-token" } as never);
    const remaining = spyOn(coupons, "getGrokRemainingResets").mockImplementation(() => {
      if (++calls === 1) { entered(); return new Promise(resolve => { release = resolve; }); }
      return Promise.resolve({ tokens: [] });
    });
    const redeem = spyOn(coupons, "redeemGrokResetCoupon").mockResolvedValue({ success: true, status: 0 });
    spies.push(auth, remaining, redeem);
    const loser = handleGrokCouponRoutes(request(omitToken));
    await started;
    try {
      const code = omitToken ? "no_coupons_available" : "coupon_unavailable";
      expect((await (await handleGrokCouponRoutes(request(omitToken)))!.json()).error.code).toBe(code);
      const before = readFileSync(ledger.grokCouponJournalPath(), "utf8");
      release({ tokens: [] });
      const response = (await loser)!;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ code, replayed: true });
      expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(before);
      expect(redeem).not.toHaveBeenCalled();
    } finally { release({ tokens: [] }); await loser; }
  });
}

for (const [status, code, accountId, tokenId, replay] of [
  ["failed", "auth_failed", "fixture-account", TOKEN.tokenId, true],
  ["settled", "redeemed", "fixture-account", TOKEN.tokenId, true],
  ["failed", "coupon_unavailable", "another-account", TOKEN.tokenId, false],
  ["failed", "coupon_unavailable", "fixture-account", "another-token", false],
  ["attempted", "redeemed", "fixture-account", TOKEN.tokenId, false],
  ["failed", undefined, "fixture-account", TOKEN.tokenId, false],
  ...["redeem_failed", "attempt_unresolved", "attempt_in_progress", "attempt_reconcile_failed", "operation_state_changed"]
    .map(code => ["failed", code, "fixture-account", TOKEN.tokenId, false] as const),
] as const) {
  test(`preflight winner replay guards ${status}/${code}/${accountId}/${tokenId}`, () => {
    const path = ledger.grokCouponJournalPath();
    const before = JSON.stringify({ version: 2, operations: { [OP]: {
      status, code, accountId, tokenId, createdAt: Date.now(), updatedAt: Date.now(),
    } } });
    writeFileSync(path, before);
    const read = fs.readFileSync;
    let journalReads = 0;
    const guardedRead = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
      if (args[0] === path) {
        // The terminal decision reads one snapshot while the real mutation transaction is held.
        expect(() => readConfigGenerationInCurrentMutationTransaction()).not.toThrow();
        journalReads += 1;
      }
      return read(...args as [never, never]);
    });
    spies.push(guardedRead);
    const result = ledger.settleGrokResetCouponPreflightRefusal({
      ...identity(), code: "coupon_unavailable", status: "failed", expectedStatus: "open",
    });
    expect(result).toMatchObject(replay ? { kind: "replay", code, tokenId } : { kind: "changed" });
    expect(journalReads).toBe(1);
    const winner = ledger.readGrokResetCouponTerminalReplay(OP, "fixture-account", TOKEN.tokenId);
    expect(winner).toEqual(replay ? { kind: "replay", code, tokenId, settledAt: JSON.parse(before).operations[OP].updatedAt } : null);
    expect(journalReads).toBe(2);
    guardedRead.mockRestore();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
}

for (const [winnerState, replayFailure] of [
  ["failed", null], ["settled", null], ["attempted", null], ["attempted", "busy"], ["attempted", "read"],
] as const) {
  test(`late positive inspection replays only a definitive ${winnerState} claim winner (read failure ${replayFailure})`, async () => {
    if (replayFailure) spies.push(spyOn(ledger, "readGrokResetCouponTerminalReplay").mockImplementation(() => {
      throw replayFailure === "busy" ? busySettlement() : new Error("fixture unreadable winner");
    }));
    let release!: (value: { tokens: typeof TOKEN[] }) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let reads = 0;
    const assertOutsideTransaction = () => expect(() => readConfigGenerationInCurrentMutationTransaction()).toThrow();
    const auth = spyOn(oauth, "getValidAccessSnapshotForAccount").mockImplementation(async () => {
      assertOutsideTransaction();
      return { accessToken: "fixture-access-token" } as never;
    });
    const remaining = spyOn(coupons, "getGrokRemainingResets").mockImplementation(() => {
      assertOutsideTransaction();
      if (++reads === 1) { entered(); return new Promise(resolve => { release = resolve; }); }
      return Promise.resolve({ tokens: winnerState === "failed" ? [] : [TOKEN] });
    });
    const redeem = spyOn(coupons, "redeemGrokResetCoupon").mockImplementation(async () => {
      assertOutsideTransaction();
      if (winnerState === "attempted") throw new Error("fixture lost delivery");
      return { success: true, status: 0 };
    });
    spies.push(auth, remaining, redeem);
    const loser = handleGrokCouponRoutes(request());
    await started;
    try {
      const winner = (await handleGrokCouponRoutes(request()))!;
      expect(winner.status).toBe(winnerState === "failed" ? 409 : winnerState === "settled" ? 200 : 502);
      const before = readFileSync(ledger.grokCouponJournalPath(), "utf8");
      expect(JSON.parse(before).operations[OP].status).toBe(winnerState);
      release({ tokens: [TOKEN] });
      const response = (await loser)!;
      expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(before);
      expect(response.status).toBe(winnerState === "attempted" ? 409 : 200);
      const body = await response.json();
      if (winnerState === "attempted") {
        expect(body.error.code).toBe("attempt_in_progress");
        expect(body.code).toBeUndefined();
        expect(body.replayed).toBeUndefined();
      } else {
        const expectedCode = winnerState === "failed" ? "coupon_unavailable" : "redeemed";
        expect(body).toEqual({ code: expectedCode, replayed: true, tokenId: TOKEN.tokenId,
          settledAt: JSON.parse(before).operations[OP].updatedAt });
        const replay = (await handleGrokCouponRoutes(request()))!;
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(body);
      }
      expect(redeem).toHaveBeenCalledTimes(winnerState === "failed" ? 0 : 1);
    } finally { release({ tokens: [TOKEN] }); await loser; }
  });
}

test("a missing or still-open operation has no terminal replay", () => {
  expect(ledger.readGrokResetCouponTerminalReplay(OP, "fixture-account", TOKEN.tokenId)).toBeNull();
  ledger.openGrokResetCouponOperation(identity());
  const before = readFileSync(ledger.grokCouponJournalPath(), "utf8");
  expect(ledger.readGrokResetCouponTerminalReplay(OP, "fixture-account", TOKEN.tokenId)).toBeNull();
  expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(before);
});

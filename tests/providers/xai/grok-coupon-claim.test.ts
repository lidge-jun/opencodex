import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as oauth from "../../../src/oauth";
import * as coupons from "../../../src/grok/reset-coupons";
import * as ledger from "../../../src/grok/reset-coupon-ledger";
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
function request(): ManagementContext {
  const url = new URL("http://localhost/api/grok/reset-coupons/consume");
  const req = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(identity()) });
  return { req, url, config: {}, deps: {}, version: "test" } as ManagementContext;
}

test("only one independently opened request can claim the spend", () => {
  expect(ledger.openGrokResetCouponOperation(identity()).kind).toBe("execute");
  expect(ledger.openGrokResetCouponOperation(identity()).kind).toBe("execute");
  expect(ledger.markGrokResetCouponAttempt(OP, TOKEN.tokenId)).toBe(true);
  const attempted = readFileSync(ledger.grokCouponJournalPath(), "utf8");
  expect(ledger.markGrokResetCouponAttempt(OP, TOKEN.tokenId)).toBe(false);
  expect(readFileSync(ledger.grokCouponJournalPath(), "utf8")).toBe(attempted);
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

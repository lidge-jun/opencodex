import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnthropicInstanceFixture, type AnthropicInstanceFixture } from "../helpers/anthropic-instance-fixture";
import { readLoadedDecisionQuotaPool } from "../../src/providers/quota-decision-snapshot";
import { anthropicCooldownRecoveryFor } from "../../src/providers/quota/anthropic-cooldown-recovery";
import { recordAnthropicAccountQuotaFromHeadersForInstance } from "../../src/providers/quota/account-cache";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { jevQuotaSignalForTarget } from "../../src/combos/jev-quota";
import { setAccountPaused } from "../../src/oauth/store";
import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";

// Both pools deliberately share account ids, so an unscoped publisher would collide.
let f: AnthropicInstanceFixture;
beforeEach(async () => { f = await createAnthropicInstanceFixture(); await f.seed(); });
afterEach(async () => { await f.dispose(); });

/** Read the loaded primary-pool decision windows for an account id. */
const windowsOf = (id: string) => readLoadedDecisionQuotaPool("anthropic")?.find(row => row.id === id)?.windows;
/** Credential generation of an account in the given Anthropic instance. */
const generationOf = (instance: AnthropicInstanceId, id: string) =>
  f.store.credentialGeneration(f.store.getAccountCredential(instance, id)!);
/** Force the strongest collision: same id AND same credential generation in both pools. */
async function collidePool2Credential(id: string): Promise<void> {
  await f.store.mutateStore(auth => {
    const primary = auth.anthropic!.accounts.find(row => row.id === id)!.credential;
    auth.anthropic2!.accounts.find(row => row.id === id)!.credential = { ...primary };
  });
  expect(generationOf("anthropic2", id)).toBe(generationOf("anthropic", id));
}
/** Publish a quota probe result for an account through the instance's real cooldown-recovery path. */
async function publishProbe(instance: AnthropicInstanceId, id: string, weeklyPercent: number): Promise<void> {
  const token = f.store.getAccountCredential(instance, id)!.access;
  const result = await anthropicCooldownRecoveryFor(instance).probeAnthropicQuotaWithRecovery(
    id, token, async () => ({ weeklyPercent, updatedAt: Date.now() }), () => true);
  result!.publishDecisionQuota();
}

test("only the primary pool roster is published; Pool 2 has no advisory roster", () => {
  expect(readLoadedDecisionQuotaPool("anthropic")?.map(row => row.id)).toEqual([...f.ids]);
  expect(readLoadedDecisionQuotaPool("anthropic2")).toBeUndefined();
});

test("a Pool 2 usage probe cannot publish onto a primary account with the same id and credential generation", async () => {
  const id = f.ids[0];
  await collidePool2Credential(id);
  await publishProbe("anthropic2", id, 95);
  expect(windowsOf(id)).toBeUndefined();
  await publishProbe("anthropic", id, 40);
  expect(windowsOf(id)?.[0]?.percent).toBe(40);
});

test("Pool 2 response headers cannot publish onto a primary account with the same id and credential generation", async () => {
  const id = f.ids[0];
  await collidePool2Credential(id);
  const headers = new Headers({ "anthropic-ratelimit-unified-7d-utilization": "0.95" });
  recordAnthropicAccountQuotaFromHeadersForInstance("anthropic2", id, headers, captureConfigGeneration(), 200, f.model, generationOf("anthropic2", id));
  expect(windowsOf(id)).toBeUndefined();
  recordAnthropicAccountQuotaFromHeadersForInstance("anthropic", id, headers, captureConfigGeneration(), 200, f.model, generationOf("anthropic", id));
  expect(windowsOf(id)?.[0]?.percent).toBeCloseTo(95, 8);
});

test("Pool 2 account state does not change primary usability or retained primary evidence", async () => {
  const id = f.ids[0];
  await publishProbe("anthropic", id, 40);
  await setAccountPaused("anthropic2", id, true);
  expect(readLoadedDecisionQuotaPool("anthropic")?.find(row => row.id === id)).toMatchObject({ usable: true });
  expect(windowsOf(id)?.[0]?.percent).toBe(40);
  await setAccountPaused("anthropic", id, true);
  expect(readLoadedDecisionQuotaPool("anthropic")?.find(row => row.id === id)?.usable).toBe(false);
});

test("a Pool 2 target is unknown while the same-id primary pool carries advisory evidence", async () => {
  for (const id of f.ids) await publishProbe("anthropic", id, 95);
  const now = Date.now();
  expect(jevQuotaSignalForTarget(f.config, "anthropic", f.model, now).tier).toBe("nearly_exhausted");
  expect(jevQuotaSignalForTarget(f.config, "anthropic2", f.model, now)).toEqual({ tier: "unknown" });
});

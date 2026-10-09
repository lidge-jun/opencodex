import { afterEach, expect, test } from "bun:test";
import { fetchAnthropicUsageQuota, fetchAnthropicUsageQuotaForInstance } from "../../src/providers/quota/vendor-probes-oauth";
import { clearAccountQuotaCache } from "../../src/providers/quota/account-cache";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearAccountQuotaCache(); });

test("equal bearers join within one instance but never across instances", async () => {
  const replies: Array<(response: Response) => void> = [];
  globalThis.fetch = (() => new Promise<Response>(resolve => replies.push(resolve))) as typeof fetch;
  const a = fetchAnthropicUsageQuota("synthetic-instance-quota-token");
  const aJoined = fetchAnthropicUsageQuotaForInstance("anthropic", "synthetic-instance-quota-token");
  const b = fetchAnthropicUsageQuotaForInstance("anthropic2", "synthetic-instance-quota-token");
  expect(replies).toHaveLength(2);
  replies[0]!(Response.json({ five_hour: { utilization: 12 } }));
  replies[1]!(Response.json({ five_hour: { utilization: 81 } }));
  expect((await a)?.fiveHourPercent).toBe(12);
  expect((await aJoined)?.fiveHourPercent).toBe(12);
  expect((await b)?.fiveHourPercent).toBe(81);
});

test("B cache clear starts a fresh B dispatch while preserving an A flight", async () => {
  const replies: Array<(response: Response) => void> = [];
  globalThis.fetch = (() => new Promise<Response>(resolve => replies.push(resolve))) as typeof fetch;
  const a = fetchAnthropicUsageQuotaForInstance("anthropic", "synthetic-epoch-quota-token");
  const oldB = fetchAnthropicUsageQuotaForInstance("anthropic2", "synthetic-epoch-quota-token");
  clearAccountQuotaCache("anthropic2");
  const joinedA = fetchAnthropicUsageQuotaForInstance("anthropic", "synthetic-epoch-quota-token");
  const newB = fetchAnthropicUsageQuotaForInstance("anthropic2", "synthetic-epoch-quota-token");
  expect(replies).toHaveLength(3);
  replies.forEach((reply, index) => reply(Response.json({ five_hour: { utilization: 10 + index } })));
  expect((await a)?.fiveHourPercent).toBe(10);
  expect((await joinedA)?.fiveHourPercent).toBe(10);
  expect((await oldB)?.fiveHourPercent).toBe(11);
  expect((await newB)?.fiveHourPercent).toBe(12);
});

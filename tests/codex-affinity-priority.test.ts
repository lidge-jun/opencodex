import { test, expect } from "bun:test";
import { selectPriorityTier } from "/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src/codex/pool-rotation";
const source = await Bun.file("/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src/codex/routing.ts").text();
// Execute the actual routing functions in a deterministic, credential-free harness.
const extract = (name: string) => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start) + 2;
  return source.slice(start, end);
};
function harness(eligible = ["plus", "prolite"], pin?: string) {
  const priority = (id: string) => id === "plus" ? 2 : -1;
  const deps = {
    getEligiblePoolAccounts: () => selectPriorityTier(eligible, priority, () => true, pin),
    pinnedCodexAccountId: () => pin,
    hasCodexQuotaHeadroom: () => true,
    codexAccountPriorityLookup: () => priority,
    pickLowestUsageAmong: (_: unknown, ids: string[]) => ids[0] ?? null,
    normalizeAccountPoolStrategy: (s: string) => s ?? "quota",
    computeCodexUsageScore: () => 10,
    getAccountQuota: () => ({}), getPoolAccountPlanForSelection: () => "plus",
    isUnknownUsage: () => false, CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS: 60000,
    pickLowerUsageAccount: () => null,
    isThreadAffinityExpired: () => false, isThreadAffinityGenerationLive: () => true,
    isCodexAccountSelectable: () => true, shouldFailover: () => false,
  };
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(
    ["pickPriorityPreemption", "reevaluateAffinityQuota", "previewReusableAffinityAccount"].map(extract).join("\n")
    + "\nreturn {reevaluateAffinityQuota,previewReusableAffinityAccount};",
  );
  return new Function(...Object.keys(deps), js)(...Object.values(deps));
}
const entry = { accountId: "prolite", lastReevalAt: 1000 };
test("old binding moves upward immediately in all strategies, including preview", () => {
  const h = harness();
  for (const accountPoolStrategy of ["quota", "fill-first", "round-robin"]) {
    expect(h.reevaluateAffinityQuota(entry, { accountPoolStrategy }, 1001)).toBe("plus");
    expect(h.previewReusableAffinityAccount(entry, { accountPoolStrategy }, 1001)).toBe("plus");
  }
});
test("unavailable/model-ineligible higher tier cannot preempt", () => {
  expect(harness(["prolite"]).reevaluateAffinityQuota(entry, {}, 1001)).toBeNull();
});
test("explicit manual pin retains its priority ceiling", () => {
  expect(harness(undefined, "prolite").reevaluateAffinityQuota(entry, {}, 1001)).toBeNull();
});
test("higher tier already bound does not switch down", () => {
  expect(harness().reevaluateAffinityQuota({ ...entry, accountId: "plus" }, {}, 1001)).toBeNull();
});

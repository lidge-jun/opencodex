import { expect, test } from "bun:test";
import { affinityResetRetries, beginAffinityResetOperation, clearAffinityResetRetry,
  rememberAffinityResetRetry, type AffinityResetRetry } from "../src/provider-affinity-reset-retries";

const set = (accountId: string): AffinityResetRetry => ({ kind: "pause", accountId, paused: true });
const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
test.each(orders)("late receipts preserve intent order for completion permutation %j", (...order) => {
  const server = `/ordered-${order.join("")}`;
  const operations = [0, 1, 2].map(() => beginAffinityResetOperation(server, "p"));
  const effects = [() => operations[0](() => set("a"), true),
    () => operations[1](pending => pending?.kind === "pause" && pending.accountId === "a" ? { ...pending, paused: false } : pending),
    () => operations[2](pending => pending?.accountId === "a" ? { kind: "reset", accountId: "a" } : pending)];
  for (const index of order) effects[index]();
  expect(affinityResetRetries(server).p).toEqual({ kind: "reset", accountId: "a" });
  clearAffinityResetRetry(server, "p");
});

test.each([false, true])("newest committed receipt wins with reverse arrival %p", reverse => {
  const server = `/latest-${reverse}`;
  const older = beginAffinityResetOperation(server, "p");
  const newer = beginAffinityResetOperation(server, "p");
  if (reverse) newer(() => set("b"), true);
  older(() => set("a"), true);
  if (!reverse) newer(() => set("b"), true);
  expect(affinityResetRetries(server).p).toEqual(set("b"));
  clearAffinityResetRetry(server, "p");
});

test("empty clear fences an older unknown receipt and duplicate completion", () => {
  const old = beginAffinityResetOperation("/aba", "p");
  clearAffinityResetRetry("/aba", "p");
  old(() => set("a"), true);
  old(() => set("b"), true);
  expect(affinityResetRetries("/aba").p).toBeUndefined();
});

test("newer uncommitted failure preserves late older committed debt", () => {
  const older = beginAffinityResetOperation("/failed", "p");
  const newer = beginAffinityResetOperation("/failed", "p");
  newer();
  older(() => set("a"), true);
  expect(affinityResetRetries("/failed").p).toEqual(set("a"));
  clearAffinityResetRetry("/failed", "p");
});

test("barriers compact pending prefixes without losing later transformations or crossing servers", () => {
  const old = beginAffinityResetOperation("/compact", "p");
  const confirm = beginAffinityResetOperation("/compact", "p");
  const newest = beginAffinityResetOperation("/compact", "p");
  rememberAffinityResetRetry("/other", "p", set("other"));
  rememberAffinityResetRetry("/compact", "q", set("q"));
  newest(() => set("b"), true);
  confirm(() => undefined, true);
  old(() => set("a"), true);
  expect(affinityResetRetries("/compact").p).toEqual(set("b"));
  expect(affinityResetRetries("/compact").q).toEqual(set("q"));
  expect(affinityResetRetries("/other").p).toEqual(set("other"));
  for (const [server, provider] of [["/compact", "p"], ["/compact", "q"], ["/other", "p"]]) clearAffinityResetRetry(server, provider);
});

test("unchanged publication preserves the React snapshot while still fencing old operations", () => {
  rememberAffinityResetRetry("/stable", "p", set("a"));
  const before = affinityResetRetries("/stable");
  const older = beginAffinityResetOperation("/stable", "p");
  rememberAffinityResetRetry("/stable", "p", set("a"));
  expect(affinityResetRetries("/stable")).toBe(before);
  older(() => undefined, true);
  expect(affinityResetRetries("/stable")).toBe(before);
  clearAffinityResetRetry("/stable", "p");
});

test("a retired callback cannot affect a fresh journal for the same server and provider", () => {
  const retired = beginAffinityResetOperation("/fresh", "p");
  clearAffinityResetRetry("/fresh", "p");
  const fresh = beginAffinityResetOperation("/fresh", "p");
  retired(() => set("old"), true);
  fresh(() => set("new"), true);
  retired(() => undefined, true);
  expect(affinityResetRetries("/fresh").p).toEqual(set("new"));
  clearAffinityResetRetry("/fresh", "p");
});

test("compaction agrees with an uncompacted intent fold across settlement orders", () => {
  type Retry = AffinityResetRetry | undefined;
  const effects: Array<{ reduce: (value: Retry) => Retry; barrier?: boolean }> = [
    { reduce: () => set("a"), barrier: true }, { reduce: () => set("b"), barrier: true },
    { reduce: () => undefined, barrier: true }, { reduce: value => value },
    { reduce: value => value?.kind === "pause" && value.accountId === "a" ? { ...value, paused: false } : value },
    { reduce: value => value?.accountId === "a" ? { kind: "reset", accountId: "a" } : value },
  ];
  for (let a = 0; a < effects.length; a++) for (let b = 0; b < effects.length; b++) for (let c = 0; c < effects.length; c++) {
    const sequence = [effects[a], effects[b], effects[c]];
    for (const order of orders) {
      const operations = sequence.map(() => beginAffinityResetOperation("/reference", "p"));
      const settled = new Set<number>();
      for (const index of order) {
        settled.add(index);
        operations[index](sequence[index].reduce, sequence[index].barrier);
        const expected = sequence.reduce<Retry>((value, effect, i) => settled.has(i) ? effect.reduce(value) : value, undefined);
        expect(affinityResetRetries("/reference").p).toEqual(expected);
      }
      clearAffinityResetRetry("/reference", "p");
    }
  }
});

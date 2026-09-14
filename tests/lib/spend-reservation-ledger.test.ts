import { describe, expect, test } from "bun:test";
import {
  createSpendReservationLedger,
  type SpendJournal,
  type SpendReservationPolicy,
} from "../../src/lib/spend-reservation-ledger";

/** In-memory journal: same replay contract as the file store, without touching disk. */
const memoryJournal = (): SpendJournal & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, read: () => [...lines], append: (line) => { lines.push(line); } };
};

const policy = (maxTokens: number | undefined, retentionMs = 60_000): SpendReservationPolicy => ({
  root: { maxTokens },
  identity: { maxTokens },
  pool: { maxTokens },
  retentionMs,
});

describe("spend reservation ledger", () => {
  test("reserves input plus the enforceable output ceiling and refuses at the boundary", () => {
    const ledger = createSpendReservationLedger({ policy: policy(100), now: () => 1_000 });
    // 60 input + 40 ceiling = 100 exactly: the boundary admits.
    expect(ledger.reserve({
      sendId: "s1",
      scopes: { rootId: "r1" },
      inputTokens: 60,
      outputCeilingTokens: 40,
    }).reserved).toBe(true);
    // One more token projects past the limit and is refused, naming the scope.
    const denied = ledger.reserve({
      sendId: "s2",
      scopes: { rootId: "r1" },
      inputTokens: 1,
      outputCeilingTokens: 0,
    });
    expect(denied.reserved).toBe(false);
    if (!denied.reserved) {
      expect(denied.denial.scope).toBe("root");
      expect(denied.denial.limit).toBe(100);
      expect(denied.denial.projected).toBe(101);
    }
    // The refused reservation booked nothing: settling its send id is a no-op.
    expect(ledger.settle("s2", { inputTokens: 1, outputTokens: 0 })).toBe(false);
  });

  test("enforces root, identity and pool scopes at once, so a fresh root id mints no budget", () => {
    const ledger = createSpendReservationLedger({ policy: policy(100), now: () => 1_000 });
    const req = (sendId: string, rootId: string) => ({
      sendId,
      scopes: { rootId, identityId: "user-1", poolId: "pool-1" },
      inputTokens: 60,
      outputCeilingTokens: 40,
    });
    expect(ledger.reserve(req("s1", "root-a")).reserved).toBe(true);
    // A brand-new root still carries the identity and pool spend: all three scopes are
    // checked, so laundering through a fresh root id fails on the identity scope.
    const denied = ledger.reserve(req("s2", "root-b"));
    expect(denied.reserved).toBe(false);
    if (!denied.reserved) expect(denied.denial.scope).toBe("identity");
    // A different identity under the same pool is still stopped at the pool scope.
    const poolDenied = ledger.reserve({
      sendId: "s3",
      scopes: { rootId: "root-c", identityId: "user-2", poolId: "pool-1" },
      inputTokens: 60,
      outputCeilingTokens: 40,
    });
    expect(poolDenied.reserved).toBe(false);
    if (!poolDenied.reserved) expect(poolDenied.denial.scope).toBe("pool");
  });

  test("settlement is idempotent per send id", () => {
    const ledger = createSpendReservationLedger({ policy: policy(1_000), now: () => 1_000 });
    ledger.reserve({ sendId: "s1", scopes: { rootId: "r1" }, inputTokens: 100, outputCeilingTokens: 100 });
    expect(ledger.settle("s1", { inputTokens: 90, outputTokens: 10 })).toBe(true);
    // The double settlement books nothing: reserved stays released exactly once.
    expect(ledger.settle("s1", { inputTokens: 90, outputTokens: 10 })).toBe(false);
    const snap = ledger.snapshot("root", "r1");
    expect(snap?.settled).toBe(100);
    expect(snap?.reserved).toBe(0);
    // markLost after a settlement is likewise a no-op.
    expect(ledger.markLost("s1")).toBe(false);
  });

  test("lost usage becomes unresolved spend instead of being released", () => {
    const ledger = createSpendReservationLedger({ policy: policy(150), now: () => 1_000 });
    ledger.reserve({ sendId: "s1", scopes: { rootId: "r1" }, inputTokens: 100, outputCeilingTokens: 50 });
    expect(ledger.markLost("s1")).toBe(true);
    const snap = ledger.snapshot("root", "r1");
    expect(snap?.reserved).toBe(0);
    expect(snap?.unresolved).toBe(150);
    // Unresolved spend still counts: the full reservation may have been billed.
    expect(ledger.exhausted("root", "r1")).toBe(true);
    expect(ledger.reserve({
      sendId: "s2", scopes: { rootId: "r1" }, inputTokens: 1, outputCeilingTokens: 0,
    }).reserved).toBe(false);
  });

  test("an exhausted root stays exhausted across a simulated restart", () => {
    const journal = memoryJournal();
    const first = createSpendReservationLedger({ journal, policy: policy(100), now: () => 1_000 });
    first.reserve({ sendId: "s1", scopes: { rootId: "r1" }, inputTokens: 60, outputCeilingTokens: 40 });
    first.settle("s1", { inputTokens: 60, outputTokens: 40 });
    expect(first.exhausted("root", "r1")).toBe(true);

    // Restart: a new ledger replays the same journal and refuses the same root.
    const second = createSpendReservationLedger({ journal, policy: policy(100), now: () => 2_000 });
    expect(second.exhausted("root", "r1")).toBe(true);
    expect(second.reserve({
      sendId: "s2", scopes: { rootId: "r1" }, inputTokens: 1, outputCeilingTokens: 0,
    }).reserved).toBe(false);
    // And the replayed settlement is still idempotent after the rebuild.
    expect(second.settle("s1", { inputTokens: 60, outputTokens: 40 })).toBe(false);
  });

  test("the unconfigured default observes spend but refuses nothing", () => {
    const ledger = createSpendReservationLedger({ now: () => 1_000 });
    for (let i = 0; i < 10; i += 1) {
      expect(ledger.reserve({
        sendId: `s${i}`, scopes: { rootId: "r1" }, inputTokens: 1_000_000, outputCeilingTokens: 1_000_000,
      }).reserved).toBe(true);
    }
    const snap = ledger.snapshot("root", "r1");
    expect(snap?.reserved).toBe(20_000_000);
    expect(snap?.exhausted).toBe(false);
  });

  test("prune removes a dormant under-limit scope but never an exhausted one", () => {
    const journal = memoryJournal();
    const ledger = createSpendReservationLedger({ journal, policy: policy(100, 1_000), now: () => 0 });
    ledger.reserve({ sendId: "s1", scopes: { rootId: "spent" }, inputTokens: 60, outputCeilingTokens: 40 });
    ledger.settle("s1", { inputTokens: 60, outputTokens: 40 });
    ledger.reserve({ sendId: "s2", scopes: { rootId: "light" }, inputTokens: 10, outputCeilingTokens: 0 });
    ledger.settle("s2", { inputTokens: 10, outputTokens: 0 });

    ledger.prune(10_000);
    // Both are idle and past the retention window, but only the under-limit one may go.
    expect(ledger.snapshot("root", "light")).toBeUndefined();
    const spent = ledger.snapshot("root", "spent");
    expect(spent?.exhausted).toBe(true);
    expect(ledger.reserve({
      sendId: "s3", scopes: { rootId: "spent" }, inputTokens: 1, outputCeilingTokens: 0,
    }).reserved).toBe(false);
  });

  test("a torn tail line in the journal is skipped on replay", () => {
    const journal = memoryJournal();
    const first = createSpendReservationLedger({ journal, policy: policy(100), now: () => 1_000 });
    first.reserve({ sendId: "s1", scopes: { rootId: "r1" }, inputTokens: 60, outputCeilingTokens: 40 });
    journal.lines.push("{not-json");
    const second = createSpendReservationLedger({ journal, policy: policy(100), now: () => 2_000 });
    expect(second.exhausted("root", "r1")).toBe(true);
  });
});

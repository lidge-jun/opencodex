import { describe, expect, test } from "bun:test";
import {
  createSpendReservationLedger,
  parseSpendJournalRecord,
  type SpendJournal,
  type SpendReservationPolicy,
} from "../../src/lib/spend-reservation-ledger";

/** In-memory journal: same replay and compaction contract as the file store, without disk. */
const memoryJournal = (): SpendJournal & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    read: () => [...lines],
    append: (line) => { lines.push(line); },
    rewrite: (next) => { lines.length = 0; lines.push(...next); },
  };
};

/** A journal that cannot persist: the disk-full and permission case durability exists for. */
const unwritableJournal = (): SpendJournal => ({
  read: () => [],
  append: () => { throw new Error("ENOSPC: no space left on device"); },
});

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
    // Quietly: the final record is the one that never finished being written, so nothing
    // after it is missing and no total is understated.
    expect(second.corruptRecords).toBe(0);
    expect(second.degraded).toBe(false);
  });
});

describe("spend reservation ledger, send identity", () => {
  test("a duplicate send id is refused instead of authorising a free dispatch", () => {
    const journal = memoryJournal();
    const ledger = createSpendReservationLedger({ journal, policy: policy(1_000), now: () => 1_000 });
    const request = { sendId: "s1", scopes: { rootId: "r1" }, inputTokens: 10, outputCeilingTokens: 10 };
    expect(ledger.reserve(request).reserved).toBe(true);

    // The old behaviour returned success here while booking nothing, so one id bought an
    // unlimited number of physical sends with the scope totals frozen.
    const repeat = ledger.reserve(request);
    expect(repeat.reserved).toBe(false);
    if (!repeat.reserved) expect(repeat.denial.reason).toBe("duplicate-send-id");
    expect(ledger.snapshot("root", "r1")?.reserved).toBe(20);

    // Still refused once the original send resolves...
    expect(ledger.settle("s1", { inputTokens: 10, outputTokens: 10 })).toBe(true);
    expect(ledger.reserve(request).reserved).toBe(false);
    expect(ledger.snapshot("root", "r1")?.settled).toBe(20);

    // ...and after a restart rebuilds the ledger from the journal.
    const restarted = createSpendReservationLedger({ journal, policy: policy(1_000), now: () => 2_000 });
    expect(restarted.knows("s1")).toBe(true);
    expect(restarted.reserve(request).reserved).toBe(false);
  });

  test("an undispatched reservation is released and only a dispatched one becomes unresolved", () => {
    const ledger = createSpendReservationLedger({ policy: policy(1_000), now: () => 1_000 });
    ledger.reserve({ sendId: "never-sent", scopes: { rootId: "r1" }, inputTokens: 40, outputCeilingTokens: 10 });
    expect(ledger.abandon("never-sent")).toBe(true);
    const released = ledger.snapshot("root", "r1");
    expect(released?.reserved).toBe(0);
    expect(released?.unresolved).toBe(0);
    expect(released?.settled).toBe(0);
    // Abandoning is terminal, and the id stays known so it cannot be replayed.
    expect(ledger.markLost("never-sent")).toBe(false);
    expect(ledger.knows("never-sent")).toBe(true);

    ledger.reserve({ sendId: "sent", scopes: { rootId: "r1" }, inputTokens: 40, outputCeilingTokens: 10 });
    expect(ledger.markDispatched("sent")).toBe(true);
    // Bytes left for upstream, so the tokens may already be billed and cannot be handed back.
    expect(ledger.abandon("sent")).toBe(false);
    expect(ledger.markLost("sent")).toBe(true);
    expect(ledger.snapshot("root", "r1")?.unresolved).toBe(50);
  });
});

describe("spend reservation ledger, durability", () => {
  test("under a configured limit a reservation that cannot be persisted is refused", () => {
    const ledger = createSpendReservationLedger({
      journal: unwritableJournal(), policy: policy(1_000), now: () => 1_000,
    });
    const denied = ledger.reserve({
      sendId: "s1", scopes: { rootId: "r1" }, inputTokens: 10, outputCeilingTokens: 10,
    });
    // Admitting here would keep the request but forget it across a restart, which defeats the
    // durable ceiling in exactly the disk-full and permission cases durability exists for.
    expect(denied.reserved).toBe(false);
    if (!denied.reserved) expect(denied.denial.reason).toBe("reserve-not-durable");
    // And it booked nothing: no scope was created and the id was not remembered.
    expect(ledger.snapshot("root", "r1")).toBeUndefined();
    expect(ledger.knows("s1")).toBe(false);
    expect(ledger.persistFailures).toBe(1);
    expect(ledger.degraded).toBe(true);
  });

  test("observe-only mode still admits, and says the reservation is not durable", () => {
    const ledger = createSpendReservationLedger({
      journal: unwritableJournal(), policy: policy(undefined), now: () => 1_000,
    });
    const decision = ledger.reserve({
      sendId: "s1", scopes: { rootId: "r1" }, inputTokens: 10, outputCeilingTokens: 10,
    });
    expect(decision.reserved).toBe(true);
    if (decision.reserved) expect(decision.durable).toBe(false);
    expect(ledger.degraded).toBe(true);
    // An unconfigured install refuses nothing, so the accounting continues in memory.
    expect(ledger.snapshot("root", "r1")?.reserved).toBe(20);
  });
});

describe("spend reservation ledger, journal validation", () => {
  test("every malformed record shape is rejected rather than asserted into the replay", () => {
    // Each of these used to be type-asserted straight into the rebuild: `null` crashed at
    // record.v and the field-less reserve crashed inside applyReserve.
    expect(parseSpendJournalRecord("null")).toBeUndefined();
    expect(parseSpendJournalRecord("[]")).toBeUndefined();
    expect(parseSpendJournalRecord("{not-json")).toBeUndefined();
    expect(parseSpendJournalRecord(JSON.stringify({ v: 1, kind: "reserve" }))).toBeUndefined();
    expect(parseSpendJournalRecord(JSON.stringify({ v: 2, kind: "lost", send: "a", at: 1 }))).toBeUndefined();
    expect(parseSpendJournalRecord(JSON.stringify({ v: 1, kind: "nope", send: "a", at: 1 }))).toBeUndefined();
    expect(parseSpendJournalRecord(JSON.stringify({ v: 1, kind: "lost", send: "a", at: -1 }))).toBeUndefined();
    expect(parseSpendJournalRecord(JSON.stringify({ v: 1, kind: "lost", send: "", at: 1 }))).toBeUndefined();
    expect(parseSpendJournalRecord(JSON.stringify({
      v: 1, kind: "reserve", send: "a", targets: [{ scope: "elsewhere", alias: "b" }], tokens: 1, at: 1,
    }))).toBeUndefined();
    expect(parseSpendJournalRecord(JSON.stringify({
      v: 1, kind: "reserve", send: "a", targets: [{ scope: "root", alias: "b" }], tokens: Number.NaN, at: 1,
    }))).toBeUndefined();
    expect(parseSpendJournalRecord(JSON.stringify({ v: 1, kind: "settle", send: "a", tokens: -5, at: 1 }))).toBeUndefined();
    expect(parseSpendJournalRecord(JSON.stringify({ v: 1, kind: "drop", scope: "root", at: 1 }))).toBeUndefined();
    // The one well-formed shape survives.
    expect(parseSpendJournalRecord(JSON.stringify({
      v: 1, kind: "reserve", send: "a", targets: [{ scope: "root", alias: "b" }], tokens: 5, at: 7,
    }))).toBeDefined();
  });

  test("corruption in the middle of the journal fails accounting closed", () => {
    const journal = memoryJournal();
    const first = createSpendReservationLedger({ journal, policy: policy(1_000), now: () => 1_000 });
    first.reserve({ sendId: "s1", scopes: { rootId: "r1" }, inputTokens: 10, outputCeilingTokens: 10 });
    first.settle("s1", { inputTokens: 10, outputTokens: 10 });
    // Records AFTER this one completed, so dropping it quietly would understate the root and
    // hand back budget. Only a torn tail may be dropped.
    journal.lines.splice(1, 0, "null");

    const second = createSpendReservationLedger({ journal, policy: policy(1_000), now: () => 2_000 });
    expect(second.corruptRecords).toBe(1);
    expect(second.degraded).toBe(true);
    const denied = second.reserve({
      sendId: "s2", scopes: { rootId: "r1" }, inputTokens: 1, outputCeilingTokens: 0,
    });
    expect(denied.reserved).toBe(false);
    if (!denied.reserved) expect(denied.denial.reason).toBe("journal-corrupt");

    // Observe-only accounting is not refused by it: there is no ceiling to enforce wrongly.
    const observing = createSpendReservationLedger({ journal, policy: policy(undefined), now: () => 2_000 });
    expect(observing.reserve({
      sendId: "s3", scopes: { rootId: "r1" }, inputTokens: 1, outputCeilingTokens: 0,
    }).reserved).toBe(true);
  });
});

describe("spend reservation ledger, bounded retention", () => {
  const bounded = (overrides: Partial<SpendReservationPolicy> = {}): SpendReservationPolicy => ({
    root: {}, identity: {}, pool: {},
    retentionMs: 1_000,
    maxTrackedScopes: 2,
    maxTrackedSends: 2,
    compactAfterRecords: 6,
    ...overrides,
  });

  test("cleanup runs without a caller, and the journal does not resurrect what it removed", () => {
    const journal = memoryJournal();
    let clock = 0;
    const ledger = createSpendReservationLedger({ journal, policy: bounded(), now: () => clock });
    // Twelve unique root ids and twelve unique send ids, which is the shape that grew both
    // Maps and the journal without bound when nothing called prune().
    for (let i = 0; i < 12; i += 1) {
      clock = i * 10_000;
      expect(ledger.reserve({
        sendId: `s${i}`, scopes: { rootId: `r${i}` }, inputTokens: 1, outputCeilingTokens: 0,
      }).reserved).toBe(true);
      expect(ledger.settle(`s${i}`, { inputTokens: 1, outputTokens: 0 })).toBe(true);
    }
    expect(ledger.snapshot("root", "r0")).toBeUndefined();
    expect(ledger.knows("s0")).toBe(false);
    expect(ledger.snapshot("root", "r11")?.settled).toBe(1);

    // The tombstones and the checkpoint are what make that durable: a restart rebuilds the
    // bounded state rather than every id the process ever saw.
    const restarted = createSpendReservationLedger({ journal, policy: bounded(), now: () => clock });
    expect(restarted.snapshot("root", "r0")).toBeUndefined();
    expect(restarted.knows("s0")).toBe(false);
    expect(restarted.snapshot("root", "r11")?.settled).toBe(1);
    expect(restarted.corruptRecords).toBe(0);
    // And the file itself stayed small instead of carrying two records per unique id.
    expect(journal.lines.length).toBeLessThan(12);
  });

  test("a full tracking table refuses admission rather than forgetting an exhausted scope", () => {
    let clock = 1_000;
    const ledger = createSpendReservationLedger({
      policy: bounded({ root: { maxTokens: 100 }, maxTrackedSends: 64 }),
      now: () => clock,
    });
    for (const root of ["a", "b"]) {
      expect(ledger.reserve({
        sendId: `s-${root}`, scopes: { rootId: root }, inputTokens: 100, outputCeilingTokens: 0,
      }).reserved).toBe(true);
      expect(ledger.settle(`s-${root}`, { inputTokens: 100, outputTokens: 0 })).toBe(true);
    }
    clock = 9_000;
    // Both tracked scopes are spent, so there is no safe eviction candidate. Making room by
    // dropping one would hand it a fresh allowance under the same id.
    const denied = ledger.reserve({
      sendId: "s-c", scopes: { rootId: "c" }, inputTokens: 1, outputCeilingTokens: 0,
    });
    expect(denied.reserved).toBe(false);
    if (!denied.reserved) expect(denied.denial.reason).toBe("tracking-capacity-exhausted");
    expect(ledger.exhausted("root", "a")).toBe(true);
    expect(ledger.exhausted("root", "b")).toBe(true);
    expect(ledger.snapshot("root", "c")).toBeUndefined();
  });
});

describe("spend reservation ledger, privacy", () => {
  test("the journal stores salted aliases, never a root header, credential or pool id", () => {
    const journal = memoryJournal();
    const scopes = { rootId: "thread_0123456789", identityId: "cred-jun@example.com", poolId: "pool-prod" };
    const ledger = createSpendReservationLedger({
      journal, policy: policy(1_000), now: () => 1_000, salt: "install-one",
    });
    ledger.reserve({ sendId: "send-abc", scopes, inputTokens: 10, outputCeilingTokens: 0 });
    ledger.markDispatched("send-abc");
    ledger.settle("send-abc", { inputTokens: 10, outputTokens: 0 });

    const written = journal.lines.join("\n");
    for (const raw of ["send-abc", "thread_0123456789", "cred-jun@example.com", "pool-prod"]) {
      expect(written).not.toContain(raw);
    }

    // The alias is stable for one install, so a restart still finds the same spend...
    const restarted = createSpendReservationLedger({
      journal, policy: policy(1_000), now: () => 2_000, salt: "install-one",
    });
    expect(restarted.snapshot("root", "thread_0123456789")?.settled).toBe(10);
    expect(restarted.snapshot("identity", "cred-jun@example.com")?.settled).toBe(10);
    // ...and unrecoverable with anything but that install's salt.
    const stranger = createSpendReservationLedger({
      journal, policy: policy(1_000), now: () => 2_000, salt: "install-two",
    });
    expect(stranger.snapshot("root", "thread_0123456789")).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import {
  CursorCredentialRouter,
  CursorPoolKernel,
  NoAvailableCursorCredentialError,
  createCursorPoolCapability,
  CURSOR_POOL_COOLDOWN_MS,
  CURSOR_POOL_TTL_MS,
} from "../../../src/providers/cursor-pool";

describe("CursorCredentialRouter", () => {
  test("weighted round-robin distributes picks proportionally", () => {
    const router = new CursorCredentialRouter([
      { id: "a", weight: 3 },
      { id: "b", weight: 1 },
    ]);
    const picks: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 40; i++) {
      const cred = router.pick();
      picks[cred.id] = (picks[cred.id] ?? 0) + 1;
    }
    // 3:1 ratio should be roughly 30:10
    expect(picks.a).toBeGreaterThan(picks.b * 2);
  });

  test("disable + cooldown excludes the credential", () => {
    const router = new CursorCredentialRouter([{ id: "a", weight: 1 }]);
    router.disable("a");
    expect(() => router.pick()).toThrow(NoAvailableCursorCredentialError);
  });

  test("failover picks a different credential when one is disabled", () => {
    const router = new CursorCredentialRouter([
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
    ]);
    router.disable("a");
    const cred = router.pick();
    expect(cred.id).toBe("b");
  });
});
describe("CursorPoolKernel", () => {
  const accounts = [
    { id: "account-a", access: "access-a", expires: Number.MAX_SAFE_INTEGER },
    { id: "account-b", access: "access-b", expires: Number.MAX_SAFE_INTEGER },
  ];
  function setup(now = 1_000, resolver?: (id: string) => string | undefined) {
    let clock = now;
    let listed = [...accounts];
    const capability = createCursorPoolCapability();
    const kernel = new CursorPoolKernel(capability, () => clock, {
      listAccounts: () => listed,
      resolveAccessToken: resolver,
    });
    return {
      kernel,
      capability,
      advance: (ms: number) => {
        clock += ms;
      },
      setAccounts: (next: typeof accounts) => {
        listed = [...next];
      },
    };
  }
  test("requires capability, trusted owner, and two usable accounts", () => {
    const { kernel, capability, setAccounts } = setup();
    expect(kernel.pick("owner", "thread", Symbol("wrong"))).toBeNull();
    expect(kernel.pick("", "thread", capability)).toBeNull();
    setAccounts([accounts[0]!]);
    expect(kernel.pick("owner", "thread", capability)).toBeNull();
    setAccounts(accounts);
    const snapshot = kernel.activate("owner", "thread", capability);
    expect(snapshot).not.toBeNull();
    const serialized = JSON.stringify(snapshot);
    for (const secret of ["account-a", "account-b", "access-a", "access-b"])
      expect(serialized).not.toContain(secret);
  });
  test("same thread text is isolated by owner and absent scope fails closed", () => {
    const { kernel, capability } = setup();
    const a = kernel.pick("owner-a", "same", capability)!;
    const b = kernel.pick("owner-b", "same", capability)!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(kernel.note429(a.accountRef, "owner-a", "same", capability)).toBe(true);
    expect(kernel.pick("owner-b", "same", capability)?.accountRef).toBe(b.accountRef);
    expect(kernel.pick("", "same", capability)).toBeNull();
  });
  test("refs are random opaque values and token is never exposed by snapshot", () => {
    const a = setup().kernel.pick("o", "t", setup().capability);
    const first = setup();
    const picked = first.kernel.pick("o", "t", first.capability)!;
    expect(picked.accountRef).toMatch(/^cp_[0-9a-f]{32}$/);
    expect(picked.accountRef).not.toContain("account-a");
    expect(JSON.stringify(picked)).not.toContain("account-a");
    expect(a).toBeNull();
  });
  test("uses authoritative resolver and never falls back to refresh token", () => {
    const { kernel, capability } = setup(1_000, (id) =>
      id === "account-a" ? "resolved-a" : "resolved-b",
    );
    expect(kernel.pick("o", "t", capability)?.token).toBe("resolved-a");
    const expired = new CursorPoolKernel(capability, () => 3_000, {
      listAccounts: () =>
        accounts.map((a) => ({ ...a, access: undefined, refresh: "refresh" })),
    });
    expect(expired.pick("o", "t", capability)).toBeNull();
  });
  test("sticky generation and exactly-once monotonic cooldown", () => {
    const s = setup();
    const first = s.kernel.pick("o", "t", s.capability)!;
    const second = s.kernel.pick("o", "t", s.capability)!;
    expect(second.accountRef).toBe(first.accountRef);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(s.kernel.note429(first.accountRef, "o", "t", s.capability)).toBe(
      true,
    );
    expect(s.kernel.note429(first.accountRef, "o", "t", s.capability)).toBe(
      false,
    );
    expect(s.kernel.note429(first.accountRef, "other", "t", s.capability)).toBe(
      false,
    );
    s.advance(CURSOR_POOL_COOLDOWN_MS + 1);
    expect(s.kernel.note429(first.accountRef, "o", "t", s.capability)).toBe(
      true,
    );
  });
  test("rollback is owner-scoped CAS; TTL, removal and clear leave no state", () => {
    const s = setup();
    const a = s.kernel.pick("a", "t", s.capability)!;
    const b = s.kernel.pick("b", "t", s.capability)!;
    const snap = s.kernel.activate("a", "t", s.capability)!;
    s.kernel.pick("b", "other-thread", s.capability);
    expect(s.kernel.rollback(snap, s.capability)).toBe(true);
    expect(s.kernel.pick("b", "t", s.capability)?.accountRef).toBe(
      b.accountRef,
    );
    expect(s.kernel.rollback(snap, s.capability)).toBe(false);
    const generationBeforeRemove = s.kernel.currentGeneration;
    s.kernel.remove(b.accountRef, s.capability);
    expect(s.kernel.currentGeneration).toBeGreaterThan(generationBeforeRemove);
    expect(s.kernel.rollback(snap, s.capability)).toBe(false);
    const reminted = s.kernel.pick("b", "t", s.capability);
    expect(reminted).not.toBeNull();
    expect(reminted?.accountRef).not.toBe(b.accountRef);
    s.advance(CURSOR_POOL_TTL_MS + 1);
    const beforeClear = s.kernel.pick("a", "t2", s.capability)!;
    const clearSnapshot = s.kernel.activate("a", "t2", s.capability)!;
    s.kernel.clear(s.capability);
    // Old pre-clear snapshot is rejected by rollback
    expect(s.kernel.rollback(clearSnapshot, s.capability)).toBe(false);
    // Recreated key mints a new ref and acquires a strictly later monotonic generation
    const afterClear = s.kernel.pick("a", "t2", s.capability)!;
    expect(afterClear.accountRef).not.toBe(beforeClear.accountRef);
    expect(afterClear.generation).toBeGreaterThan(clearSnapshot.generation);
    // And rollback with the old snapshot still fails against the recreated key
    expect(s.kernel.rollback(clearSnapshot, s.capability)).toBe(false);
  });

  test("TTL sweep for one owner preserves another owner's live affinity", () => {
    const s = setup();
    const ownerA = s.kernel.pick("owner-a", "thread", s.capability)!;
    s.advance(CURSOR_POOL_TTL_MS - 1);
    const ownerB = s.kernel.pick("owner-b", "thread", s.capability)!;
    s.advance(2);
    expect(s.kernel.pick("owner-b", "thread", s.capability)?.accountRef).toBe(
      ownerB.accountRef,
    );
    expect(ownerA).not.toBeNull();
  });

  test("retains opaque refs for temporarily unusable accounts across activate", () => {
    const s = setup();
    const pick1 = s.kernel.pick("owner-a", "thread", s.capability)!;
    const originalRef = pick1.accountRef;

    s.setAccounts([
      { id: "account-a", access: "access-a", expires: 500, needsReauth: true },
      { id: "account-b", access: "access-b", expires: Number.MAX_SAFE_INTEGER },
      { id: "account-c", access: "access-c", expires: Number.MAX_SAFE_INTEGER },
    ]);
    const snap = s.kernel.activate("owner-b", "thread", s.capability);
    expect(snap).not.toBeNull();

    s.setAccounts(accounts);
    const pickRestored = s.kernel.pick("owner-a", "thread", s.capability)!;
    expect(pickRestored.accountRef).toBe(originalRef);
  });

  test("rejects NaN expiry in usable and unexpired checks", () => {
    const s = setup();
    s.setAccounts([
      { id: "account-a", access: "access-a", expires: NaN },
      { id: "account-b", access: "access-b", expires: Number.MAX_SAFE_INTEGER },
    ]);
    expect(s.kernel.pick("owner", "thread", s.capability)).toBeNull();
  });

  test("sweep prunes versions when owner/thread has no live states", () => {
    const s = setup();
    s.kernel.pick("owner-ephemeral", "thread", s.capability);
    s.advance(CURSOR_POOL_TTL_MS + 1);
    s.kernel.pick("owner-other", "thread", s.capability);
    const staleSnap = {
      generation: 1,
      owner: "owner-ephemeral",
      thread: "thread",
      refs: [],
      previous: [],
    };
    expect(s.kernel.rollback(staleSnap, s.capability)).toBe(false);
  });

  test("activate and pick perform exactly one listAccounts store read and resolve pass per call", () => {
    let listAccountsCalls = 0;
    let resolveCalls = 0;
    const capability = createCursorPoolCapability();
    const kernel = new CursorPoolKernel(capability, () => 1_000, {
      listAccounts: () => {
        listAccountsCalls++;
        return accounts;
      },
      resolveAccessToken: (id) => {
        resolveCalls++;
        return id === "account-a" ? "access-a" : "access-b";
      },
    });

    const picked = kernel.pick("owner", "thread", capability);
    expect(picked).not.toBeNull();
    // Exactly 1 listAccounts call and 1 resolve pass per account (2 accounts)
    expect(listAccountsCalls).toBe(1);
    expect(resolveCalls).toBe(2);

    const activated = kernel.activate("owner", "thread-2", capability);
    expect(activated).not.toBeNull();
    expect(listAccountsCalls).toBe(2);
    expect(resolveCalls).toBe(4);
  });
});

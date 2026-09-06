import { describe, expect, test } from "bun:test";
import { CursorCredentialRouter, CursorPoolKernel, NoAvailableCursorCredentialError, createCursorPoolCapability, CURSOR_POOL_COOLDOWN_MS, CURSOR_POOL_TTL_MS } from "../../../src/providers/cursor-pool";

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
    { id: "account-a", access: "access-a", expires: 2_000 },
    { id: "account-b", access: "access-b", expires: 2_000 },
  ];
  function setup(now = 1_000, resolver?: (id: string) => string | undefined) {
    let clock = now;
    const capability = createCursorPoolCapability();
    const kernel = new CursorPoolKernel(capability, () => clock, { listAccounts: () => accounts, resolveAccessToken: resolver });
    return { kernel, capability, advance: (ms: number) => { clock += ms; } };
  }
  test("requires capability, trusted owner, and two usable accounts", () => {
    const { kernel, capability } = setup();
    expect(kernel.pick("owner", "thread", Symbol("wrong"))).toBeNull();
    expect(kernel.pick("", "thread", capability)).toBeNull();
    expect(kernel.pick("owner", "thread", capability)?.token).toBe("access-a");
  });
  test("same thread text is isolated by owner and absent scope fails closed", () => {
    const { kernel, capability } = setup();
    expect(kernel.pick("owner-a", "same", capability)?.accountRef).not.toBe(kernel.pick("owner-b", "same", capability)?.accountRef);
    expect(kernel.pick("", "same", capability)).toBeNull();
  });
  test("refs are random opaque values and token is never exposed by snapshot", () => {
    const a = setup().kernel.pick("o", "t", setup().capability);
    const first = setup(); const picked = first.kernel.pick("o", "t", first.capability)!;
    expect(picked.accountRef).toMatch(/^cp_[0-9a-f]{32}$/); expect(picked.accountRef).not.toContain("account-a");
    expect(JSON.stringify(picked)).not.toContain("account-a");
    expect(a).toBeNull();
  });
  test("uses authoritative resolver and never falls back to refresh token", () => {
    const { kernel, capability } = setup(1_000, id => id === "account-a" ? "resolved-a" : "resolved-b");
    expect(kernel.pick("o", "t", capability)?.token).toBe("resolved-a");
    const expired = new CursorPoolKernel(capability, () => 3_000, { listAccounts: () => accounts.map(a => ({ ...a, access: undefined, refresh: "refresh" })) });
    expect(expired.pick("o", "t", capability)).toBeNull();
  });
  test("sticky generation and exactly-once monotonic cooldown", () => {
    const s = setup(); const first = s.kernel.pick("o", "t", s.capability)!; const second = s.kernel.pick("o", "t", s.capability)!;
    expect(second.accountRef).toBe(first.accountRef); expect(second.generation).toBeGreaterThan(first.generation);
    expect(s.kernel.note429(first.accountRef, "o", "t", s.capability)).toBe(true);
    expect(s.kernel.note429(first.accountRef, "o", "t", s.capability)).toBe(false);
    expect(s.kernel.note429(first.accountRef, "other", "t", s.capability)).toBe(false);
    expect(CURSOR_POOL_COOLDOWN_MS).toBeGreaterThan(0);
  });
  test("rollback is owner-scoped CAS; TTL, removal and clear leave no state", () => {
    const s = setup(); const a = s.kernel.pick("a", "t", s.capability)!; const b = s.kernel.pick("b", "t", s.capability)!;
    const snap = s.kernel.activate("a", "t", s.capability)!;
    expect(s.kernel.rollback(snap, s.capability)).toBe(true);
    expect(s.kernel.pick("b", "t", s.capability)?.accountRef).toBe(b.accountRef);
    expect(s.kernel.rollback(snap, s.capability)).toBe(false);
    s.kernel.remove(b.accountRef, s.capability); expect(s.kernel.pick("b", "t", s.capability)?.accountRef).not.toBe(b.accountRef);
    expect(CURSOR_POOL_TTL_MS).toBeGreaterThan(0); s.advance(CURSOR_POOL_TTL_MS + 1); s.kernel.pick("a", "t2", s.capability); s.kernel.clear(s.capability); expect(s.kernel.pick("a", "t", s.capability)).toBeNull();
    expect(a.accountRef).not.toBe(b.accountRef);
  });
});

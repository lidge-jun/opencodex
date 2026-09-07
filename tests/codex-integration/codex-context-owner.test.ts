import { beforeEach, describe, expect, test } from "bun:test";
import type { CodexAuthContext } from "../../src/codex/auth-context";
import { clearContextSessionOwnersForTests, contextSessionOwnerMatches,
  getContextSessionOwner, recordContextSessionOwner } from "../../src/codex/context-owner";

const destination = "https://chatgpt.com/backend-api/codex";
const start = 1_000_000;
const root = (id = "root") => new Headers({ "session-id": id, "thread-id": id });
const outbound = (account: string | null = "physical-a", token = "accepted-a") => new Headers({
  authorization: `Bearer ${token}`, ...(account === null ? {} : { "chatgpt-account-id": account }),
});
const stored = (id = "slot-a", account = "physical-a"): CodexAuthContext => ({
  kind: "pool", accountId: id, chatgptAccountId: account,
  accessToken: "accepted-a", generation: 1, writerGeneration: 0, fixedAccount: true,
});
const caller: CodexAuthContext = { kind: "main", accountId: null };
beforeEach(clearContextSessionOwnersForTests);

describe("context session ownership", () => {
  test("an explicit stored account owns the session independently of routing state", () => {
    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
    const owner = getContextSessionOwner("root", destination, start)!;
    expect(owner).toMatchObject({ kind: "stored", accountId: "slot-a", ambiguous: false });
    expect(contextSessionOwnerMatches(owner, outbound())).toBe(true);
    expect(contextSessionOwnerMatches(owner, outbound("physical-b"))).toBe(false);
    expect(JSON.stringify(owner)).not.toContain("physical-a");
    expect(JSON.stringify(owner)).not.toContain("accepted-a");
  });

  test("stored ownership survives token and generation refresh within the same physical account", () => {
    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
    const refreshed = { ...stored(), generation: 2, accessToken: "refreshed" } as CodexAuthContext;
    recordContextSessionOwner(root(), destination, refreshed, outbound("physical-a", "refreshed"), false, start + 1);
    const owner = getContextSessionOwner("root", destination, start + 2)!;
    expect(owner.ambiguous).toBe(false);
    expect(contextSessionOwnerMatches(owner, outbound("physical-a", "refreshed"))).toBe(true);
  });

  test("stored identity must match the accepted outbound account", () => {
    recordContextSessionOwner(root(), destination, stored(), outbound("physical-b"), false, start);
    expect(getContextSessionOwner("root", destination, start)).toBeUndefined();
    recordContextSessionOwner(root(), destination, stored(), outbound(null), false, start);
    expect(getContextSessionOwner("root", destination, start)).toBeUndefined();
  });

  test("caller-owned credentials remain fenced from proxy or other bearer credentials", () => {
    recordContextSessionOwner(root(), destination, caller, outbound(), false, start);
    const owner = getContextSessionOwner("root", destination, start)!;
    expect(owner.kind).toBe("caller");
    expect(contextSessionOwnerMatches(owner, outbound())).toBe(true);
    expect(contextSessionOwnerMatches(owner, outbound("physical-a", "proxy-secret"))).toBe(false);
    expect(contextSessionOwnerMatches(owner, outbound("physical-b"))).toBe(false);
  });

  test("only an accepted same-account model turn authorizes a rotated caller token", () => {
    recordContextSessionOwner(root(), destination, caller, outbound(), false, start);
    const refreshed = outbound("physical-a", "refreshed");
    expect(contextSessionOwnerMatches(getContextSessionOwner("root", destination, start)!, refreshed)).toBe(false);
    recordContextSessionOwner(root(), destination, caller, refreshed, false, start + 1);
    const owner = getContextSessionOwner("root", destination, start + 1)!;
    expect(owner.ambiguous).toBe(false);
    expect(contextSessionOwnerMatches(owner, refreshed)).toBe(true);
    expect(contextSessionOwnerMatches(owner, outbound())).toBe(false);
  });

  test("caller without physical identity allows only the exact credential", () => {
    recordContextSessionOwner(root(), destination, caller, outbound(null), false, start);
    let owner = getContextSessionOwner("root", destination, start)!;
    expect(contextSessionOwnerMatches(owner, outbound(null))).toBe(true);
    recordContextSessionOwner(root(), destination, caller, outbound(null, "rotated"), false, start + 1);
    owner = getContextSessionOwner("root", destination, start + 1)!;
    expect(owner.ambiguous).toBe(true);
    expect(contextSessionOwnerMatches(owner, outbound(null, "rotated"))).toBe(false);
  });

  test("substituted Direct main is stored ownership, not caller ownership", () => {
    recordContextSessionOwner(root(), destination, caller, outbound(), true, start);
    expect(getContextSessionOwner("root", destination, start)).toMatchObject({ kind: "stored", accountId: "__main__" });
  });

  test("root and child model turns share the root body session lookup", () => {
    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
    recordContextSessionOwner(new Headers({ "x-codex-parent-thread-id": "root", "session-id": "child" }),
      destination, stored(), outbound(), false, start + 1);
    expect(getContextSessionOwner("root", destination, start + 1)?.ambiguous).toBe(false);
    expect(getContextSessionOwner("child", destination, start + 1)).toBeUndefined();
  });

  test.each(["physical", "kind", "destination"])("conflicting %s remains ambiguous after later writes", conflict => {
    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
    recordContextSessionOwner(root(), conflict === "destination" ? "https://other.test/codex" : destination,
      conflict === "kind" ? caller : stored("slot-b", conflict === "physical" ? "physical-b" : "physical-a"),
      outbound(conflict === "physical" ? "physical-b" : "physical-a"), false, start + 1);
    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start + 2);
    const owner = getContextSessionOwner("root", destination, start + 2)!;
    expect(owner.ambiguous).toBe(true);
    expect(contextSessionOwnerMatches(owner, outbound())).toBe(false);
    expect(getContextSessionOwner("root", "https://other.test/codex", start + 2)).toBeUndefined();
  });

  test("destination mismatch cannot bootstrap a new owner", () => {
    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
    expect(getContextSessionOwner("root", "https://other.test/codex", start)).toBeUndefined();
    expect(getContextSessionOwner("root", destination + "/", start)).toBeDefined();
  });

  test("a fresh lookup detects conflict after an earlier snapshot was read", () => {
    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
    const oldOwner = getContextSessionOwner("root", destination, start)!;
    recordContextSessionOwner(root(), destination, stored("slot-b", "physical-b"), outbound("physical-b"), false, start + 1);
    const currentOwner = getContextSessionOwner("root", destination, start + 1)!;
    expect(oldOwner.ambiguous).toBe(false);
    expect(currentOwner.ambiguous).toBe(true);
    expect(contextSessionOwnerMatches(currentOwner, outbound())).toBe(false);
  });

  test("expiry and restart lose ownership instead of guessing an active account", () => {
    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
    expect(getContextSessionOwner("root", destination, start + 24 * 60 * 60_000)).toBeUndefined();
    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
    clearContextSessionOwnersForTests();
    expect(getContextSessionOwner("root", destination, start)).toBeUndefined();
  });

  test("LRU capacity evicts the untouched entry, preserving a recently looked-up owner", () => {
    for (let i = 0; i < 2048; i++) recordContextSessionOwner(root(`root-${i}`), destination, stored(), outbound(), false, start);
    expect(getContextSessionOwner("root-0", destination, start + 1)).toBeDefined();
    recordContextSessionOwner(root("overflow"), destination, stored(), outbound(), false, start + 2);
    expect(getContextSessionOwner("root-0", destination, start + 2)).toBeDefined();
    expect(getContextSessionOwner("root-1", destination, start + 2)).toBeUndefined();
  });

  test("byte capacity also bounds long account slots", () => {
    for (let i = 0; i < 1600; i++) recordContextSessionOwner(root(`root-${i}`), destination,
      stored("a".repeat(512)), outbound(), false, start);
    expect(getContextSessionOwner("root-0", destination, start)).toBeUndefined();
    expect(getContextSessionOwner("root-1599", destination, start)).toBeDefined();
  });

  test("invalid and oversized identifiers never create ownership", () => {
    for (const id of ["", "bad root", "a".repeat(513)]) {
      recordContextSessionOwner(root(id), destination, stored(), outbound(), false, start);
      expect(getContextSessionOwner(id, destination, start)).toBeUndefined();
    }
    recordContextSessionOwner(new Headers({ "x-codex-parent-thread-id": "bad root", "session-id": "root" }),
      destination, stored(), outbound(), false, start);
    expect(getContextSessionOwner("root", destination, start)).toBeUndefined();
    recordContextSessionOwner(root(), "https://x.test/" + "a".repeat(4096), stored(), outbound(), false, start);
    expect(getContextSessionOwner("root", destination, start)).toBeUndefined();
  });
});

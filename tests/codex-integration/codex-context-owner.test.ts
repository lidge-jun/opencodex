import { beforeEach, describe, expect, test } from "bun:test";
import type { CodexAuthContext } from "../../src/codex/auth-context";
import { clearContextSessionOwnersForTests, contextSessionOwnerMatches,
  getContextSessionOwner, recordContextSessionOwner } from "../../src/codex/context-owner";

const destination = "https://chatgpt.com/backend-api/codex";
const principal = "principal-a";
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

let issuedTokens = 0;
const userToken = (user: string | undefined, second?: string) => {
  const auth: Record<string, string> = {};
  if (user !== undefined) auth.chatgpt_user_id = user;
  if (second !== undefined) auth.user_id = second;
  // iat varies per call so two tokens for the same person are genuinely different credentials,
  // which is what a refresh looks like and what the fingerprint rules are about.
  const payload = Buffer.from(JSON.stringify({
    iat: ++issuedTokens, "https://api.openai.com/auth": auth,
  }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
};

describe("context session ownership", () => {
  test("another admission principal can neither read nor poison the first principal's session", () => {
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(), false, start);
    expect(getContextSessionOwner("principal-b", "root", destination, start)).toBeUndefined();
    recordContextSessionOwner("principal-b", root(), destination, stored("slot-b", "physical-b"),
      outbound("physical-b", "accepted-b"), false, start);
    const first = getContextSessionOwner(principal, "root", destination, start)!;
    expect(first).toMatchObject({ accountId: "slot-a", ambiguous: false });
    expect(getContextSessionOwner("principal-b", "root", destination, start))
      .toMatchObject({ accountId: "slot-b", ambiguous: false });
  });

  test("a second user inside the same workspace does not inherit the session", () => {
    const first = outbound("physical-a", userToken("user-a"));
    const second = outbound("physical-a", userToken("user-b"));
    recordContextSessionOwner(principal, root(), destination, stored(), first, false, start);
    const owner = getContextSessionOwner(principal, "root", destination, start)!;
    expect(contextSessionOwnerMatches(owner, first)).toBe(true);
    expect(contextSessionOwnerMatches(owner, second)).toBe(false);
    recordContextSessionOwner(principal, root(), destination, stored(), second, false, start + 1);
    expect(getContextSessionOwner(principal, "root", destination, start + 1)?.ambiguous).toBe(true);
  });

  test("a proven user survives a token refresh; without one only the exact credential continues", () => {
    const issued = outbound("physical-a", userToken("user-a"));
    recordContextSessionOwner(principal, root(), destination, stored(), issued, false, start);
    const owner = getContextSessionOwner(principal, "root", destination, start)!;
    expect(contextSessionOwnerMatches(owner, outbound("physical-a", userToken("user-a")))).toBe(true);

    recordContextSessionOwner(principal, root("bare"), destination, stored(), outbound(), false, start);
    const bare = getContextSessionOwner(principal, "bare", destination, start)!;
    expect(contextSessionOwnerMatches(bare, outbound())).toBe(true);
    expect(contextSessionOwnerMatches(bare, outbound("physical-a", "rotated"))).toBe(false);
    // A credential that only now starts proving a user is a different fact, not a continuation.
    expect(contextSessionOwnerMatches(bare, outbound("physical-a", userToken("user-a")))).toBe(false);
  });

  test("conflicting user claims are never recorded and poison an existing entry", () => {
    recordContextSessionOwner(principal, root(), destination, stored(),
      outbound("physical-a", userToken("user-a", "user-b")), false, start);
    expect(getContextSessionOwner(principal, "root", destination, start)).toBeUndefined();

    recordContextSessionOwner(principal, root("seeded"), destination, stored(),
      outbound("physical-a", userToken("user-a")), false, start);
    recordContextSessionOwner(principal, root("seeded"), destination, stored(),
      outbound("physical-a", userToken("user-a", "user-b")), false, start + 1);
    expect(getContextSessionOwner(principal, "seeded", destination, start + 1)?.ambiguous).toBe(true);
  });

  test("an unauthenticated admission owns nothing", () => {
    recordContextSessionOwner(undefined, root(), destination, stored(), outbound(), false, start);
    expect(getContextSessionOwner(undefined, "root", destination, start)).toBeUndefined();
    expect(getContextSessionOwner(principal, "root", destination, start)).toBeUndefined();
  });

  test("an explicit stored account owns the session independently of routing state", () => {
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(), false, start);
    const owner = getContextSessionOwner(principal, "root", destination, start)!;
    expect(owner).toMatchObject({ kind: "stored", accountId: "slot-a", ambiguous: false });
    expect(contextSessionOwnerMatches(owner, outbound())).toBe(true);
    expect(contextSessionOwnerMatches(owner, outbound("physical-b"))).toBe(false);
    expect(JSON.stringify(owner)).not.toContain("physical-a");
    expect(JSON.stringify(owner)).not.toContain("accepted-a");
  });

  test("stored ownership survives token and generation refresh for the same proven user", () => {
    const issued = outbound("physical-a", userToken("user-a"));
    const renewed = outbound("physical-a", userToken("user-a"));
    expect(renewed.get("authorization")).not.toBe(issued.get("authorization"));
    recordContextSessionOwner(principal, root(), destination, stored(), issued, false, start);
    const refreshed = { ...stored(), generation: 2, accessToken: "refreshed" } as CodexAuthContext;
    recordContextSessionOwner(principal, root(), destination, refreshed, renewed, false, start + 1);
    const owner = getContextSessionOwner(principal, "root", destination, start + 2)!;
    expect(owner.ambiguous).toBe(false);
    // A stored credential is minted by the proxy for the account it selected, so either token
    // of the same proven person is accepted; a different person in that workspace is not.
    expect(contextSessionOwnerMatches(owner, renewed)).toBe(true);
    expect(contextSessionOwnerMatches(owner, issued)).toBe(true);
    expect(contextSessionOwnerMatches(owner, outbound("physical-a", userToken("user-b")))).toBe(false);
  });

  test("a userless credential cannot rebind an entry by sharing its workspace", () => {
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(), false, start);
    recordContextSessionOwner(principal, root(), destination, stored(),
      outbound("physical-a", "another-userless-token"), false, start + 1);
    expect(getContextSessionOwner(principal, "root", destination, start + 1)?.ambiguous).toBe(true);
  });

  test("stored identity must match the accepted outbound account", () => {
    recordContextSessionOwner(principal, root(), destination, stored(), outbound("physical-b"), false, start);
    expect(getContextSessionOwner(principal, "root", destination, start)).toBeUndefined();
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(null), false, start);
    expect(getContextSessionOwner(principal, "root", destination, start)).toBeUndefined();
  });

  test("caller-owned credentials remain fenced from proxy or other bearer credentials", () => {
    recordContextSessionOwner(principal, root(), destination, caller, outbound(), false, start);
    const owner = getContextSessionOwner(principal, "root", destination, start)!;
    expect(owner.kind).toBe("caller");
    expect(contextSessionOwnerMatches(owner, outbound())).toBe(true);
    expect(contextSessionOwnerMatches(owner, outbound("physical-a", "proxy-secret"))).toBe(false);
    expect(contextSessionOwnerMatches(owner, outbound("physical-b"))).toBe(false);
  });

  test("only an accepted same-account model turn authorizes a rotated caller token", () => {
    const issued = outbound("physical-a", userToken("user-a"));
    recordContextSessionOwner(principal, root(), destination, caller, issued, false, start);
    const refreshed = outbound("physical-a", userToken("user-a"));
    expect(refreshed.get("authorization")).not.toBe(issued.get("authorization"));
    // Same person, but this bearer has never been accepted upstream for this session.
    expect(contextSessionOwnerMatches(getContextSessionOwner(principal, "root", destination, start)!, refreshed)).toBe(false);
    recordContextSessionOwner(principal, root(), destination, caller, refreshed, false, start + 1);
    const owner = getContextSessionOwner(principal, "root", destination, start + 1)!;
    expect(owner.ambiguous).toBe(false);
    expect(contextSessionOwnerMatches(owner, refreshed)).toBe(true);
    // A caller bearer is not ours to reissue, so the superseded one stops being the credential.
    expect(contextSessionOwnerMatches(owner, issued)).toBe(false);
    expect(contextSessionOwnerMatches(owner, outbound())).toBe(false);
  });

  test("caller without physical identity allows only the exact credential", () => {
    recordContextSessionOwner(principal, root(), destination, caller, outbound(null), false, start);
    let owner = getContextSessionOwner(principal, "root", destination, start)!;
    expect(contextSessionOwnerMatches(owner, outbound(null))).toBe(true);
    recordContextSessionOwner(principal, root(), destination, caller, outbound(null, "rotated"), false, start + 1);
    owner = getContextSessionOwner(principal, "root", destination, start + 1)!;
    expect(owner.ambiguous).toBe(true);
    expect(contextSessionOwnerMatches(owner, outbound(null, "rotated"))).toBe(false);
  });

  test("substituted Direct main is stored ownership, not caller ownership", () => {
    recordContextSessionOwner(principal, root(), destination, caller, outbound(), true, start);
    expect(getContextSessionOwner(principal, "root", destination, start)).toMatchObject({ kind: "stored", accountId: "__main__" });
  });

  test("root and child model turns share the root body session lookup", () => {
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(), false, start);
    recordContextSessionOwner(principal, new Headers({ "x-codex-parent-thread-id": "root", "session-id": "child" }),
      destination, stored(), outbound(), false, start + 1);
    expect(getContextSessionOwner(principal, "root", destination, start + 1)?.ambiguous).toBe(false);
    expect(getContextSessionOwner(principal, "child", destination, start + 1)).toBeUndefined();
  });

  test.each(["physical", "kind", "destination"])("conflicting %s remains ambiguous after later writes", conflict => {
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(), false, start);
    recordContextSessionOwner(principal, root(), conflict === "destination" ? "https://other.test/codex" : destination,
      conflict === "kind" ? caller : stored("slot-b", conflict === "physical" ? "physical-b" : "physical-a"),
      outbound(conflict === "physical" ? "physical-b" : "physical-a"), false, start + 1);
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(), false, start + 2);
    const owner = getContextSessionOwner(principal, "root", destination, start + 2)!;
    expect(owner.ambiguous).toBe(true);
    expect(contextSessionOwnerMatches(owner, outbound())).toBe(false);
    expect(getContextSessionOwner(principal, "root", "https://other.test/codex", start + 2)).toBeUndefined();
  });

  test("destination mismatch cannot bootstrap a new owner", () => {
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(), false, start);
    expect(getContextSessionOwner(principal, "root", "https://other.test/codex", start)).toBeUndefined();
    expect(getContextSessionOwner(principal, "root", destination + "/", start)).toBeDefined();
  });

  test("a fresh lookup detects conflict after an earlier snapshot was read", () => {
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(), false, start);
    const oldOwner = getContextSessionOwner(principal, "root", destination, start)!;
    recordContextSessionOwner(principal, root(), destination, stored("slot-b", "physical-b"), outbound("physical-b"), false, start + 1);
    const currentOwner = getContextSessionOwner(principal, "root", destination, start + 1)!;
    expect(oldOwner.ambiguous).toBe(false);
    expect(currentOwner.ambiguous).toBe(true);
    expect(contextSessionOwnerMatches(currentOwner, outbound())).toBe(false);
  });

  test("expiry and restart lose ownership instead of guessing an active account", () => {
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(), false, start);
    expect(getContextSessionOwner(principal, "root", destination, start + 24 * 60 * 60_000)).toBeUndefined();
    recordContextSessionOwner(principal, root(), destination, stored(), outbound(), false, start);
    clearContextSessionOwnersForTests();
    expect(getContextSessionOwner(principal, "root", destination, start)).toBeUndefined();
  });

  test("LRU capacity evicts the untouched entry, preserving a recently looked-up owner", () => {
    for (let i = 0; i < 2048; i++) recordContextSessionOwner(principal, root(`root-${i}`), destination, stored(), outbound(), false, start);
    expect(getContextSessionOwner(principal, "root-0", destination, start + 1)).toBeDefined();
    recordContextSessionOwner(principal, root("overflow"), destination, stored(), outbound(), false, start + 2);
    expect(getContextSessionOwner(principal, "root-0", destination, start + 2)).toBeDefined();
    expect(getContextSessionOwner(principal, "root-1", destination, start + 2)).toBeUndefined();
  });

  test("byte capacity also bounds long account slots", () => {
    for (let i = 0; i < 1600; i++) recordContextSessionOwner(principal, root(`root-${i}`), destination,
      stored("a".repeat(512)), outbound(), false, start);
    expect(getContextSessionOwner(principal, "root-0", destination, start)).toBeUndefined();
    expect(getContextSessionOwner(principal, "root-1599", destination, start)).toBeDefined();
  });

  test("invalid and oversized identifiers never create ownership", () => {
    for (const id of ["", "bad root", "a".repeat(513)]) {
      recordContextSessionOwner(principal, root(id), destination, stored(), outbound(), false, start);
      expect(getContextSessionOwner(principal, id, destination, start)).toBeUndefined();
    }
    recordContextSessionOwner(principal, new Headers({ "x-codex-parent-thread-id": "bad root", "session-id": "root" }),
      destination, stored(), outbound(), false, start);
    expect(getContextSessionOwner(principal, "root", destination, start)).toBeUndefined();
    recordContextSessionOwner(principal, root(), "https://x.test/" + "a".repeat(4096), stored(), outbound(), false, start);
    expect(getContextSessionOwner(principal, "root", destination, start)).toBeUndefined();
  });
});

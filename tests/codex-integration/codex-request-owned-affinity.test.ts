import { describe, expect, test } from "bun:test";
import { bindThreadAffinity, clearThreadAccountMap } from "../../src/codex/routing/thread-affinity";
import { requestSpendRecord } from "../../src/server/request-log";

describe("request-owned affinity", () => {
  test("namespaces bindings by exact bearer and conversation", async () => {
    const { requestOwnedAffinityKey, isRequestOwnedAffinityKey } = await import("../../src/codex/request-owned-affinity");
    const a = new Headers({ authorization: "Bearer alpha", "session-id": "session", "thread-id": "thread" });
    const b = new Headers({ authorization: "Bearer beta", "session-id": "session", "thread-id": "thread" });
    const key = requestOwnedAffinityKey(a)!;
    expect(isRequestOwnedAffinityKey(key)).toBe(true);
    expect(key).toBe(requestOwnedAffinityKey(a));
    expect(key).not.toBe(requestOwnedAffinityKey(b));
    expect(key).not.toContain("alpha");
    expect(key).not.toContain("session");
  });
  test("selection labels claim a bind only when the chosen account is bound", async () => {
    const { honestAffinityDecision } = await import("../../src/codex/request-owned-affinity");
    clearThreadAccountMap();
    const decision = { move: "new_bind", reason: "healthy" } as const;
    expect(honestAffinityDecision(decision, undefined, "account", undefined, undefined, true)).toEqual({ move: "unbound", reason: "request_owned" });
    expect(honestAffinityDecision(decision, undefined, "account", undefined, undefined, false)).toEqual({ move: "unbound", reason: "no_conversation" });
    expect(honestAffinityDecision(decision, "key", "account")).toEqual({ move: "unbound", reason: "healthy" });
    bindThreadAffinity("key", "__main__", Date.now());
    expect(honestAffinityDecision(decision, "key", "__main__")).toEqual(decision);
    clearThreadAccountMap();
  });
  test("unbound reasons do not become spend move reasons", () => {
    expect(requestSpendRecord({ affinity: "unbound", affinityReason: "healthy" }, [])).toBeUndefined();
    expect(requestSpendRecord({ affinity: "unbound", affinityReason: "request_owned" }, [])).toBeUndefined();
    expect(requestSpendRecord({ affinity: "unbound", affinityReason: "request_owned", affinityMoveReasons: ["quota_refusal"] }, [])?.moveReasons).toEqual(["quota_refusal"]);
  });
});

test("opt-in main selection binds and reuses a caller-scoped key", async () => {
  const { resolveCodexAuthContext, codexRequestAffinityKey, codexPoolAffinityKey } = await import("../../src/codex/auth-context");
  const { getThreadAffinity, clearThreadAccountMap } = await import("../../src/codex/routing/thread-affinity");
  const { conversationStateBindingFromAuth } = await import("../../src/server/responses/account-change-state");
  const { isRequestOwnedAffinityKey } = await import("../../src/codex/request-owned-affinity");
  const config = { providers: {}, codexAccounts: [], accountPoolStrategy: "round-robin", codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
  const headers = new Headers({ authorization: "Bearer alpha", "session-id": "s", "thread-id": "t" });
  const options = { requestScopedMainCredential: true, primeCodexPoolQuotas: async () => {} };
  clearThreadAccountMap();
  const first = await resolveCodexAuthContext(headers, config, "pool", options);
  const second = await resolveCodexAuthContext(headers, config, "pool", options);
  expect(first.affinityDecision).toEqual({ move: "new_bind", reason: "healthy" });
  expect(second.affinityDecision).toEqual({ move: "reused", reason: "healthy" });
  expect(first.affinityKey).toBe(codexRequestAffinityKey(headers, config, config, options));
  expect(isRequestOwnedAffinityKey(first.affinityKey!)).toBe(true);
  expect(first.affinityKey).not.toBe(codexPoolAffinityKey(headers));
  expect(getThreadAffinity(codexPoolAffinityKey(headers)!)).toBeUndefined();
  expect(conversationStateBindingFromAuth(first)).toEqual({ accountId: "__main__", bindingKey: first.affinityKey });
  clearThreadAccountMap();
});

test("preview derivation excludes fixed selectors and preserves parent fallback", async () => {
  const { codexRequestAffinityKey, codexPoolAffinityKey } = await import("../../src/codex/auth-context");
  const config = { providers: {}, codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
  const headers = new Headers({ authorization: "Bearer alpha", "session-id": "s", "thread-id": "t" });
  const owned = { requestScopedMainCredential: true };
  expect(codexRequestAffinityKey(headers, config, config, { ...owned, accountId: "__main__" })).toBeUndefined();
  expect(codexRequestAffinityKey(headers, config, config, { ...owned, accountId: "pool" })).toBeUndefined();
  const reserveConfig = { ...config, codexDesktopAuthless: true };
  expect(codexRequestAffinityKey(headers, reserveConfig, reserveConfig, { ...owned, modelId: "gpt-reserve", admission: { source: "loopback" } })).toBeUndefined();
  expect(codexRequestAffinityKey(headers, config, config, {})).toBe(codexPoolAffinityKey(headers));
  expect(codexRequestAffinityKey(new Headers({ authorization: "Bearer alpha" }), config, config, owned)).toBeUndefined();
  const long = "x".repeat(513);
  expect(codexRequestAffinityKey(new Headers({ authorization: "Bearer alpha", "session-id": long, "thread-id": "t" }), config, config, owned)).toBeUndefined();
  expect(codexRequestAffinityKey(new Headers({ authorization: "Bearer alpha", "session-id": long, "x-codex-parent-thread-id": "parent" }), config, config, owned)).toBeDefined();
});

test("bound callers remain isolated and never record lineage", async () => {
  const { resolveCodexAuthContext, codexPoolAffinityKey } = await import("../../src/codex/auth-context");
  const { codexLineageScopeKey, codexThreadLineageLookup, clearCodexThreadLineageForTests } = await import("../../src/codex/lineage");
  const { getThreadAffinity } = await import("../../src/codex/routing/thread-affinity");
  const config = { providers: {}, codexAccounts: [], accountPoolStrategy: "round-robin", codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
  const a = new Headers({ authorization: "Bearer one", "session-id": "s", "thread-id": "t" });
  const b = new Headers({ authorization: "Bearer two", "session-id": "s", "thread-id": "t" });
  const options = { requestScopedMainCredential: true };
  clearThreadAccountMap(); clearCodexThreadLineageForTests();
  const first = await resolveCodexAuthContext(a, config, "pool", options);
  const second = await resolveCodexAuthContext(a, config, "pool", options);
  expect(first.affinityDecision?.move).toBe("new_bind");
  expect(second.affinityDecision?.move).toBe("reused");
  const other = await resolveCodexAuthContext(b, config, "pool", options);
  expect(other.affinityDecision?.move).toBe("new_bind");
  expect(other.affinityKey).not.toBe(first.affinityKey);
  expect((await resolveCodexAuthContext(a, config, "pool", options)).affinityDecision?.move).toBe("reused");
  expect(getThreadAffinity(codexPoolAffinityKey(a)!)).toBeUndefined();
  expect(codexThreadLineageLookup(codexPoolAffinityKey(a)!, codexLineageScopeKey(a))).toBeUndefined();
  clearThreadAccountMap(); clearCodexThreadLineageForTests();
});

test("schema validates the default-off flag", async () => {
  const { codexPoolSchema } = await import("../../src/config/schema/leaf-validators");
  expect(codexPoolSchema.safeParse({ requestOwnedAffinity: true }).success).toBe(true);
  expect(codexPoolSchema.safeParse({ requestOwnedAffinity: "true" }).success).toBe(false);
});

test("usage log round trips the new affinity values", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeTreeWithRetry } = await import("../helpers/remove-tree");
  const { addRequestLog, clearRequestLogsForTests } = await import("../../src/server/request-log");
  const { readUsageEntries, resetUsageReadCacheForTests } = await import("../../src/usage/log");
  const previous = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-affinity-"));
  process.env.OPENCODEX_HOME = home;
  clearRequestLogsForTests(); resetUsageReadCacheForTests();
  try {
    for (const reason of ["request_owned", "no_conversation"] as const) addRequestLog({
      requestId: reason, timestamp: Date.now(), provider: "openai", model: "test", status: 200,
      durationMs: 1, affinity: "unbound", affinityReason: reason,
    });
    expect(readUsageEntries().map(row => [row.affinity, row.affinityReason])).toEqual([
      ["unbound", "request_owned"], ["unbound", "no_conversation"],
    ]);
  } finally {
    clearRequestLogsForTests(); resetUsageReadCacheForTests();
    if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
});

test("stored selection without a key labels the missing binding honestly", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeTreeWithRetry } = await import("../helpers/remove-tree");
  const { saveCodexAccountCredential } = await import("../../src/codex/account-store");
  const { resolveCodexAuthContext } = await import("../../src/codex/auth-context");
  const home = mkdtempSync(join(tmpdir(), "ocx-owned-selection-"));
  const oldHome = process.env.OPENCODEX_HOME;
  const oldCodex = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  try {
    saveCodexAccountCredential("a", { accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3600000, chatgptAccountId: "test-account" });
    const config = { providers: {}, codexAccounts: [{ id: "a", email: "a@example.test", isMain: false }], activeCodexAccountId: "a", pausedCodexAccountIds: ["__main__"] } as import("../../src/types").OcxConfig;
    const options = { primeCodexPoolQuotas: async () => {} };
    clearThreadAccountMap();
    const noConversation = await resolveCodexAuthContext(new Headers(), config, "pool", options);
    expect(noConversation.affinityDecision).toEqual({ move: "unbound", reason: "no_conversation" });
    const caller = new Headers({ authorization: "Bearer test", "session-id": "s", "thread-id": "t" });
    const off = await resolveCodexAuthContext(caller, config, "pool", { ...options, requestScopedMainCredential: true });
    expect(off.affinityDecision).toEqual({ move: "unbound", reason: "request_owned" });
    expect(off.affinityKey).toBeUndefined();
    const { codexPoolAffinityKey } = await import("../../src/codex/auth-context");
    const { rememberServingConversationStateIssuer, conversationStateBindingFromAuth } = await import("../../src/server/responses/account-change-state");
    const { peekConversationStateIssuer } = await import("../../src/codex/routing/thread-affinity");
    expect(off.conversationStateKey).toStartWith("request-owned:v1:");
    expect(off.conversationStateKey).not.toBe(codexPoolAffinityKey(caller));
    rememberServingConversationStateIssuer(off, codexPoolAffinityKey(caller));
    expect(peekConversationStateIssuer(off.conversationStateKey!)).toBe("a");
    expect(peekConversationStateIssuer(codexPoolAffinityKey(caller)!)).toBeUndefined();
    const stored = { kind: "pool", accountId: "other", generation: 0, writerGeneration: 0, accessToken: "test", chatgptAccountId: "test" } as const;
    rememberServingConversationStateIssuer(stored, codexPoolAffinityKey(caller));
    expect(conversationStateBindingFromAuth(stored, codexPoolAffinityKey(caller))?.bindingKey).toBe(codexPoolAffinityKey(caller));
    expect(peekConversationStateIssuer(off.conversationStateKey!)).toBe("a");
    config.codexPool = { requestOwnedAffinity: true };
    const bound = await resolveCodexAuthContext(caller, config, "pool", { ...options, requestScopedMainCredential: true });
    const reused = await resolveCodexAuthContext(caller, config, "pool", { ...options, requestScopedMainCredential: true });
    expect(bound.affinityDecision?.move).toBe("new_bind");
    expect(reused.affinityDecision?.move).toBe("reused");
    const fixedPool = await resolveCodexAuthContext(caller, config, "pool", { ...options, requestScopedMainCredential: true, accountId: "a" });
    const fixedMain = await resolveCodexAuthContext(caller, config, "pool", { ...options, requestScopedMainCredential: true, accountId: "__main__" });
    expect(fixedPool.affinityKey).toBeUndefined();
    expect(fixedPool.conversationStateKey).toBeUndefined();
    expect(conversationStateBindingFromAuth(fixedPool, codexPoolAffinityKey(caller))?.bindingKey).toBe(codexPoolAffinityKey(caller));
    expect(fixedMain.affinityKey).toBeUndefined();
    expect(fixedMain.conversationStateKey).toBeUndefined();
    const { bindModelDetourAffinity, getThreadAffinity, getModelDetourAffinity } = await import("../../src/codex/routing/thread-affinity");
    const { honestAffinityDecision } = await import("../../src/codex/request-owned-affinity");
    bindModelDetourAffinity(bound.affinityKey!, "__main__", Date.now(), "detour-model");
    expect(getThreadAffinity(bound.affinityKey!)?.accountId).toBe("a");
    expect(getModelDetourAffinity(bound.affinityKey!, "detour-model")?.accountId).toBe("__main__");
    expect(honestAffinityDecision({ move: "new_bind", reason: "model_lane" }, bound.affinityKey, "__main__", undefined, "detour-model")).toEqual({ move: "new_bind", reason: "model_lane" });
    config.pausedCodexAccountIds = ["a"];
    const moved = await resolveCodexAuthContext(caller, config, "pool", { ...options, requestScopedMainCredential: true });
    expect(moved.kind).toBe("main");
    expect(moved.affinityDecision?.move).toBe("rebound");
  } finally {
    clearThreadAccountMap();
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    removeTreeWithRetry(home);
  }
});

test("keyed main issuer participates in account-change scrub and file refusal", async () => {
  const { resolveCodexAuthContext } = await import("../../src/codex/auth-context");
  const { conversationStateBindingFromAuth, rememberServingConversationStateIssuer, applyAccountChangeConversationStateScrub, accountChangeFileReferenceRefusal } = await import("../../src/server/responses/account-change-state");
  const config = { providers: {}, codexAccounts: [], codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
  const headers = new Headers({ authorization: "Bearer issuer", "session-id": "s", "thread-id": "t" });
  const options = { requestScopedMainCredential: true };
  clearThreadAccountMap();
  const first = await resolveCodexAuthContext(headers, config, "pool", options);
  const second = await resolveCodexAuthContext(headers, config, "pool", options);
  expect(first.affinityDecision?.move).toBe("new_bind");
  expect(second.affinityDecision?.move).toBe("reused");
  rememberServingConversationStateIssuer(second);
  const binding = conversationStateBindingFromAuth(second)!;
  const body = { previous_response_id: "opaque" };
  expect(applyAccountChangeConversationStateScrub({ body, bindingKey: binding.bindingKey, servingAccountId: "other" })).toBe(true);
  expect(body).not.toHaveProperty("previous_response_id");
  expect(accountChangeFileReferenceRefusal({ body: { input: [{ file_id: "opaque" }] }, bindingKey: binding.bindingKey, servingAccountId: "other" })?.status).toBe(400);
  clearThreadAccountMap();
});

test("a namespaced binding remains independent across quota scopes", async () => {
  const { resolveCodexAuthContext } = await import("../../src/codex/auth-context");
  const { getThreadAffinity } = await import("../../src/codex/routing/thread-affinity");
  const config = { providers: {}, codexAccounts: [], codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
  const headers = new Headers({ authorization: "Bearer scopes", "session-id": "s", "thread-id": "t" });
  const options = { requestScopedMainCredential: true };
  clearThreadAccountMap();
  const first = await resolveCodexAuthContext(headers, config, "pool", options);
  const second = await resolveCodexAuthContext(headers, config, "pool", options);
  expect(first.affinityDecision?.move).toBe("new_bind");
  expect(second.affinityDecision?.move).toBe("reused");
  const shared = await resolveCodexAuthContext(headers, config, "pool", { ...options, modelId: "test-model" });
  expect(shared.affinityDecision?.move).toBe("new_bind");
  expect(getThreadAffinity(first.affinityKey!)?.accountId).toBe("__main__");
  expect(getThreadAffinity(first.affinityKey!, "shared")?.accountId).toBe("__main__");
  clearThreadAccountMap();
});

test("substituted admission and injected main credentials use the ordinary key", async () => {
  const { codexRouteCredentialOwnership } = await import("../../src/server/responses/core-auth");
  const { resolveCodexAuthContext, codexRequestAffinityKey, codexPoolAffinityKey } = await import("../../src/codex/auth-context");
  const { fakeChatGptJwt } = await import("../helpers/agent-task-recovery");
  const provider = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } as import("../../src/types").OcxProviderConfig;
  const route = { provider, codexAccountMode: "pool" as const };
  const config = { providers: {}, codexAccounts: [], codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
  const headers = new Headers({ authorization: `Bearer ${fakeChatGptJwt("test-account")}`, "session-id": "s", "thread-id": "t" });
  clearThreadAccountMap();
  const first = await resolveCodexAuthContext(headers, config, "pool", { requestScopedMainCredential: true });
  const second = await resolveCodexAuthContext(headers, config, "pool", { requestScopedMainCredential: true });
  expect(first.affinityDecision?.move).toBe("new_bind");
  expect(second.affinityDecision?.move).toBe("reused");
  const admission = { admission: { source: "bearer" } } as Parameters<typeof codexRouteCredentialOwnership>[3];
  const injected = { stripClaudeMainAuthForNoncanonicalForward: true, trustedClaudeMainAuth: { authorization: headers.get("authorization")! } } as Parameters<typeof codexRouteCredentialOwnership>[3];
  for (const options of [admission, injected]) {
    const ownership = codexRouteCredentialOwnership(headers, config, route, options);
    expect(ownership.requestScopedMainCredential).toBe(false);
    expect(codexRequestAffinityKey(headers, config, config, ownership)).toBe(codexPoolAffinityKey(headers));
  }
  clearThreadAccountMap();
});

test("reusing a main binding never reads physical main auth", async () => {
  const fs = await import("node:fs");
  const { spyOn } = await import("bun:test");
  const { resolveCodexAuthContext } = await import("../../src/codex/auth-context");
  const config = { providers: {}, codexAccounts: [], codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
  const headers = new Headers({ authorization: "Bearer fenced", "session-id": "s", "thread-id": "t" });
  const options = { requestScopedMainCredential: true };
  clearThreadAccountMap();
  const first = await resolveCodexAuthContext(headers, config, "pool", options);
  const second = await resolveCodexAuthContext(headers, config, "pool", options);
  expect(first.affinityDecision?.move).toBe("new_bind");
  expect(second.affinityDecision?.move).toBe("reused");
  const original = fs.readFileSync as (...args: unknown[]) => unknown;
  let mainReads = 0;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].endsWith("auth.json")) mainReads++;
    return original(...args);
  }) as typeof fs.readFileSync);
  try {
    expect((await resolveCodexAuthContext(headers, config, "pool", options)).affinityDecision?.move).toBe("reused");
    expect(mainReads).toBe(0);
  } finally { spy.mockRestore(); clearThreadAccountMap(); }
});


test("compact fixed-account Pool contexts never fall back to the raw key", async () => {
  const { compactAlternateAffinityKey } = await import("../../src/server/responses/account-change-state");
  const pool = { kind: "pool", accountId: "a", fixedAccount: true, writerGeneration: 0, generation: 0, accessToken: "test", chatgptAccountId: "test" } as const;
  let reads = 0;
  const rawKey = () => { reads++; return "raw-key"; };
  expect(compactAlternateAffinityKey(pool, rawKey)).toBeUndefined();
  expect(compactAlternateAffinityKey({ kind: "main", accountId: null, affinityKey: "owned-key" }, rawKey)).toBe("owned-key");
  expect(reads).toBe(0);
  expect(compactAlternateAffinityKey({ kind: "main", accountId: null }, rawKey)).toBe("raw-key");
  expect(reads).toBe(1);
});

test("six request-owned round-robin turns rotate when off and bind when on", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeTreeWithRetry } = await import("../helpers/remove-tree");
  const { saveCodexAccountCredential } = await import("../../src/codex/account-store");
  const { resolveCodexAuthContext } = await import("../../src/codex/auth-context");
  const { clearPoolRotationState } = await import("../../src/codex/pool-rotation");
  const { clearCodexUpstreamHealth } = await import("../../src/codex/routing");
  const home = mkdtempSync(join(tmpdir(), "ocx-owned-rotation-"));
  const oldHome = process.env.OPENCODEX_HOME, oldCodex = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  try {
    for (const id of ["a", "b"]) saveCodexAccountCredential(id, { accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 3600000, chatgptAccountId: `test-${id}` });
    const config = { providers: {}, codexAccounts: ["a", "b"].map(id => ({ id, email: `${id}@example.test`, isMain: false })), accountPoolStrategy: "round-robin", accountPoolStickyLimit: 1, autoSwitchThreshold: 0 } as import("../../src/types").OcxConfig;
    const headers = new Headers({ authorization: "Bearer rotation", "session-id": "s", "thread-id": "t" });
    const options = { requestScopedMainCredential: true, primeCodexPoolQuotas: async () => {} };
    clearThreadAccountMap(); clearPoolRotationState(); clearCodexUpstreamHealth();
    const off = [];
    for (let i = 0; i < 6; i++) off.push(await resolveCodexAuthContext(headers, config, "pool", options));
    expect(new Set(off.map(ctx => ctx.kind === "main" ? "__main__" : ctx.accountId)).size).toBe(3);
    for (const ctx of off.filter(ctx => ctx.kind === "pool")) expect(ctx.affinityDecision).toEqual({ move: "unbound", reason: "request_owned" });
    clearThreadAccountMap(); clearPoolRotationState();
    config.codexPool = { requestOwnedAffinity: true };
    const on = [];
    for (let i = 0; i < 6; i++) on.push(await resolveCodexAuthContext(headers, config, "pool", options));
    expect(new Set(on.map(ctx => ctx.kind === "main" ? "__main__" : ctx.accountId)).size).toBe(1);
    expect(on.map(ctx => ctx.affinityDecision?.move)).toEqual(["new_bind", "reused", "reused", "reused", "reused", "reused"]);
    // Model the first preview and a recovery reroute that changes credential ownership.
    const { codexRequestAffinityKey } = await import("../../src/codex/auth-context");
    const { previewCodexAccountForRequest } = await import("../../src/codex/routing");
    const firstKey = codexRequestAffinityKey(headers, config, config, { requestScopedMainCredential: true })!;
    const recoveryKey = codexRequestAffinityKey(headers, config, config, { requestScopedMainCredential: false })!;
    expect(firstKey).not.toBe(recoveryKey);
    const firstAccount = on[0]!.kind === "main" ? "__main__" : on[0]!.accountId!;
    const otherAccount = firstAccount === "a" ? "b" : "a";
    bindThreadAffinity(recoveryKey, otherAccount, Date.now());
    expect(previewCodexAccountForRequest(firstKey, config, Date.now(), undefined, { requestOwnedMainCredential: true, isMainAccountTokenLive: () => true })).toBe(firstAccount);
    expect(previewCodexAccountForRequest(recoveryKey, config, Date.now(), undefined, { isMainAccountTokenLive: () => false })).toBe(otherAccount);
    const { resolveCodexAccountForThreadDetailed, codexQuotaScopeForModel } = await import("../../src/codex/routing");
    const { getThreadAffinity, getModelDetourAffinity } = await import("../../src/codex/routing/thread-affinity");
    const selection = { requestOwnedMainCredential: true, isMainAccountTokenLive: () => true };
    const shared = resolveCodexAccountForThreadDetailed(firstKey, config, Date.now(), "shared", selection);
    expect(shared.status).toBe("selected");
    expect(shared.affinity?.move).toBe("new_bind");
    const scope = codexQuotaScopeForModel("gpt-reserve")!;
    expect(scope).toBe("reserve");
    const reserve = resolveCodexAccountForThreadDetailed(firstKey, config, Date.now(), scope, selection);
    expect(reserve.status).toBe("selected");
    expect(reserve.affinity?.move).toBe("new_bind");
    expect(getThreadAffinity(firstKey, scope)).toBeDefined();
    const ordinary = getThreadAffinity(firstKey, "shared")!.accountId;
    const alternate = ordinary === "a" ? "b" : "a";
    const detour = resolveCodexAccountForThreadDetailed(firstKey, config, Date.now(), "shared", { ...selection, modelEligibleAccountIds: new Set([alternate]) }, "gpt-daybreak-blue-latest");
    expect(detour).toMatchObject({ status: "selected", accountId: alternate });
    expect(getModelDetourAffinity(firstKey, "gpt-daybreak-blue-latest", "shared")?.accountId).toBe(alternate);
    expect(getThreadAffinity(firstKey, "shared")?.accountId).toBe(ordinary);
  } finally {
    clearThreadAccountMap(); clearPoolRotationState(); clearCodexUpstreamHealth();
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    removeTreeWithRetry(home);
  }
});

test("pinned caller-main keeps the namespaced conversation-state issuer", async () => {
  const { resolveCodexAuthContext } = await import("../../src/codex/auth-context");
  const { conversationStateBindingFromAuth, rememberServingConversationStateIssuer, applyAccountChangeConversationStateScrub, accountChangeFileReferenceRefusal } = await import("../../src/server/responses/account-change-state");
  const cfg = { providers: {}, codexAccounts: [], accountPoolStrategy: "round-robin", codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
  const headers = new Headers({ authorization: "Bearer pinned", "session-id": "s", "thread-id": "t" });
  clearThreadAccountMap();
  const initial = await resolveCodexAuthContext(headers, cfg, "pool", { requestScopedMainCredential: true });
  const repeat = await resolveCodexAuthContext(headers, cfg, "pool", { requestScopedMainCredential: true });
  expect(initial.affinityDecision?.move).toBe("new_bind");
  expect(repeat.affinityDecision?.move).toBe("reused");
  const pool = { kind: "pool", accountId: "pool-x", writerGeneration: 0, generation: 0, accessToken: "test", chatgptAccountId: "test", affinityKey: initial.affinityKey } as const;
  rememberServingConversationStateIssuer(pool);
  cfg.activeCodexAccountId = "__main__"; cfg.activeCodexAccountPinned = "__main__";
  const pinned = await resolveCodexAuthContext(headers, cfg, "pool", { requestScopedMainCredential: true });
  expect(pinned.kind).toBe("main");
  expect(pinned.affinityKey).toBeUndefined();
  expect(pinned.conversationStateKey).toBe(initial.affinityKey);
  const binding = conversationStateBindingFromAuth(pinned)!;
  const body = { previous_response_id: "opaque" };
  expect(applyAccountChangeConversationStateScrub({ body, bindingKey: binding.bindingKey, servingAccountId: binding.accountId })).toBe(true);
  expect(accountChangeFileReferenceRefusal({ body: { input: [{ file_id: "opaque" }] }, bindingKey: binding.bindingKey, servingAccountId: binding.accountId })?.status).toBe(400);
  rememberServingConversationStateIssuer(pinned);
  const reverse = { previous_response_id: "opaque" };
  expect(applyAccountChangeConversationStateScrub({ body: reverse, bindingKey: initial.affinityKey!, servingAccountId: "pool-x" })).toBe(true);
  clearThreadAccountMap();
});

test("caller-main issuer and fallback key use conversation state without routing affinity", async () => {
  const { conversationStateAccountId } = await import("../../src/codex/request-owned-affinity");
  const { conversationStateBindingFromAuth, compactAlternateAffinityKey } = await import("../../src/server/responses/account-change-state");
  const main = { kind: "main", accountId: null, conversationStateKey: "owned-key" } as const;
  expect(conversationStateAccountId(main)).toBe("__main__");
  expect(conversationStateBindingFromAuth(main, "raw")).toEqual({ accountId: "__main__", bindingKey: "owned-key" });
  expect(compactAlternateAffinityKey(main, () => "raw")).toBe("owned-key");
});

test("fallback labels describe the caller-main detour", async () => {
  const { callerOwnedFallbackAffinityDecision } = await import("../../src/codex/request-owned-affinity");
  clearThreadAccountMap();
  bindThreadAffinity("fallback-key", "__main__", Date.now());
  expect(callerOwnedFallbackAffinityDecision({ move: "reused", reason: "healthy" }, "fallback-key", undefined, undefined, false, "cooldown")).toEqual({ move: "reused", reason: "healthy" });
  expect(callerOwnedFallbackAffinityDecision({ move: "reused", reason: "healthy" }, undefined, undefined, undefined, true, "cooldown")).toEqual({ move: "unbound", reason: "request_owned" });
  clearThreadAccountMap();
});

test("cooldown arriving after pool selection labels caller-main as a detour", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeTreeWithRetry } = await import("../helpers/remove-tree");
  const { saveCodexAccountCredential } = await import("../../src/codex/account-store");
  const { resolveCodexAuthContext } = await import("../../src/codex/auth-context");
  const { recordCodexUpstreamOutcome, clearCodexUpstreamHealth } = await import("../../src/codex/routing");
  const { noteCodexSelectionAffinity } = await import("../../src/server/request-log");
  const home = mkdtempSync(join(tmpdir(), "ocx-owned-cooldown-"));
  const oldHome = process.env.OPENCODEX_HOME, oldCodex = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  try {
    saveCodexAccountCredential("a", { accessToken: "access-a", refreshToken: "refresh-a", expiresAt: Date.now() + 3600000, chatgptAccountId: "account-a" });
    const config = { providers: {}, codexAccounts: [{ id: "a", label: "a" }], activeCodexAccountId: "a", pausedCodexAccountIds: ["__main__"], autoSwitchThreshold: 0, codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
    const headers = new Headers({ authorization: "Bearer distinct-caller", "chatgpt-account-id": "distinct-account", "session-id": "s", "thread-id": "t" });
    const options = { requestScopedMainCredential: true, primeCodexPoolQuotas: async () => {} };
    clearThreadAccountMap(); clearCodexUpstreamHealth();
    const first = await resolveCodexAuthContext(headers, config, "pool", options);
    const second = await resolveCodexAuthContext(headers, config, "pool", options);
    expect(first.affinityDecision?.move).toBe("new_bind"); expect(second.affinityDecision?.move).toBe("reused");
    const raced = await resolveCodexAuthContext(headers, config, "pool", { ...options, beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => true, release: () => {
      recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "600", fixedAccount: true });
    } }) });
    expect(raced.kind).toBe("main");
    expect(raced.affinityDecision).toEqual({ move: "detour", reason: "cooldown" });
    const log = { provider: "openai", model: "test" };
    noteCodexSelectionAffinity(log, raced);
    expect(log).toMatchObject({ affinity: "detour", affinityReason: "cooldown" });
  } finally {
    clearThreadAccountMap(); clearCodexUpstreamHealth();
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    removeTreeWithRetry(home);
  }
});

test("manual selection clears affinity but retains carried-state issuers until a full reset", async () => {
  const { resolveCodexAuthContext } = await import("../../src/codex/auth-context");
  const { rememberConversationStateIssuer, peekConversationStateIssuer, getThreadAffinity } = await import("../../src/codex/routing/thread-affinity");
  const { resetCodexRoutingForManualSelection, resetCodexRoutingForClearedSelection } = await import("../../src/codex/routing/active-account");
  const config = { providers: {}, codexAccounts: [], codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
  const headers = new Headers({ authorization: "Bearer pin-reset", "session-id": "s", "thread-id": "t" });
  clearThreadAccountMap();
  try {
    const first = await resolveCodexAuthContext(headers, config, "pool", { requestScopedMainCredential: true });
    const reused = await resolveCodexAuthContext(headers, config, "pool", { requestScopedMainCredential: true });
    expect(first.affinityDecision?.move).toBe("new_bind"); expect(reused.affinityDecision?.move).toBe("reused");
    const key = first.conversationStateKey!;
    rememberConversationStateIssuer(key, "pool-a");
    rememberConversationStateIssuer("raw-key", "pool-b");
    expect(getThreadAffinity(key)).toBeDefined();
    resetCodexRoutingForManualSelection("__main__");
    expect(getThreadAffinity(key)).toBeUndefined();
    expect(peekConversationStateIssuer(key)).toBe("pool-a");
    expect(peekConversationStateIssuer("raw-key")).toBe("pool-b");
    clearThreadAccountMap();
    expect(peekConversationStateIssuer(key)).toBeUndefined();
    expect(peekConversationStateIssuer("raw-key")).toBeUndefined();
  } finally { clearThreadAccountMap(); resetCodexRoutingForClearedSelection(); }
});

test.each([[401, "unusable"], [403, "unusable"], [402, "quota_refusal"], [429, "quota_refusal"], [503, "transient"]] as const)(
  "caller-owned main refusal %s releases namespaced bindings with %s", async (status, reason) => {
    const { requestOwnedAffinityKey, releaseRequestOwnedMainOnOutcome, captureRequestOwnedAffinityBindings } = await import("../../src/codex/request-owned-affinity");
    const { bindModelDetourAffinity, getModelDetourAffinity, getThreadAffinity, peekPendingReleaseReason, affinityAfterRelease, rememberConversationStateIssuer, peekConversationStateIssuer } = await import("../../src/codex/routing/thread-affinity");
    const key = requestOwnedAffinityKey(new Headers({ authorization: "Bearer outcome-test", "session-id": "s", "thread-id": "t" }))!;
    clearThreadAccountMap();
    bindThreadAffinity(key, "__main__", Date.now(), "shared");
    bindModelDetourAffinity(key, "__main__", Date.now(), "gpt-5.5", "shared");
    rememberConversationStateIssuer(key, "__main__");
    releaseRequestOwnedMainOnOutcome({ kind: "main", accountId: null, affinityKey: key, affinityBindingSnapshot: captureRequestOwnedAffinityBindings(key, "shared", "gpt-5.5") }, status, "gpt-5.5");
    expect(getThreadAffinity(key, "shared")).toBeUndefined();
    expect(getModelDetourAffinity(key, "gpt-5.5", "shared")).toBeUndefined();
    expect(peekPendingReleaseReason(key)).toBe(reason);
    expect(peekConversationStateIssuer(key)).toBe("__main__");
    affinityAfterRelease(key, reason);
    clearThreadAccountMap();
  },
);

test.each([200, 302, 400, 499])("non-refusal %s retains the caller-owned main binding", async status => {
  const { requestOwnedAffinityKey, releaseRequestOwnedMainOnOutcome, captureRequestOwnedAffinityBindings } = await import("../../src/codex/request-owned-affinity");
  const { getThreadAffinity, peekPendingReleaseReason } = await import("../../src/codex/routing/thread-affinity");
  const key = requestOwnedAffinityKey(new Headers({ authorization: "Bearer no-refusal", "session-id": "s", "thread-id": "t" }))!;
  clearThreadAccountMap(); bindThreadAffinity(key, "__main__", Date.now(), "shared");
  releaseRequestOwnedMainOnOutcome({ kind: "main", accountId: null, affinityKey: key, affinityBindingSnapshot: captureRequestOwnedAffinityBindings(key, "shared", "gpt-5.5") }, status, "gpt-5.5");
  expect(getThreadAffinity(key, "shared")?.accountId).toBe("__main__");
  expect(peekPendingReleaseReason(key)).toBeUndefined();
  clearThreadAccountMap();
});

test("a failed caller-main model detour releases its ordinary and detour entries only", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeTreeWithRetry } = await import("../helpers/remove-tree");
  const { saveCodexAccountCredential } = await import("../../src/codex/account-store");
  const { requestOwnedAffinityKey, releaseRequestOwnedMainOnOutcome, captureRequestOwnedAffinityBindings } = await import("../../src/codex/request-owned-affinity");
  const { bindModelDetourAffinity, getModelDetourAffinity, getThreadAffinity, peekPendingReleaseReason, affinityAfterRelease } = await import("../../src/codex/routing/thread-affinity");
  const home = mkdtempSync(join(tmpdir(), "ocx-detour-refusal-")); const previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    saveCodexAccountCredential("a", { accessToken: "access-a", refreshToken: "refresh-a", expiresAt: Date.now() + 3600000, chatgptAccountId: "account-a" });
    const key = requestOwnedAffinityKey(new Headers({ authorization: "Bearer detour", "session-id": "s", "thread-id": "t" }))!;
    clearThreadAccountMap();
    bindThreadAffinity(key, "a", Date.now(), "shared");
    bindModelDetourAffinity(key, "__main__", Date.now(), "gpt-5.5", "shared");
    const context = { kind: "main", accountId: null, affinityKey: key, affinityBindingSnapshot: captureRequestOwnedAffinityBindings(key, "shared", "gpt-5.5") } as const;
    releaseRequestOwnedMainOnOutcome(context, 429, "gpt-5.5");
    expect(getThreadAffinity(key, "shared")).toBeUndefined();
    expect(getModelDetourAffinity(key, "gpt-5.5", "shared")).toBeUndefined();
    expect(peekPendingReleaseReason(key)).toBe("quota_refusal");
    affinityAfterRelease(key, "quota_refusal");
    bindThreadAffinity(key, "a", Date.now(), "shared");
    releaseRequestOwnedMainOnOutcome({ ...context, affinityDecision: { move: "reused", reason: "healthy" } }, 429, "gpt-5.5");
    expect(getThreadAffinity(key, "shared")?.accountId).toBe("a");
    expect(peekPendingReleaseReason(key)).toBeUndefined();
    releaseRequestOwnedMainOnOutcome({ ...context, affinityBindingSnapshot: captureRequestOwnedAffinityBindings(key, "shared", "gpt-5.5"), affinityDecision: { move: "detour", reason: "cooldown" } }, 429, "gpt-5.5");
    expect(getThreadAffinity(key, "shared")).toBeUndefined();
    expect(peekPendingReleaseReason(key)).toBe("quota_refusal");
    affinityAfterRelease(key, "quota_refusal");
    const sameTime = Date.now();
    bindThreadAffinity(key, "a", sameTime, "shared");
    bindModelDetourAffinity(key, "__main__", sameTime, "gpt-5.5", "shared");
    const older = { ...context, affinityBindingSnapshot: captureRequestOwnedAffinityBindings(key, "shared", "gpt-5.5") };
    bindThreadAffinity(key, "a", sameTime, "shared");
    bindModelDetourAffinity(key, "__main__", sameTime, "gpt-5.5", "shared");
    releaseRequestOwnedMainOnOutcome(older, 429, "gpt-5.5");
    expect(getThreadAffinity(key, "shared")?.accountId).toBe("a");
    expect(getModelDetourAffinity(key, "gpt-5.5", "shared")?.accountId).toBe("__main__");
    expect(peekPendingReleaseReason(key)).toBeUndefined();
  } finally { clearThreadAccountMap(); if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous; removeTreeWithRetry(home); }
});

test("caller-main outcome cannot release a stored-credential raw binding", async () => {
  const { releaseRequestOwnedMainOnOutcome } = await import("../../src/codex/request-owned-affinity");
  const { getThreadAffinity, peekPendingReleaseReason } = await import("../../src/codex/routing/thread-affinity");
  clearThreadAccountMap();
  bindThreadAffinity("app:stored-binding", "__main__", Date.now(), "shared");
  releaseRequestOwnedMainOnOutcome({ kind: "main", accountId: null, affinityKey: "app:stored-binding" }, 429, "gpt-5.5");
  expect(getThreadAffinity("app:stored-binding", "shared")?.accountId).toBe("__main__");
  expect(peekPendingReleaseReason("app:stored-binding")).toBeUndefined();
  clearThreadAccountMap();
});

test.each(["pool", "main"] as const)("a delayed caller-main failure cannot retire a newer %s binding", async destination => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeTreeWithRetry } = await import("../helpers/remove-tree");
  const { saveCodexAccountCredential } = await import("../../src/codex/account-store");
  const { resolveCodexAuthContext } = await import("../../src/codex/auth-context");
  const { releaseRequestOwnedMainOnOutcome } = await import("../../src/codex/request-owned-affinity");
  const { getThreadAffinity, peekPendingReleaseReason } = await import("../../src/codex/routing/thread-affinity");
  const home = mkdtempSync(join(tmpdir(), "ocx-binding-race-"));
  const oldHome = process.env.OPENCODEX_HOME, oldCodex = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  try {
    saveCodexAccountCredential("a", { accessToken: "access-a", refreshToken: "refresh-a", expiresAt: Date.now() + 3600000, chatgptAccountId: "account-a" });
    const config = { providers: {}, codexAccounts: [{ id: "a", label: "a" }], pausedCodexAccountIds: ["a"], codexPool: { requestOwnedAffinity: true } } as import("../../src/types").OcxConfig;
    const headers = new Headers({ authorization: "Bearer race-test", "session-id": "s", "thread-id": "t" });
    clearThreadAccountMap();
    const options = { requestScopedMainCredential: true, modelId: "gpt-5.5", primeCodexPoolQuotas: async () => {} };
    const first = await resolveCodexAuthContext(headers, config, "pool", options);
    const reused = await resolveCodexAuthContext(headers, config, "pool", options);
    expect(first.kind).toBe("main"); expect(first.affinityDecision?.move).toBe("new_bind"); expect(reused.affinityDecision?.move).toBe("reused");
    const key = first.affinityKey!;
    const sameTime = getThreadAffinity(key, "shared")!.createdAt;
    bindThreadAffinity(key, "a", sameTime, "shared");
    if (destination === "main") bindThreadAffinity(key, "__main__", sameTime, "shared");
    const stale = destination === "pool" ? { ...first, affinityDecision: { move: "detour", reason: "cooldown" } as const } : first;
    releaseRequestOwnedMainOnOutcome(stale, 429, "gpt-5.5");
    expect(getThreadAffinity(key, "shared")?.accountId).toBe(destination === "pool" ? "a" : "__main__");
    expect(peekPendingReleaseReason(key)).toBeUndefined();
  } finally {
    clearThreadAccountMap();
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    removeTreeWithRetry(home);
  }
});

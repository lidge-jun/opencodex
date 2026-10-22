import { anthropicOpaqueFingerprint, captureAnthropicRejectionPayloads, bindAnthropicRejectionResponse, rejectedAnthropicPayloads } from "../../src/adapters/anthropic-rejection-memo";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { AdapterRequest } from "../../src/adapters/base";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import {
  bindReasoningReplayScope,
  clearReasoningReplayCacheForTests,
  commitReasoningReplayServingIdentity,
  durableReplayCredentialIdentity,
  getReasoningReplayOpaqueBlobRejection,
  peekReasoningForCall,
  reasoningReplayCodexCredentialIdentity,
  reasoningReplayCredentialIdentity,
  reasoningReplayDestinationIdentity,
  reasoningReplayKeyCredentialIdentity,
  reasoningReplayOpaqueBlobRejectionMemoized,
  reasoningReplayOAuthCredentialIdentity,
  reasoningReplayServingIdentityChanged,
  reasoningReplayServingIdentityChange,
  rememberReasoningForCall,
  rememberReasoningReplayOpaqueBlobRejection,
} from "../../src/responses/reasoning-replay-cache";
import type { AdapterEvent, OcxReasoningReplayScopeRef } from "../../src/types";

const THREAD = "thread-identity";
const CALL_ID = "call_identity_collision";
const REASONING = "private reasoning";

function scope(
  overrides: Partial<NonNullable<OcxReasoningReplayScopeRef["current"]>> = {},
): OcxReasoningReplayScopeRef {
  return {
    clientThreadId: THREAD,
    current: {
      providerName: "provider-a",
      providerDestinationIdentity: "destination:provider-a",
      providerDestinationDurableIdentity: "destination:durable-provider-a",
      adapterName: "openai-chat",
      modelId: "deepseek-v4-flash",
      credentialIdentity: "key:physical-a",
      credentialDurableIdentity: "credential:durable-slot-a",
      ...overrides,
    },
  };
}

async function drain(events: AsyncIterable<AdapterEvent>, replayScope: OcxReasoningReplayScopeRef): Promise<void> {
  const reader = bridgeToResponsesSSE(
    events,
    "deepseek-v4-flash",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { replayCacheScope: replayScope },
  ).getReader();
  while (!(await reader.read()).done) {
    // Drain the bridge so tool-call cache writes complete.
  }
}

function authenticatedScope(
  overrides: Partial<NonNullable<OcxReasoningReplayScopeRef["current"]>> = {},
): OcxReasoningReplayScopeRef {
  return { ...scope(overrides), clientPrincipalId: "principal-a" };
}

describe("reasoning replay provider and credential identity", () => {
  beforeEach(() => clearReasoningReplayCacheForTests());
  afterEach(() => clearReasoningReplayCacheForTests());

  test("the same tuple replays but provider, destination, wire, model, or credential changes miss", () => {
    const original = authenticatedScope();
    rememberReasoningForCall(CALL_ID, REASONING, original);
    expect(peekReasoningForCall(CALL_ID, authenticatedScope())).toBe(REASONING);

    for (const changed of [
      authenticatedScope({ providerName: "provider-b" }),
      authenticatedScope({ providerDestinationIdentity: "destination:provider-b" }),
      authenticatedScope({ adapterName: "openai-responses" }),
      authenticatedScope({ modelId: "deepseek-v4" }),
      authenticatedScope({ credentialIdentity: "key:physical-b" }),
    ]) {
      expect(peekReasoningForCall(CALL_ID, changed)).toBeUndefined();
    }
  });

  test("binding the same physical identity isolates plaintext by principal and refuses keyless writes", () => {
    const principalA: OcxReasoningReplayScopeRef = { clientThreadId: THREAD, clientPrincipalId: "principal-a" };
    const principalB: OcxReasoningReplayScopeRef = { clientThreadId: THREAD, clientPrincipalId: "principal-b" };
    const keyless: OcxReasoningReplayScopeRef = { clientThreadId: THREAD };
    for (const holder of [principalA, principalB, keyless]) bindReasoningReplayScope(holder, scope().current);
    rememberReasoningForCall(CALL_ID, REASONING, principalA);
    expect(peekReasoningForCall(CALL_ID, principalA)).toBe(REASONING);
    expect(peekReasoningForCall(CALL_ID, principalB)).toBeUndefined();
    expect(peekReasoningForCall(CALL_ID, keyless)).toBeUndefined();
    rememberReasoningForCall(CALL_ID, "keyless overwrite", keyless);
    expect(peekReasoningForCall(CALL_ID, keyless)).toBeUndefined();
    expect(peekReasoningForCall(CALL_ID, principalA)).toBe(REASONING);
    rememberReasoningForCall(CALL_ID, "principal b reasoning", principalB);
    expect(peekReasoningForCall(CALL_ID, principalB)).toBe("principal b reasoning");
    expect(peekReasoningForCall(CALL_ID, principalA)).toBe(REASONING);
  });

  test("keyless physical binding retains serving changes and rejection memos but rejects incomplete identity", () => {
    const holder: OcxReasoningReplayScopeRef = { clientThreadId: THREAD };
    const identity = scope().current;
    bindReasoningReplayScope(holder, identity);
    expect(holder.current).toEqual(identity);
    expect(holder.current).not.toBe(identity);
    commitReasoningReplayServingIdentity(holder);
    rememberReasoningReplayOpaqueBlobRejection(holder);
    expect(reasoningReplayOpaqueBlobRejectionMemoized(holder)).toBe(true);
    bindReasoningReplayScope(holder, scope({ modelId: "changed-model" }).current);
    expect(reasoningReplayServingIdentityChange(holder)).toMatchObject({ modelChanged: true });
    expect(reasoningReplayOpaqueBlobRejectionMemoized(holder)).toBe(false);
    bindReasoningReplayScope(holder, scope({ credentialIdentity: "" }).current);
    expect(holder.current).toBeUndefined();
    const threadless: OcxReasoningReplayScopeRef = {};
    bindReasoningReplayScope(threadless, scope().current);
    expect(threadless.current).toBeUndefined();
  });

  test("serving identity ignores credential generation but reports durable route changes", () => {
    const firstGeneration = scope({
      credentialIdentity: "oauth:slot-a-generation-a",
    });
    expect(reasoningReplayServingIdentityChanged(firstGeneration)).toBe(false);
    commitReasoningReplayServingIdentity(firstGeneration);
    expect(reasoningReplayServingIdentityChanged(scope({
      credentialIdentity: "oauth:slot-a-generation-b",
    }))).toBe(false);

    const changedModel = scope({
      modelId: "deepseek-v4",
      credentialIdentity: "oauth:slot-a-generation-b",
    });
    expect(reasoningReplayServingIdentityChanged(changedModel)).toBe(true);
    expect(reasoningReplayServingIdentityChanged(changedModel)).toBe(true);
    commitReasoningReplayServingIdentity(changedModel);
    expect(reasoningReplayServingIdentityChanged(changedModel)).toBe(false);

    const changedCredential = scope({
      modelId: "deepseek-v4",
      credentialIdentity: "oauth:slot-b-generation-a",
      credentialDurableIdentity: "credential:durable-slot-b",
    });
    expect(reasoningReplayServingIdentityChanged(changedCredential)).toBe(true);
    commitReasoningReplayServingIdentity(changedCredential);
    expect(reasoningReplayServingIdentityChanged(changedCredential)).toBe(false);

    const changedDestination = scope({
      modelId: "deepseek-v4",
      providerDestinationIdentity: "destination:provider-b",
      providerDestinationDurableIdentity: "destination:durable-provider-b",
      credentialIdentity: "oauth:slot-b-generation-a",
      credentialDurableIdentity: "credential:durable-slot-b",
    });
    expect(reasoningReplayServingIdentityChanged(changedDestination)).toBe(true);
    commitReasoningReplayServingIdentity(changedDestination);
    expect(reasoningReplayServingIdentityChanged(changedDestination)).toBe(false);

    expect(reasoningReplayServingIdentityChanged(undefined)).toBe(false);
    expect(reasoningReplayServingIdentityChanged({ clientThreadId: "thread-unknown" })).toBe(false);
  });

  test("serving identity refuses to record when durable dimensions are unavailable", () => {
    const clientThreadId = "thread-without-durable-identity";
    const withoutCredential = {
      ...scope({ credentialDurableIdentity: undefined }),
      clientThreadId,
    };
    expect(reasoningReplayServingIdentityChanged(withoutCredential)).toBe(false);
    commitReasoningReplayServingIdentity(withoutCredential);
    expect(reasoningReplayServingIdentityChanged({
      ...scope({ modelId: "different-model" }),
      clientThreadId,
    })).toBe(false);

    const destinationThreadId = "thread-without-durable-destination";
    const withoutDestination = {
      ...scope({ providerDestinationDurableIdentity: undefined }),
      clientThreadId: destinationThreadId,
    };
    expect(reasoningReplayServingIdentityChanged(withoutDestination)).toBe(false);
    commitReasoningReplayServingIdentity(withoutDestination);
    expect(reasoningReplayServingIdentityChanged({
      ...scope({ modelId: "different-model" }),
      clientThreadId: destinationThreadId,
    })).toBe(false);
  });

  test("known serving deltas separate model compatibility from credential and destination ownership", () => {
    commitReasoningReplayServingIdentity(scope());
    expect(reasoningReplayServingIdentityChange(scope())).toBeUndefined();
    expect(reasoningReplayServingIdentityChange(scope({ modelId: "other-model" }))).toEqual({
      providerChanged: false, destinationChanged: false, adapterChanged: false,
      modelChanged: true, credentialChanged: false,
    });
    expect(reasoningReplayServingIdentityChange(scope({
      modelId: "other-model", credentialDurableIdentity: "credential:other-slot",
    }))).toMatchObject({ modelChanged: true, credentialChanged: true, destinationChanged: false });
    expect(reasoningReplayServingIdentityChange(scope({
      providerDestinationDurableIdentity: "destination:other-backend",
    }))).toMatchObject({ destinationChanged: true, modelChanged: false, credentialChanged: false });
    expect(reasoningReplayServingIdentityChange({ clientThreadId: "unknown-thread" })).toBeUndefined();
  });

  test("opaque-blob rejection memos use the durable serving identity and refuse incomplete scopes", () => {
    const rejected = scope({ modelId: "destination-b-model" });
    rememberReasoningReplayOpaqueBlobRejection(rejected);
    expect(reasoningReplayOpaqueBlobRejectionMemoized(rejected)).toBe(true);
    expect(reasoningReplayOpaqueBlobRejectionMemoized(scope({ modelId: "destination-a-model" }))).toBe(false);
    expect(reasoningReplayOpaqueBlobRejectionMemoized({
      ...rejected,
      clientThreadId: "another-conversation",
    })).toBe(false);

    for (const incomplete of [
      scope({ credentialDurableIdentity: undefined }),
      scope({ providerDestinationDurableIdentity: undefined }),
      { clientThreadId: THREAD },
    ]) {
      rememberReasoningReplayOpaqueBlobRejection(incomplete);
      expect(reasoningReplayOpaqueBlobRejectionMemoized(incomplete)).toBe(false);
    }
  });

  test("opaque-blob rejection memos use the serving record's 64-entry bound", () => {
    let clock = 1_000;
    clearReasoningReplayCacheForTests(() => clock);
    for (let i = 0; i < 65; i++) {
      rememberReasoningReplayOpaqueBlobRejection({
        ...scope(),
        clientThreadId: `memo-thread-${i}`,
      });
      clock += 1;
    }

    expect(reasoningReplayOpaqueBlobRejectionMemoized({
      ...scope(),
      clientThreadId: "memo-thread-0",
    })).toBe(false);
    expect(reasoningReplayOpaqueBlobRejectionMemoized({
      ...scope(),
      clientThreadId: "memo-thread-1",
    })).toBe(true);
    expect(reasoningReplayOpaqueBlobRejectionMemoized({
      ...scope(),
      clientThreadId: "memo-thread-64",
    })).toBe(true);
  });

  test("expired serving identity is unknown rather than a backend change", () => {
    let clock = 1_000;
    clearReasoningReplayCacheForTests(() => clock);
    expect(reasoningReplayServingIdentityChanged(scope())).toBe(false);
    commitReasoningReplayServingIdentity(scope());

    clock += 60 * 60 * 1000 + 1;
    expect(reasoningReplayServingIdentityChanged(scope({ modelId: "deepseek-v4" }))).toBe(false);
  });

  test("repeated identity changes do not grow the thread store beyond 64 entries", () => {
    const servingScope = (
      threadId: string,
      modelId: string,
    ): OcxReasoningReplayScopeRef => ({
      ...scope({ modelId }),
      clientThreadId: threadId,
    });

    for (let i = 0; i < 64; i++) {
      const candidate = servingScope(`thread-${i}`, "model-a");
      expect(reasoningReplayServingIdentityChanged(candidate)).toBe(false);
      commitReasoningReplayServingIdentity(candidate);
    }
    for (let i = 0; i < 70; i++) {
      const candidate = servingScope("thread-63", `model-change-${i}`);
      expect(reasoningReplayServingIdentityChanged(candidate)).toBe(true);
      commitReasoningReplayServingIdentity(candidate);
    }

    const added = servingScope("thread-64", "model-a");
    expect(reasoningReplayServingIdentityChanged(added)).toBe(false);
    commitReasoningReplayServingIdentity(added);
    expect(reasoningReplayServingIdentityChanged(servingScope("thread-1", "model-b"))).toBe(true);
    expect(reasoningReplayServingIdentityChanged(servingScope("thread-0", "model-b"))).toBe(false);
  });

  test("incomplete, unscoped, and legacy thread-only namespaces fail closed", () => {
    const incomplete: OcxReasoningReplayScopeRef[] = [
      { clientThreadId: THREAD },
      scope({ credentialIdentity: "" }),
    ];
    for (const candidate of incomplete) {
      rememberReasoningForCall(CALL_ID, REASONING, candidate);
      expect(peekReasoningForCall(CALL_ID, candidate)).toBeUndefined();
    }
    rememberReasoningForCall(CALL_ID, REASONING);
    expect(peekReasoningForCall(CALL_ID)).toBeUndefined();
    rememberReasoningForCall(CALL_ID, REASONING, THREAD as unknown as OcxReasoningReplayScopeRef);
    expect(peekReasoningForCall(CALL_ID, THREAD as unknown as OcxReasoningReplayScopeRef)).toBeUndefined();
  });

  test("invalidating a bound holder prevents writes under its stale identity", () => {
    const bound = authenticatedScope();
    const oldIdentity = authenticatedScope();
    rememberReasoningForCall(CALL_ID, "old reasoning", oldIdentity);

    bindReasoningReplayScope(bound, undefined);
    expect(bound.current).toBeUndefined();
    rememberReasoningForCall(CALL_ID, "stale overwrite", bound);

    expect(peekReasoningForCall(CALL_ID, oldIdentity)).toBe("old reasoning");
    expect(peekReasoningForCall(CALL_ID, bound)).toBeUndefined();
  });

  test("credential and destination identities are stable, bounded, and never contain raw material", () => {
    const provider = {
      apiKey: "secret-key-a",
      headers: { Authorization: "Bearer static-secret", "x-session-id": "session-a" },
    };
    const first = reasoningReplayKeyCredentialIdentity(provider);
    const same = reasoningReplayKeyCredentialIdentity({
      headers: { Authorization: "Bearer static-secret", "x-session-id": "session-b" },
      apiKey: "secret-key-a",
    });
    const different = reasoningReplayKeyCredentialIdentity({ ...provider, apiKey: "secret-key-b" });
    const overridden = reasoningReplayKeyCredentialIdentity({
      ...provider,
      headers: { Authorization: "Bearer other-static-secret" },
    });
    expect(first).toBe(same);
    expect(first).not.toBe(different);
    expect(first).not.toBe(overridden);
    expect(reasoningReplayKeyCredentialIdentity({
      headers: { "x-opencode-client": "desktop" },
    })).toBeUndefined();
    expect(first).not.toContain("secret-key-a");
    expect(first).not.toContain("static-secret");

    const oauthA = reasoningReplayOAuthCredentialIdentity({ accountId: "slot-a", generation: "generation-a" }, {
      Authorization: "Bearer override-a",
    });
    const oauthOverrideB = reasoningReplayOAuthCredentialIdentity({ accountId: "slot-a", generation: "generation-a" }, {
      Authorization: "Bearer override-b",
    });
    const oauthGenerationB = reasoningReplayOAuthCredentialIdentity({ accountId: "slot-a", generation: "generation-b" }, {
      Authorization: "Bearer override-a",
    });
    const oauthAccountB = reasoningReplayOAuthCredentialIdentity({ accountId: "slot-b", generation: "generation-a" }, {
      Authorization: "Bearer override-a",
    });
    expect(oauthA).not.toBe(oauthOverrideB);
    expect(oauthA).not.toBe(oauthGenerationB);
    expect(oauthA).not.toBe(oauthAccountB);
    expect(oauthA).not.toContain("slot-a");
    expect(oauthA).not.toContain("generation-a");
    expect(reasoningReplayOAuthCredentialIdentity({ accountId: "", generation: "generation-a" })).toBeUndefined();
    expect(reasoningReplayOAuthCredentialIdentity({ accountId: "slot-a", generation: "" })).toBeUndefined();
    expect(oauthA).not.toContain("override-a");

    const forwardA = reasoningReplayCodexCredentialIdentity({
      authorization: "Bearer forward-token-a",
      chatgptAccountId: "workspace-a",
    });
    const forwardB = reasoningReplayCodexCredentialIdentity({
      authorization: "Bearer forward-token-b",
      chatgptAccountId: "workspace-a",
    });
    const poolA = reasoningReplayCodexCredentialIdentity({
      authorization: "Bearer shared-token",
      chatgptAccountId: "workspace-a",
      accountId: "pool-a",
      credentialGeneration: 7,
      writerGeneration: 11,
    });
    const poolB = reasoningReplayCodexCredentialIdentity({
      authorization: "Bearer shared-token",
      chatgptAccountId: "workspace-a",
      accountId: "pool-b",
      credentialGeneration: 7,
      writerGeneration: 11,
    });
    const newerPoolA = reasoningReplayCodexCredentialIdentity({
      authorization: "Bearer shared-token",
      chatgptAccountId: "workspace-a",
      accountId: "pool-a",
      credentialGeneration: 8,
      writerGeneration: 12,
    });
    expect(forwardA).not.toBe(forwardB);
    expect(poolA).not.toBe(poolB);
    expect(poolA).not.toBe(newerPoolA);
    expect(poolA).not.toBe(reasoningReplayCodexCredentialIdentity({
      authorization: "Bearer shared-token",
      chatgptAccountId: "workspace-a",
      accountId: "pool-a",
      credentialGeneration: 7,
      writerGeneration: 12,
    }));
    expect(forwardA).not.toContain("forward-token-a");
    expect(poolA).not.toContain("pool-a");
    expect(reasoningReplayCodexCredentialIdentity({ chatgptAccountId: "workspace-a" })).toBeUndefined();

    const destination = reasoningReplayDestinationIdentity("https://provider.example/v1/opaque-secret");
    expect(destination).toBe(reasoningReplayDestinationIdentity("https://provider.example/v1/opaque-secret/"));
    expect(destination).not.toBe(reasoningReplayDestinationIdentity("https://provider.example/v1/other-secret"));
    expect(destination).not.toContain("opaque-secret");
  });

  test("request-owned Codex bearers are distinct in process and refuse durable replay identity", () => {
    const callerA = reasoningReplayCodexCredentialIdentity({
      authorization: "Bearer caller-token-a",
      chatgptAccountId: "caller-account-a",
    });
    const callerB = reasoningReplayCodexCredentialIdentity({
      authorization: "Bearer caller-token-b",
      chatgptAccountId: "caller-account-b",
    });

    expect(callerA).toBeDefined();
    expect(callerB).toBeDefined();
    expect(callerA).not.toBe(callerB);
    expect(durableReplayCredentialIdentity("codex", undefined, undefined, Buffer.alloc(32, 7)))
      .toBeUndefined();
  });

  test("a bridge created before credential rotation writes under the holder's current identity", async () => {
    const oldScope = authenticatedScope();
    rememberReasoningForCall(CALL_ID, "old reasoning", oldScope);
    const holder = authenticatedScope();
    async function* events(): AsyncGenerator<AdapterEvent> {
      yield { type: "reasoning_raw_delta", text: "new reasoning" };
      holder.current = { ...holder.current!, credentialIdentity: "key:physical-b" };
      yield { type: "tool_call_start", id: CALL_ID, name: "read_file" };
      yield { type: "tool_call_delta", arguments: "{}" };
      yield { type: "tool_call_end" };
      yield { type: "done" };
    }
    const pending = drain(events(), holder);
    await pending;
    expect(peekReasoningForCall(CALL_ID, oldScope)).toBe("old reasoning");
    expect(peekReasoningForCall(CALL_ID, holder)).toBe("new reasoning");
  });
});


describe("selective opaque-blob rejection memos", () => {
  const digest = (index: number): string => index.toString(16).padStart(64, "0");
  const fingerprints = (count: number): Set<string> => new Set(Array.from({ length: count }, (_, index) => digest(index)));
  beforeEach(() => clearReasoningReplayCacheForTests());
  afterEach(() => clearReasoningReplayCacheForTests());

  test("distinguishes absent, selective and sticky blanket memos while preserving the boolean API", () => {
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toBeUndefined();
    expect(reasoningReplayOpaqueBlobRejectionMemoized(scope())).toBe(false);
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(1)]));
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "selective", fingerprints: new Set([digest(1)]) });
    expect(reasoningReplayOpaqueBlobRejectionMemoized(scope())).toBe(true);
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(1), digest(2)]));
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "selective", fingerprints: new Set([digest(1), digest(2)]) });
    rememberReasoningReplayOpaqueBlobRejection(scope());
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "blanket" });
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(3)]));
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "blanket" });
  });

  test("allows 256 distinct digests but falls back to blanket when a merge or one input overflows", () => {
    rememberReasoningReplayOpaqueBlobRejection(scope(), fingerprints(256));
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "selective", fingerprints: fingerprints(256) });
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(255)]));
    expect(getReasoningReplayOpaqueBlobRejection(scope())?.mode).toBe("selective");
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(256)]));
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "blanket" });
    const other = { ...scope(), clientThreadId: "overflow-input" };
    rememberReasoningReplayOpaqueBlobRejection(other, fingerprints(257));
    expect(getReasoningReplayOpaqueBlobRejection(other)).toEqual({ mode: "blanket" });
  });

  test.each([
    new Set(), new Set(["a".repeat(63)]), new Set(["A".repeat(64)]),
    new Set(["a".repeat(64) + "\n"]), new Set(["g".repeat(64)]), new Set([null]),
    null, ["a".repeat(64)], { size: 1, [Symbol.iterator]() { throw new Error("untrusted iterator"); } },
  ].map(value => ({ value })))("invalid or unreliable fingerprint input falls back without throwing: %j", ({ value }) => {
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(1)]));
    expect(() => rememberReasoningReplayOpaqueBlobRejection(scope(), value as ReadonlySet<string>)).not.toThrow();
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "blanket" });
  });

  test("caller-owned input and getter output cannot mutate retained fingerprints", () => {
    const input = new Set([digest(1)]);
    rememberReasoningReplayOpaqueBlobRejection(scope(), input);
    input.clear(); input.add("invalid");
    const observed = getReasoningReplayOpaqueBlobRejection(scope());
    expect(observed).toEqual({ mode: "selective", fingerprints: new Set([digest(1)]) });
    if (observed?.mode !== "selective") throw new Error("selective memo missing");
    (observed.fingerprints as Set<string>).clear();
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "selective", fingerprints: new Set([digest(1)]) });
  });

  test("uses durable scope dimensions, ignores volatile generations and refuses incomplete scopes", () => {
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(1)]));
    expect(getReasoningReplayOpaqueBlobRejection(scope({ credentialIdentity: "new-process-token" }))?.mode).toBe("selective");
    for (const changed of [
      { ...scope(), clientThreadId: "different-thread" }, scope({ providerName: "different-provider" }),
      scope({ providerDestinationDurableIdentity: "different-destination" }), scope({ adapterName: "anthropic" }),
      scope({ modelId: "different-model" }), scope({ credentialDurableIdentity: "different-credential" }),
    ]) expect(getReasoningReplayOpaqueBlobRejection(changed)).toBeUndefined();
    for (const incomplete of [undefined, scope({ credentialDurableIdentity: undefined }), scope({ providerDestinationDurableIdentity: undefined })]) {
      rememberReasoningReplayOpaqueBlobRejection(incomplete, new Set([digest(1)]));
      expect(getReasoningReplayOpaqueBlobRejection(incomplete)).toBeUndefined();
    }
  });

  test("reads do not refresh five-minute expiry, expired memos do not merge, and clear resets both APIs", () => {
    let clock = 1000;
    clearReasoningReplayCacheForTests(() => clock);
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(1)]));
    clock += 5 * 60 * 1000 - 1;
    expect(getReasoningReplayOpaqueBlobRejection(scope())?.mode).toBe("selective");
    clock += 1;
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toBeUndefined();
    expect(reasoningReplayOpaqueBlobRejectionMemoized(scope())).toBe(false);
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(2)]));
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "selective", fingerprints: new Set([digest(2)]) });
    rememberReasoningReplayOpaqueBlobRejection(scope());
    clock += 5 * 60 * 1000;
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(3)]));
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "selective", fingerprints: new Set([digest(3)]) });
    clearReasoningReplayCacheForTests();
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toBeUndefined();
    expect(reasoningReplayOpaqueBlobRejectionMemoized(scope())).toBe(false);
  });

  test("merging refreshes the existing expiry without losing earlier selective digests", () => {
    let clock = 1000;
    clearReasoningReplayCacheForTests(() => clock);
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(1)]));
    clock += 200_000;
    rememberReasoningReplayOpaqueBlobRejection(scope(), new Set([digest(2)]));
    clock += 100_000;
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "selective", fingerprints: new Set([digest(1), digest(2)]) });
    clock += 200_000;
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toBeUndefined();
  });

  test("fingerprint bytes participate in the existing 256 KiB oldest-entry eviction", () => {
    let clock = 1000;
    clearReasoningReplayCacheForTests(() => clock);
    for (let index = 0; index < 16; index++) {
      rememberReasoningReplayOpaqueBlobRejection({ ...scope(), clientThreadId: `byte-thread-${index}` }, fingerprints(256));
      clock++;
    }
    expect(getReasoningReplayOpaqueBlobRejection({ ...scope(), clientThreadId: "byte-thread-0" })).toBeUndefined();
    expect(getReasoningReplayOpaqueBlobRejection({ ...scope(), clientThreadId: "byte-thread-1" })?.mode).toBe("selective");
    expect(getReasoningReplayOpaqueBlobRejection({ ...scope(), clientThreadId: "byte-thread-15" })?.mode).toBe("selective");
  });

  test("replacing a selective memo with blanket releases its retained fingerprint bytes", () => {
    let clock = 1000;
    clearReasoningReplayCacheForTests(() => clock);
    rememberReasoningReplayOpaqueBlobRejection(scope(), fingerprints(256));
    rememberReasoningReplayOpaqueBlobRejection(scope());
    for (let index = 0; index < 15; index++) {
      clock++;
      rememberReasoningReplayOpaqueBlobRejection({ ...scope(), clientThreadId: `byte-thread-${index}` }, fingerprints(256));
    }
    expect(getReasoningReplayOpaqueBlobRejection(scope())).toEqual({ mode: "blanket" });
    expect(getReasoningReplayOpaqueBlobRejection({ ...scope(), clientThreadId: "byte-thread-0" })?.mode).toBe("selective");
  });

  test("falls back to the old blanket entry when a valid set cannot fit beside a near-limit key", () => {
    const current = scope().current!;
    const identity = JSON.stringify([current.providerName, current.providerDestinationDurableIdentity, current.adapterName, current.modelId, current.credentialDurableIdentity]);
    const overhead = Buffer.byteLength(JSON.stringify([JSON.stringify([null, ""]), identity]));
    const nearLimit = { ...scope(), clientThreadId: "t".repeat(256 * 1024 - overhead - 1) };
    rememberReasoningReplayOpaqueBlobRejection(nearLimit, new Set([digest(1)]));
    expect(getReasoningReplayOpaqueBlobRejection(nearLimit)).toEqual({ mode: "blanket" });
  });
});

describe("actual Anthropic rejection capture", () => {
  const body = (count: number) => ({ messages: [{ role: "assistant", content: Array.from({ length: count }, (_, index) => ({ type: "thinking", signature: `SyntheticCapture${index}` })) }] });
  test("fingerprints exclude text and metadata and separate opaque domains", () => {
    const signature = "SyntheticOpaqueBytes";
    expect(anthropicOpaqueFingerprint({ type: "thinking", signature, thinking: "before", ap: "original" }))
      .toBe(anthropicOpaqueFingerprint({ type: "thinking", signature, thinking: "after", ap: "forged" }));
    expect(anthropicOpaqueFingerprint({ type: "thinking", signature }))
      .not.toBe(anthropicOpaqueFingerprint({ type: "redacted_thinking", data: signature }));
  });
  test("complete capture is bounded, charged until disposal, and defensively copied", () => {
    const budget = createTranslatorBudget();
    const request = {} as AdapterRequest;
    const response = new Response(null, { status: 400 });
    try {
      captureAnthropicRejectionPayloads(request, body(256), budget);
      bindAnthropicRejectionResponse(request, response);
      expect(budget.snapshot().currentBytes).toBe(256 * 256);
      expect(rejectedAnthropicPayloads(response)?.size).toBe(256);
      (rejectedAnthropicPayloads(response) as Set<string>).clear();
      expect(rejectedAnthropicPayloads(response)?.size).toBe(256);
    } finally { budget.dispose(); }
    expect(budget.snapshot().currentBytes).toBe(0);
  });
  test("overflow and missing budget never narrow the rejection policy", () => {
    const budget = createTranslatorBudget();
    const request = {} as AdapterRequest;
    const response = new Response(null, { status: 400 });
    try {
      captureAnthropicRejectionPayloads(request, body(257), budget);
      bindAnthropicRejectionResponse(request, response);
      expect(rejectedAnthropicPayloads(response)).toBeUndefined();
      expect(budget.snapshot().currentBytes).toBe(0);
      captureAnthropicRejectionPayloads(request, body(1));
      bindAnthropicRejectionResponse(request, response);
      expect(rejectedAnthropicPayloads(response)).toBeUndefined();
    } finally { budget.dispose(); }
  });
  test("admission failure refunds only admitted digests", () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 600 });
    budget.chargeRetained(123, { kind: "reasoning" });
    const request = {} as AdapterRequest;
    const response = new Response(null, { status: 400 });
    try {
      captureAnthropicRejectionPayloads(request, body(2), budget);
      bindAnthropicRejectionResponse(request, response);
      expect(rejectedAnthropicPayloads(response)).toBeUndefined();
      expect(budget.snapshot().currentBytes).toBe(123);
    } finally { budget.dispose(); }
  });
  test("failed recapture clears stale request and response ownership", () => {
    const budget = createTranslatorBudget();
    const request = {} as AdapterRequest;
    const response = new Response(null, { status: 400 });
    try {
      captureAnthropicRejectionPayloads(request, body(1), budget);
      bindAnthropicRejectionResponse(request, response);
      expect(rejectedAnthropicPayloads(response)?.size).toBe(1);
      captureAnthropicRejectionPayloads(request, { messages: [{ content: null }] }, budget);
      bindAnthropicRejectionResponse(request, response);
      expect(rejectedAnthropicPayloads(response)).toBeUndefined();
    } finally { budget.dispose(); }
  });
});

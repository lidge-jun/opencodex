import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import {
  bindReasoningReplayScope,
  clearReasoningReplayCacheForTests,
  commitReasoningReplayServingIdentity,
  peekReasoningForCall,
  reasoningReplayCodexCredentialIdentity,
  reasoningReplayCredentialIdentity,
  reasoningReplayDestinationIdentity,
  reasoningReplayKeyCredentialIdentity,
  reasoningReplayOAuthCredentialIdentity,
  reasoningReplayServingIdentityChanged,
  rememberReasoningForCall,
} from "../src/responses/reasoning-replay-cache";
import type { AdapterEvent, OcxReasoningReplayScopeRef } from "../src/types";

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

describe("reasoning replay provider and credential identity", () => {
  beforeEach(() => clearReasoningReplayCacheForTests());
  afterEach(() => clearReasoningReplayCacheForTests());

  test("the same tuple replays but provider, destination, wire, model, or credential changes miss", () => {
    const original = scope();
    rememberReasoningForCall(CALL_ID, REASONING, original);
    expect(peekReasoningForCall(CALL_ID, scope())).toBe(REASONING);

    for (const changed of [
      scope({ providerName: "provider-b" }),
      scope({ providerDestinationIdentity: "destination:provider-b" }),
      scope({ adapterName: "openai-responses" }),
      scope({ modelId: "deepseek-v4" }),
      scope({ credentialIdentity: "key:physical-b" }),
    ]) {
      expect(peekReasoningForCall(CALL_ID, changed)).toBeUndefined();
    }
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
    const bound = scope();
    const oldIdentity = scope();
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

  test("a bridge created before credential rotation writes under the holder's current identity", async () => {
    const oldScope = scope();
    rememberReasoningForCall(CALL_ID, "old reasoning", oldScope);
    const holder = scope();
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

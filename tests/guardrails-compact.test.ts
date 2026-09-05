import { afterEach, expect, test } from "bun:test";
import {
  clearGuardrailsCompactContinuationsForTests,
  evictOldestGuardrailsCompactContinuationForBudget,
  guardrailsCompactContinuationRetainedStoreSnapshot,
  rememberGuardrailsCompactContinuation,
  retainGuardrailsCompactContinuation,
  sweepExpiredGuardrailsCompactContinuations,
} from "../src/guardrails/compact-continuations";
import { createGuardrailsContinuationScope } from "../src/guardrails/continuations";
import {
  decodeCompactionSummary,
  encodeCompactionSummary,
} from "../src/responses/compaction";
import { handleResponses } from "../src/server/responses/core";
import {
  clearCompactHandoffRoutesForTests,
  handleResponsesCompact,
} from "../src/server/responses/compact";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearGuardrailsCompactContinuationsForTests();
  clearCompactHandoffRoutesForTests();
});

function config(options: {
  baseUrl?: string;
  guardrails?: OcxConfig["guardrails"];
  providerName?: string;
} = {}): OcxConfig {
  const providerName = options.providerName ?? "openai-apikey";
  return {
    defaultProvider: providerName,
    providers: {
      [providerName]: {
        adapter: "openai-responses",
        authMode: "key",
        apiKey: "test-key",
        baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
      },
    },
    ...(options.guardrails === undefined
      ? { guardrails: { enabled: true, mode: "enforce", failurePolicy: "block" } }
      : { guardrails: options.guardrails }),
  } as OcxConfig;
}

test("native compact stays masked and its mapping follows exact returned items", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const upstreamBodies: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamBodies.push(String(init?.body ?? ""));
    if (upstreamBodies.length > 1) {
      return Response.json({
        id: "response-after-compact",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "restored <STRIPE_ACCESS_TOKEN_1>" }],
        }],
      });
    }
    return Response.json({
      id: "compact-guardrails-response",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "summary <STRIPE_ACCESS_TOKEN_1>" }] }],
    });
  }) as typeof fetch;
  const request = new Request("http://localhost/v1/responses/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-parent-thread-id": "compact-thread",
    },
    body: JSON.stringify({
      model: "openai-apikey/gpt-5.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: secret }] }],
    }),
  });
  const logCtx: RequestLogContext = { model: "", provider: "", admissionKind: "loopback" };
  const initialConfig = config();

  const response = await handleResponsesCompact(request, initialConfig, logCtx);
  const compactPayload = await response.json() as { output: unknown[] };
  expect(upstreamBodies[0]).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(upstreamBodies[0]).not.toContain(secret);
  expect(JSON.stringify(compactPayload)).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(JSON.stringify(compactPayload)).not.toContain(secret);
  expect(logCtx.sensitiveDataProtectionActive).toBe(true);

  const continuation = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-parent-thread-id": "compact-thread",
    },
    body: JSON.stringify({
      model: "openai-apikey/gpt-5.5",
      input: [
        ...compactPayload.output,
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    }),
  });
  const continuedConfig = config();
  continuedConfig.guardrails = {
    ...continuedConfig.guardrails!,
    disabledBuiltinRuleIds: ["credentials.url_with_creds"],
  };
  const continued = await handleResponses(
    continuation,
    continuedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  );
  expect(upstreamBodies[1]).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(upstreamBodies[1]).not.toContain(secret);
  expect(JSON.stringify(await continued.json())).toContain(secret);
});

test("routed compact stays masked and retains its continuation mapping", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const upstreamBodies: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamBodies.push(String(init?.body ?? ""));
    if (upstreamBodies.length > 1) {
      return Response.json({
        id: "response-after-routed-compact",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "restored <STRIPE_ACCESS_TOKEN_1>" }],
        }],
      });
    }
    return Response.json({
      id: "routed-compact-guardrails-response",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "summary <STRIPE_ACCESS_TOKEN_1>" }],
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  }) as typeof fetch;
  const routedConfig = config({
    baseUrl: "https://gateway.example/v1",
    providerName: "gw",
  });
  const response = await handleResponsesCompact(
    new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-parent-thread-id": "routed-compact-thread",
      },
      body: JSON.stringify({
        model: "gw/gpt-5.5",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: secret }] }],
      }),
    }),
    routedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  );
  const compactPayload = await response.json() as { output: unknown[] };
  expect(response.status).toBe(200);
  expect(upstreamBodies[0]).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(upstreamBodies[0]).not.toContain(secret);
  expect(JSON.stringify(compactPayload)).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(JSON.stringify(compactPayload)).not.toContain(secret);

  const continued = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-parent-thread-id": "routed-compact-thread",
      },
      body: JSON.stringify({
        model: "gw/gpt-5.5",
        input: [
          ...compactPayload.output,
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
        ],
      }),
    }),
    routedConfig,
    { model: "", provider: "", admissionKind: "loopback" },
  );
  expect(upstreamBodies[1]).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(upstreamBodies[1]).not.toContain(secret);
  expect(JSON.stringify(await continued.json())).toContain(secret);
});

test("provider scope leaves an excluded routed compact request unchanged", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  let upstreamBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamBody = String(init?.body ?? "");
    return Response.json({
      id: "routed-compact-excluded",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "literal <STRIPE_ACCESS_TOKEN_1>" }],
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  }) as typeof fetch;
  const scoped = config({
    baseUrl: "https://gateway.example/v1",
    providerName: "gw",
  });
  scoped.guardrails!.providerScope = {
    mode: "selected",
    providerIds: ["other"],
  };
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponsesCompact(
    new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gw/gpt-5.5",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: secret }],
        }],
      }),
    }),
    scoped,
    logCtx,
  );
  const responseText = JSON.stringify(await response.json());

  expect(response.status).toBe(200);
  expect(upstreamBody).toContain(secret);
  expect(upstreamBody).not.toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(responseText).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(responseText).not.toContain(`literal ${secret}`);
  expect(logCtx.sensitiveDataProtectionActive).not.toBe(true);
});

test("native compact masks plaintext inside local ocx1 envelopes before upstream I/O", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  let upstreamBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      id: "compact-local-envelope",
      status: "completed",
      output: [{ type: "compaction", encrypted_content: "provider-ciphertext" }],
    });
  }) as typeof fetch;

  const response = await handleResponsesCompact(
    new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai-apikey/gpt-5.5",
        input: [{
          type: "compaction",
          encrypted_content: encodeCompactionSummary(`summary ${secret}`),
        }],
      }),
    }),
    config(),
    { model: "", provider: "", admissionKind: "loopback" },
  );
  const input = upstreamBody?.input as Array<{ encrypted_content?: string }> | undefined;
  const decoded = decodeCompactionSummary(input?.[0]?.encrypted_content ?? "");

  expect(response.status).toBe(200);
  expect(decoded).toContain("<STRIPE_ACCESS_TOKEN_1>");
  expect(decoded).not.toContain(secret);
});

test("compact quota fallback blocks an excluded-to-protected provider transition before the fallback send", async () => {
  const sentUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sentUrls.push(String(input));
    return Response.json(
      { error: { message: "quota exhausted", type: "rate_limit_error" } },
      { status: 429 },
    );
  }) as typeof fetch;
  const scoped = config({ providerName: "excluded" });
  scoped.providers = {
    excluded: {
      adapter: "openai-responses",
      authMode: "key",
      apiKey: "test-key",
      baseUrl: "https://excluded.example/v1",
    },
    protected: {
      adapter: "openai-responses",
      authMode: "key",
      apiKey: "test-key",
      baseUrl: "https://protected.example/v1",
    },
  };
  scoped.guardrails!.providerScope = {
    mode: "selected",
    providerIds: ["protected"],
  };
  const blocked = await handleResponsesCompact(
    new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "protected/gpt-5.5",
        input: [{ type: "message", role: "user", content: "compact me" }],
      }),
    }),
    scoped,
    { model: "", provider: "", admissionKind: "loopback" },
    undefined,
    undefined,
    { guardrailsProviderScopeAnchor: "excluded" },
  );
  const blockedBody = await blocked.json() as { error?: { code?: string } };

  expect(sentUrls).toHaveLength(0);
  expect(blocked.status).toBe(409);
  expect(blockedBody.error?.code).toBe("guardrails_policy_changed");
});

test("compact late scan failure blocks atomically or restores the complete original body", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const oversizedSummary = `summary ${"x".repeat(128 * 1024 + 1)}`;
  const encodedSummary = encodeCompactionSummary(oversizedSummary);
  for (const failurePolicy of ["block", "passthrough"] as const) {
    const upstreamBodies: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBodies.push(String(init?.body ?? ""));
      return Response.json({
        id: `compact-${failurePolicy}`,
        status: "completed",
        output: [{ type: "compaction", encrypted_content: "provider-ciphertext" }],
      });
    }) as typeof fetch;
    const candidate = config();
    candidate.guardrails!.failurePolicy = failurePolicy;
    const response = await handleResponsesCompact(
      new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai-apikey/gpt-5.5",
          input: [
            { type: "message", role: "user", content: secret },
            { type: "compaction", encrypted_content: encodedSummary },
          ],
        }),
      }),
      candidate,
      { model: "", provider: "", admissionKind: "loopback" },
    );
    await response.text();

    if (failurePolicy === "block") {
      expect(response.status).toBe(413);
      expect(upstreamBodies).toHaveLength(0);
    } else {
      expect(response.status).toBe(200);
      expect(upstreamBodies).toHaveLength(1);
      expect(upstreamBodies[0]).toContain(secret);
      expect(upstreamBodies[0]).toContain(encodedSummary);
      expect(upstreamBodies[0]).not.toContain("<STRIPE_ACCESS_TOKEN_1>");
    }
  }
});

test("compact quota handoff returns Guardrails provider-scope 409 instead of the first quota error", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("api.openai.com")) {
      return Response.json(
        { error: { message: "quota exhausted", type: "rate_limit_error" } },
        { status: 429 },
      );
    }
    return Response.json({
      id: "routed-handoff-seed",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "handoff summary" }],
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  }) as typeof fetch;
  const candidate = config();
  candidate.providers = {
    "openai-apikey": candidate.providers["openai-apikey"]!,
    protected: {
      adapter: "openai-responses",
      authMode: "key",
      apiKey: "test-key",
      baseUrl: "https://protected.example/v1",
      models: ["gpt-5.5"],
    },
  };
  candidate.guardrails!.providerScope = {
    mode: "selected",
    providerIds: ["protected"],
  };
  const headers = {
    "content-type": "application/json",
    "x-codex-parent-thread-id": "guardrails-scope-handoff",
  };
  const seed = await handleResponsesCompact(
    new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "protected/gpt-5.5",
        input: [{ type: "message", role: "user", content: "seed handoff" }],
      }),
    }),
    candidate,
    { model: "", provider: "", admissionKind: "loopback" },
  );
  expect(seed.status).toBe(200);
  await seed.text();
  calls.length = 0;

  const response = await handleResponsesCompact(
    new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "openai-apikey/gpt-5.5",
        input: [{ type: "message", role: "user", content: "automatic compact" }],
      }),
    }),
    candidate,
    { model: "", provider: "", admissionKind: "loopback" },
  );
  const payload = await response.json() as { error?: { code?: string } };

  expect(response.status).toBe(409);
  expect(payload.error?.code).toBe("guardrails_policy_changed");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("api.openai.com");
});

test("disabled Guardrails preserve native and routed compact behavior", async () => {
  for (const route of [
    { baseUrl: "https://api.openai.com/v1", providerName: "openai-apikey" },
    { baseUrl: "https://gateway.example/v1", providerName: "gw" },
  ]) {
    const sentBodies: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push(String(init?.body ?? ""));
      return Response.json({
        id: "compact-disabled-response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "plain summary" }],
        }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      });
    }) as typeof fetch;
    const body = {
      model: `${route.providerName}/gpt-5.5`,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "plain input" }] }],
    };
    const run = async (runConfig: OcxConfig): Promise<string> => {
      const response = await handleResponsesCompact(
        new Request("http://localhost/v1/responses/compact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        runConfig,
        { model: "", provider: "", admissionKind: "loopback" },
      );
      expect(response.status).toBe(200);
      return response.text();
    };
    const absent = config({
      baseUrl: route.baseUrl,
      guardrails: undefined,
      providerName: route.providerName,
    });
    delete absent.guardrails;
    const absentResponse = await run(absent);
    const disabledResponse = await run(config({
      baseUrl: route.baseUrl,
      guardrails: { enabled: false, mode: "enforce", failurePolicy: "block" },
      providerName: route.providerName,
    }));
    expect(sentBodies[1]).toBe(sentBodies[0]);
    expect(disabledResponse).toBe(absentResponse);
  }
});

test("compact continuation rejects admission before pinned entries can exceed the byte cap", () => {
  const scope = createGuardrailsContinuationScope("loopback", undefined, "compact-pinned-cap");
  const leases: Array<{ release(): void }> = [];
  let rejected = false;
  try {
    for (let index = 0; index < 16; index += 1) {
      const items = [{ type: "message", role: "assistant", content: `item-${index}` }];
      const result = rememberGuardrailsCompactContinuation({
        items,
        lineageId: `lineage-${index}`,
        policyRevision: "a".repeat(64),
        scope,
        state: {
          replacements: [{
            dataType: 6,
            original: `${index}:${"x".repeat(1024 * 1024)}`,
            placeholder: `<TOKEN_${index + 1}>`,
            placeholderType: "TOKEN",
            ruleId: "test.capacity",
          }],
          reservedPlaceholders: [],
        },
      });
      if (result.status === "stored") {
        const lease = retainGuardrailsCompactContinuation(items, scope);
        expect(lease).toBeDefined();
        if (lease) leases.push(lease);
        expect(guardrailsCompactContinuationRetainedStoreSnapshot().bytes)
          .toBeLessThanOrEqual(8 * 1024 * 1024);
        continue;
      }
      expect(result.status).toBe("over_capacity");
      rejected = true;
      break;
    }
    expect(rejected).toBe(true);
    expect(guardrailsCompactContinuationRetainedStoreSnapshot().bytes)
      .toBeLessThanOrEqual(8 * 1024 * 1024);
  } finally {
    for (const lease of leases) lease.release();
  }
});

test("compact continuation poisons an identical fingerprint across lineages until expiry", () => {
  const scope = createGuardrailsContinuationScope("loopback", undefined, "compact-policy-revision");
  const prefixItems = [{ type: "message", role: "assistant", content: "prefix" }];
  const items = [...prefixItems, { type: "message", role: "assistant", content: "summary" }];
  const expiresAt = Date.now() + 60_000;
  const state = {
    replacements: [{
      dataType: 6, original: "sk_live_abcdefghijklmnopqrstuvwx",
      placeholder: "<STRIPE_ACCESS_TOKEN_1>", placeholderType: "STRIPE_ACCESS_TOKEN",
      ruleId: "credentials.stripe_access_token",
    }],
    reservedPlaceholders: [],
  };
  expect(rememberGuardrailsCompactContinuation({
    items: prefixItems,
    lineageId: "lineage-prefix",
    policyRevision: "c".repeat(64),
    scope,
    state: { ...state, replacements: [{ ...state.replacements[0]!, original: "prefix-secret" }] },
  }).status).toBe("stored");
  expect(rememberGuardrailsCompactContinuation({
    expiresAt,
    items,
    lineageId: "lineage-old",
    policyRevision: "a".repeat(64),
    scope,
    state,
  }).status).toBe("stored");

  expect(rememberGuardrailsCompactContinuation({
    items,
    lineageId: "lineage-new",
    policyRevision: "b".repeat(64),
    scope,
    state,
  }).status).toBe("collision");
  expect(retainGuardrailsCompactContinuation(items, scope)).toBeUndefined();
  const tombstone = guardrailsCompactContinuationRetainedStoreSnapshot();
  expect(tombstone.count).toBe(2);
  expect(tombstone.bytes).toBeGreaterThan(0);
  expect(tombstone.bytes).toBe(tombstone.evictableBytes + tombstone.pinnedBytes);
  expect(tombstone.evictableBytes).toBeGreaterThan(0);
  expect(tombstone.pinnedBytes).toBe(0);
  expect(sweepExpiredGuardrailsCompactContinuations(expiresAt + 1)).toBe(1);
});

test("invalid compact replacement leaves the existing mapping intact", () => {
  const scope = createGuardrailsContinuationScope("loopback", undefined, "compact-invalid-replacement");
  const items = [{ type: "message", role: "assistant", content: "summary" }];
  const originalState = {
    replacements: [{
      dataType: 6 as const,
      original: "secret-a",
      placeholder: "<CUSTOM_1>",
      placeholderType: "CUSTOM",
      ruleId: "custom.replacement",
    }],
    reservedPlaceholders: [],
  };
  expect(rememberGuardrailsCompactContinuation({
    items,
    lineageId: "lineage-a",
    policyRevision: "a".repeat(64),
    scope,
    state: originalState,
  }).status).toBe("stored");
  const before = guardrailsCompactContinuationRetainedStoreSnapshot();

  expect(rememberGuardrailsCompactContinuation({
    expiresAt: Date.now() - 1,
    items,
    lineageId: "lineage-expired",
    policyRevision: "b".repeat(64),
    scope,
    state: {
      ...originalState,
      replacements: [{ ...originalState.replacements[0]!, original: "secret-expired" }],
    },
  }).status).toBe("expired");
  expect(guardrailsCompactContinuationRetainedStoreSnapshot()).toEqual(before);
  const retained = retainGuardrailsCompactContinuation(items, scope);
  expect(retained?.lineageId).toBe("lineage-a");
  expect(retained?.state.replacements[0]?.original).toBe("secret-a");
  retained?.release();
});

test("compact continuation preserves inherited absolute expiry across repeated chains", () => {
  const scope = createGuardrailsContinuationScope("loopback", undefined, "compact-absolute-expiry");
  const state = {
    replacements: [{
      dataType: 6 as const,
      original: "secret",
      placeholder: "<CUSTOM_1>",
      placeholderType: "CUSTOM",
      ruleId: "custom.expiry",
    }],
    reservedPlaceholders: [],
  };
  const inheritedExpiry = Date.now() + 50;
  const firstItems = [{ type: "message", role: "assistant", content: "first" }];
  expect(rememberGuardrailsCompactContinuation({
    expiresAt: inheritedExpiry,
    items: firstItems,
    lineageId: "lineage-expiry",
    policyRevision: "a".repeat(64),
    scope,
    state,
  }).status).toBe("stored");
  const first = retainGuardrailsCompactContinuation(firstItems, scope);
  expect(first?.expiresAt).toBe(inheritedExpiry);

  const secondItems = [{ type: "message", role: "assistant", content: "second" }];
  expect(rememberGuardrailsCompactContinuation({
    expiresAt: first?.expiresAt,
    items: secondItems,
    lineageId: first?.lineageId ?? "",
    policyRevision: first?.policyRevision ?? "",
    scope,
    state,
  }).status).toBe("stored");
  const second = retainGuardrailsCompactContinuation(secondItems, scope);
  expect(second?.expiresAt).toBe(inheritedExpiry);
  first?.release();
  second?.release();
  expect(sweepExpiredGuardrailsCompactContinuations(inheritedExpiry + 1)).toBe(2);
});

test("compact continuation stays scope-bound and is lost after process restart", () => {
  const originalScope = createGuardrailsContinuationScope(
    "configured",
    "key-a",
    "compact-thread",
  );
  const otherScope = createGuardrailsContinuationScope(
    "configured",
    "key-b",
    "compact-thread",
  );
  const items = [{ type: "message", role: "assistant", content: "summary" }];
  expect(rememberGuardrailsCompactContinuation({
    items,
    lineageId: "lineage-compact-scope",
    policyRevision: "a".repeat(64),
    scope: originalScope,
    state: {
      replacements: [{
        dataType: 6,
        original: "secret",
        placeholder: "<CUSTOM_1>",
        placeholderType: "CUSTOM",
        ruleId: "custom.scope",
      }],
      reservedPlaceholders: [],
    },
  }).status).toBe("stored");
  expect(retainGuardrailsCompactContinuation(items, otherScope)).toBeUndefined();
  const original = retainGuardrailsCompactContinuation(items, originalScope);
  expect(original).toBeDefined();
  original?.release();

  clearGuardrailsCompactContinuationsForTests();

  expect(retainGuardrailsCompactContinuation(items, originalScope)).toBeUndefined();
});

test("pinned compact collision poisons the fingerprint without exposing sibling state", () => {
  const scope = createGuardrailsContinuationScope("loopback", undefined, "compact-pinned-collision");
  const items = [{ type: "message", role: "assistant", content: "summary" }];
  const state = {
    replacements: [{
      dataType: 6 as const,
      original: "secret-a",
      placeholder: "<CUSTOM_1>",
      placeholderType: "CUSTOM",
      ruleId: "custom.collision",
    }],
    reservedPlaceholders: [],
  };
  expect(rememberGuardrailsCompactContinuation({
    items,
    lineageId: "lineage-a",
    policyRevision: "a".repeat(64),
    scope,
    state,
  }).status).toBe("stored");
  const pinned = retainGuardrailsCompactContinuation(items, scope);
  const before = guardrailsCompactContinuationRetainedStoreSnapshot();
  expect(rememberGuardrailsCompactContinuation({
    items,
    lineageId: "lineage-b",
    policyRevision: "b".repeat(64),
    scope,
    state: {
      ...state,
      replacements: [{ ...state.replacements[0]!, original: "secret-b" }],
    },
  }).status).toBe("collision");
  expect(retainGuardrailsCompactContinuation(items, scope)).toBeUndefined();
  const tombstone = guardrailsCompactContinuationRetainedStoreSnapshot();
  expect(tombstone.count).toBe(1);
  expect(tombstone.bytes).toBeLessThan(before.bytes);
  expect(tombstone.evictableBytes).toBe(0);
  expect(tombstone.pinnedBytes).toBe(tombstone.bytes);
  expect(evictOldestGuardrailsCompactContinuationForBudget()).toBe(0);
  expect(pinned?.state.replacements[0]?.original).toBe("secret-a");
  pinned?.release();
  expect(retainGuardrailsCompactContinuation(items, scope)).toBeUndefined();
  const released = guardrailsCompactContinuationRetainedStoreSnapshot();
  expect(released.pinnedBytes).toBe(0);
  expect(released.evictableBytes).toBe(released.bytes);
  expect(evictOldestGuardrailsCompactContinuationForBudget()).toBeGreaterThan(0);
});

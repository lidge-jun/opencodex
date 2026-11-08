import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import { clearComboSelectionState, clearComboTargetCooldowns, isComboTargetInCooldown } from "../../src/combos";
import {
  hasConflictingReasoningEffortCode,
  isReasoningEffortLearnedUnsupported,
  isReasoningEffortRejection,
  resetReasoningMetadataCachesForTests,
} from "../../src/providers/reasoning-metadata";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { chatSuccess } from "../helpers/combo-failover-upstream";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

/**
 * Rejected-rung learning on the request path: a rung the catalog advertises can still be refused
 * upstream because the ladder describes the model, not this account's entitlement (max on
 * muse-spark-1.3-contributor needs an active Muse Code subscription). The pipeline must learn the
 * refusal, replay once at the next published rung, and never replay an unrelated 400.
 */

const originalFetch = globalThis.fetch;
const originalOpenCodexHome = process.env.OPENCODEX_HOME;
const MODEL = "muse-spark-1.3-contributor";
const REFUSAL = JSON.stringify({
  error: {
    param: "reasoning.effort",
    type: "invalid_request_error",
    message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] reasoning_effort max requires an active Muse Code subscription for model muse-spark-1.3-contributor.",
  },
});
const POLICY_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    code: "cyber_policy",
    param: "reasoning_effort",
    message: "Request blocked by upstream cybersecurity policy.",
  },
});
const NESTED_POLICY_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    param: "reasoning_effort",
    message: 'Provider error 400: {"error":{"code":"bio_policy","message":"Request refused"}}',
  },
});
const OBJECT_DETAILS_POLICY_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    param: "reasoning_effort",
    details: { code: "bio_policy", message: "Request refused" },
  },
});
const CONFLICTING_CODE_REFUSAL = JSON.stringify({
  code: "permission_denied",
  error: {
    type: "invalid_request_error",
    param: "reasoning_effort",
    message: "Invalid reasoning effort.",
  },
});
const SERIALIZED_WRAPPER_CONFLICTING_REFUSAL = JSON.stringify({
  type: "upstream_error",
  param: "reasoning_effort",
  message: 'Provider error 400: {"code":"permission_denied","error":"Invalid reasoning effort."}',
});
const UNEXHAUSTED_QUEUE_CANDIDATES_REFUSAL = JSON.stringify({
  param: "reasoning_effort",
  details: [
    ...Array.from({ length: 32 }, (_, i) => ({ id: i, note: "ordinary candidate object" })),
    { code: "permission_denied", message: "Denied after candidate limit" },
  ],
});
const INCOMPLETE_STRUCTURED_WRAPPER_REFUSAL = JSON.stringify({
  param: "reasoning_effort",
  message: 'Provider error 400: {"code":"permission_denied"',
});
const BALANCED_MALFORMED_JSON_REFUSAL =
  'Gateway error 400: {"code":"unknown_terminal_code","message":"Unsupported value for reasoning_effort", invalid_json: }';
const BALANCED_MALFORMED_BRACKET_REFUSAL =
  'Gateway error: ["unknown_terminal_code", "unsupported reasoning effort",]';
const INCOMPLETE_OUTER_OBJECT_REFUSAL = ' {"param":"reasoning_effort","error":{"code":"unknown_terminal_code"}';
const ERRORS_BIO_POLICY_REFUSAL = JSON.stringify({
  param: "reasoning_effort",
  errors: [{ code: "bio_policy" }],
});
const SERIALIZED_ARRAY_BIO_POLICY_REFUSAL = JSON.stringify({
  param: "reasoning_effort",
  errors: ['{"code":"bio_policy"}'],
});
const ERRORS_CONFLICTING_CODE_REFUSAL = JSON.stringify({
  param: "reasoning_effort",
  errors: [{ code: "permission_denied" }],
});
const SERIALIZED_ARRAY_CONFLICTING_CODE_REFUSAL = JSON.stringify({
  param: "reasoning_effort",
  errors: ['{"code":"permission_denied"}'],
});
const ECHOED_REQUEST_PARAM_UNRELATED_REFUSAL = JSON.stringify({
  error: {
    param: "temperature",
    message: "Invalid temperature.",
  },
  request: {
    param: "reasoning_effort",
  },
});
const SERIALIZED_WRAPPER_ECHOED_PARAM_REFUSAL = JSON.stringify({
  error: {
    type: "upstream_error",
    message: `Provider error 400: ${JSON.stringify({
      error: { param: "temperature", message: "Invalid temperature." },
      request: { param: "reasoning_effort" },
    })}`,
  },
});
const DETAIL_REASONING_EFFORT_REFUSAL = JSON.stringify({
  detail: "Unsupported reasoning effort",
});
const DETAIL_ARRAY_REASONING_EFFORT_REFUSAL = JSON.stringify({
  detail: ["Unsupported reasoning effort"],
});
const CONFLICTING_PARAM_UNRELATED_REFUSAL = JSON.stringify({
  param: "reasoning_effort",
  error: {
    param: "temperature",
    message: "Invalid temperature.",
  },
});
const NON_EFFORT_PARAM_WITH_EFFORT_CLAIM_REFUSAL = JSON.stringify({
  error: {
    param: "temperature",
    message: "Invalid temperature.",
  },
  detail: "Unsupported reasoning effort",
});
const DETAILS_STRING_REASONING_EFFORT_REFUSAL = JSON.stringify({
  details: "Unsupported reasoning effort",
});
const LAST_ERROR_STRING_REASONING_EFFORT_REFUSAL = JSON.stringify({
  last_error: "Unsupported reasoning effort",
});
const ECHOED_REQUEST_CONTENT_REFUSAL = JSON.stringify({
  error: {
    param: "reasoning_effort",
    message: "Invalid reasoning effort.",
  },
  request: {
    input: "origin_rejected",
    reason: "testing cybersecurity policy",
  },
});
const PREFIXED_ECHOED_ORIGIN_REJECTED_REFUSAL =
  'Gateway error 400: {"error":{"param":"reasoning_effort","message":"Invalid reasoning effort."},"request":{"input":"origin_rejected"}}';
const PREFIXED_ECHOED_CYBER_POLICY_REFUSAL =
  'Gateway error 400: {"error":{"param":"reasoning_effort","message":"Invalid reasoning effort."},"request":{"input":"Request blocked by upstream cybersecurity policy"}}';
const PREFIXED_ECHOED_BIO_POLICY_REFUSAL =
  'Gateway error 400: {"error":{"param":"reasoning_effort","message":"Invalid reasoning effort."},"request":{"input":"bio_policy violation"}}';
const PREFIXED_POLICY_REFUSAL =
  'Gateway error 400: {"error":{"code":"cyber_policy","param":"reasoning_effort","message":"Request blocked by upstream cybersecurity policy"},"request":{"input":"ordinary text"}}';
const HARD_REFUSAL_PREFIX_ENVELOPE =
  'origin_rejected: {"error":{"param":"reasoning_effort","message":"Invalid reasoning effort."}}';
const NESTED_WRAPPED_ECHO_ORIGIN_REJECTED = JSON.stringify({
  error: {
    type: "upstream_error",
    message: JSON.stringify({
      error: { param: "reasoning_effort", message: "Invalid reasoning effort." },
      request: { input: "origin_rejected" },
    }),
  },
});
const NESTED_WRAPPED_ECHO_ORDINARY = JSON.stringify({
  error: {
    type: "upstream_error",
    message: JSON.stringify({
      error: { param: "reasoning_effort", message: "Invalid reasoning effort." },
      request: { input: "ordinary input prompt" },
    }),
  },
});
const NESTED_WRAPPED_HARD_REFUSAL_PREFIX = JSON.stringify({
  error: {
    type: "upstream_error",
    message: 'origin_rejected: {"error":{"param":"reasoning_effort","message":"Invalid reasoning effort."}}',
  },
});
const CONFLICTING_PERMISSION_PREFIX_REFUSAL =
  'permission_denied: {"error":{"param":"reasoning_effort","message":"Invalid reasoning effort."}}';
const PREFIXED_ECHOED_PERMISSION_DENIED_REFUSAL =
  'Gateway error 400: {"error":{"param":"reasoning_effort","message":"Invalid reasoning effort."},"request":{"input":"permission_denied"}}';
const NESTED_WRAPPED_ECHO_PERMISSION_DENIED = JSON.stringify({
  error: {
    type: "upstream_error",
    message: JSON.stringify({
      error: { param: "reasoning_effort", message: "Invalid reasoning effort." },
      request: { input: "permission_denied" },
    }),
  },
});
const NESTED_WRAPPED_CONFLICTING_PERMISSION_PREFIX = JSON.stringify({
  error: {
    type: "upstream_error",
    message: 'permission_denied: {"error":{"param":"reasoning_effort","message":"Invalid reasoning effort."}}',
  },
});
const VENDOR_EFFORT_REFUSAL = JSON.stringify({ code: "invalid-argument", error: "Invalid reasoning effort." });
const UNRELATED = JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid upload request." } });

let testDir = "";
let releaseSpendHome: (() => void) | undefined;

function writeSnapshot(values: string[]): void {
  writeFileSync(join(testDir, "reasoning-metadata-cache.json"), JSON.stringify({
    version: 1,
    fetchedAt: Date.now(),
    source: "test",
    providers: { "opencode-go": { [MODEL]: { reasoning: true, options: [{ type: "effort", values }] } } },
  }));
}

function config(): OcxConfig {
  return {
    defaultProvider: "first",
    providers: {
      first: {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        authMode: "key",
        apiKey: "test-key",
      },
    },
  } as OcxConfig;
}

/**
 * The Chat config above routes through the generic `recovery:` loop. muse-spark is an
 * `openai-responses` destination in the registry, and that wire takes the separate
 * `passthroughRecovery:` loop, which carries its own copy of the downgrade block. Covering only
 * the Chat config would have left that copy untested while the test name claimed otherwise.
 */
function passthroughConfig(): OcxConfig {
  return {
    defaultProvider: "first",
    providers: {
      first: {
        adapter: "openai-responses",
        baseUrl: "https://opencode.ai/zen/go/v1",
        authMode: "key",
        apiKey: "test-key",
      },
    },
  } as OcxConfig;
}

function effortOf(body: Record<string, unknown> | undefined): unknown {
  if (!body) return undefined;
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && "effort" in reasoning) {
    return (reasoning as { effort?: unknown }).effort;
  }
  return body.reasoning_effort;
}

function request(stream = false, model = "first/" + MODEL): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream,
      store: false,
      reasoning: { effort: "max" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }],
    }),
  });
}

function success(): Response {
  return Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
}

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  testDir = mkdtempSync(join(tmpdir(), "ocx-reasoning-downgrade-"));
  process.env.OPENCODEX_HOME = testDir;
  // Direct handler dispatches need the writer lease that startServer normally holds.
  releaseSpendHome = acquireOwnedSpendHome();
  resetReasoningMetadataCachesForTests();
});

afterEach(() => {
  // Release before home teardown to prevent Windows removal failures and a live unlinked database.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  resetReasoningMetadataCachesForTests();
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  rmSync(testDir, { recursive: true, force: true });
});

describe("rejected reasoning rungs", () => {
  test("clamps a rung the model does not publish before dispatch", async () => {
    writeSnapshot(["minimal", "low", "medium", "high", "xhigh"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);
    await response.text();

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.reasoning_effort).toBe("xhigh");
  });

  test("learns the refusal and replays once at the next published rung", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(outbound[0]?.reasoning_effort).toBe("max");
    expect(outbound[1]?.reasoning_effort).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["reasoning-effort-downgrade"]);
  });

  test("does not replay an unrelated 400", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(UNRELATED, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);
    await response.text();

    expect(outbound).toHaveLength(1);
    expect(response.ok).toBe(false);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
  });
  test("replays once on the streamed generic-recovery path too", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(true), config(), logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(outbound[1]?.reasoning_effort).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["reasoning-effort-downgrade"]);
  });

  test("replays once on the Responses passthrough path", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(true), passthroughConfig(), logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["reasoning-effort-downgrade"]);
  });

  // The guard used to live inside the generic `recovery:` loop, so every `continue recovery`
  // handed the turn a fresh downgrade budget and one request could walk the ladder down.
  test("downgrades at most once even when the replay is refused again", async () => {
    writeSnapshot(["low", "medium", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.ok).toBe(false);
  });

  for (const adapter of ["openai-chat", "openai-responses"] as const) {
    test(`combo tries every lower effort before falling back (${adapter})`, async () => {
      writeSnapshot(["low", "high", "max"]);
      const attempts: Array<{ host: string; effort: unknown }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        attempts.push({ host: url.host, effort: effortOf(body) });
        return url.host === "fallback.example"
          ? chatSuccess("fallback served the turn", MODEL)
          : new Response(VENDOR_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const comboConfig = {
        providers: {
          first: { adapter, baseUrl: "https://opencode.ai/zen/go/v1", authMode: "key", apiKey: "test-key" },
          fallback: { adapter: "openai-chat", baseUrl: "https://fallback.example/v1", authMode: "key", apiKey: "fallback-key" },
        },
        combos: {
          effort: {
            strategy: "failover",
            targets: [{ provider: "first", model: MODEL }, { provider: "fallback", model: MODEL }],
          },
        },
      } as OcxConfig;
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const response = await handleResponses(request(false, "combo/effort"), comboConfig, logCtx);
      const result = await response.text();

      expect(response.status).toBe(200);
      expect(result).toContain("fallback served the turn");
      expect(attempts).toEqual([
        { host: "opencode.ai", effort: "max" },
        { host: "opencode.ai", effort: "high" },
        { host: "opencode.ai", effort: "low" },
        { host: "fallback.example", effort: "max" },
      ]);
    });

    test.each([
      ["serves the turn", true],
      ["also refuses", false],
    ])(`unfunded downgrade keeps the refusal and hops to fallback, which %s (${adapter})`, async (_label, fallbackServes) => {
      // Five ranked rungs need five sends to walk, but the first target's send scope holds one back
      // for the declared fallback, so the fifth rung (low) is unfunded. The combo must keep that
      // target's original 400 -- no send-budget 429 and no cooldown -- and hop to the fallback.
      writeSnapshot(["low", "medium", "high", "xhigh", "max"]);
      const attempts: Array<{ host: string; effort: unknown }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        attempts.push({ host: url.host, effort: effortOf(body) });
        return url.host === "fallback.example" && fallbackServes
          ? chatSuccess("fallback served the turn", MODEL)
          : new Response(VENDOR_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const comboConfig = {
        providers: {
          first: { adapter, baseUrl: "https://opencode.ai/zen/go/v1", authMode: "key", apiKey: "test-key" },
          fallback: { adapter: "openai-chat", baseUrl: "https://fallback.example/v1", authMode: "key", apiKey: "fallback-key" },
        },
        combos: {
          effort: {
            strategy: "failover",
            targets: [{ provider: "first", model: MODEL }, { provider: "fallback", model: MODEL }],
          },
        },
      } as OcxConfig;
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const response = await handleResponses(request(false, "combo/effort"), comboConfig, logCtx);
      const result = await response.text();

      if (fallbackServes) {
        expect(response.status, result).toBe(200);
        expect(result).toContain("fallback served the turn");
      } else {
        expect(response.status, result).toBe(400);
        expect(result).toContain("Invalid reasoning effort.");
        expect(result).not.toContain("request_send_budget_exhausted");
      }
      expect(isComboTargetInCooldown("effort", { provider: "first", model: MODEL })).toBe(false);
      expect(attempts).toEqual([
        { host: "opencode.ai", effort: "max" },
        { host: "opencode.ai", effort: "xhigh" },
        { host: "opencode.ai", effort: "high" },
        { host: "opencode.ai", effort: "medium" },
        { host: "fallback.example", effort: "max" },
      ]);
    });
  }

  test("passthrough retry applies downgraded effort for custom destination outside metadata list", async () => {
    const CUSTOM_MODEL = "custom-external-reasoner";
    const attempts: Array<{ host: string; effort: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      attempts.push({ host: url.host, effort: effortOf(body) });
      return attempts.length === 1
        ? new Response(VENDOR_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : chatSuccess("custom destination served high effort", CUSTOM_MODEL);
    }) as typeof fetch;
    const comboConfig = {
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://custom.example/v1",
          authMode: "key",
          apiKey: "custom-key",
          reasoningEfforts: ["low", "high", "max"],
        },
        fallback: {
          adapter: "openai-chat",
          baseUrl: "https://fallback.example/v1",
          authMode: "key",
          apiKey: "fallback-key",
        },
      },
      combos: {
        custom_effort: {
          strategy: "failover",
          targets: [{ provider: "custom", model: CUSTOM_MODEL }, { provider: "fallback", model: CUSTOM_MODEL }],
        },
      },
    } as OcxConfig;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/custom_effort",
        store: false,
        reasoning: { effort: "max" },
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }],
      }),
    });

    const response = await handleResponses(req, comboConfig, logCtx);
    const result = await response.text();

    expect(response.status).toBe(200);
    expect(result).toContain("custom destination served high effort");
    expect(attempts).toEqual([
      { host: "custom.example", effort: "max" },
      { host: "custom.example", effort: "high" },
    ]);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["reasoning-effort-downgrade"]);
  });

  test("stops before walking effort ladder on policy refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("cyber_policy");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before walking effort ladder on policy refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("cyber_policy");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("combo stops immediately on policy refusal carrying reasoning_effort without walking ladder", async () => {
    writeSnapshot(["low", "high", "max"]);
    const attempts: Array<{ host: string; effort: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      attempts.push({ host: url.host, effort: effortOf(body) });
      return new Response(POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const comboConfig = {
      providers: {
        first: { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", authMode: "key", apiKey: "test-key" },
        fallback: { adapter: "openai-chat", baseUrl: "https://fallback.example/v1", authMode: "key", apiKey: "fallback-key" },
      },
      combos: {
        effort: {
          strategy: "failover",
          targets: [{ provider: "first", model: MODEL }, { provider: "fallback", model: MODEL }],
        },
      },
    } as OcxConfig;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(false, "combo/effort"), comboConfig, logCtx);
    const result = await response.text();

    expect(response.status).toBe(400);
    expect(result).toContain("cyber_policy");
    expect(attempts).toEqual([
      { host: "opencode.ai", effort: "max" },
    ]);
  });

  test("stops before walking effort ladder on nested structured refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(NESTED_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("bio_policy");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before walking effort ladder on nested structured refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(NESTED_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("bio_policy");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("combo stops immediately on nested policy refusal without walking ladder", async () => {
    writeSnapshot(["low", "high", "max"]);
    const attempts: Array<{ host: string; effort: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      attempts.push({ host: url.host, effort: effortOf(body) });
      return new Response(NESTED_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const comboConfig = {
      providers: {
        first: { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", authMode: "key", apiKey: "test-key" },
        fallback: { adapter: "openai-chat", baseUrl: "https://fallback.example/v1", authMode: "key", apiKey: "fallback-key" },
      },
      combos: {
        effort: {
          strategy: "failover",
          targets: [{ provider: "first", model: MODEL }, { provider: "fallback", model: MODEL }],
        },
      },
    } as OcxConfig;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(false, "combo/effort"), comboConfig, logCtx);
    const result = await response.text();

    expect(response.status).toBe(400);
    expect(result).toContain("bio_policy");
    expect(attempts).toEqual([
      { host: "opencode.ai", effort: "max" },
    ]);
  });

  test("stops before walking effort ladder on nested object details refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(OBJECT_DETAILS_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("bio_policy");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before walking effort ladder on nested object details refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(OBJECT_DETAILS_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("bio_policy");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on conflicting root code (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(CONFLICTING_CODE_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("permission_denied");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on conflicting root code (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(CONFLICTING_CODE_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("permission_denied");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("hasConflictingReasoningEffortCode unit checks", () => {
    expect(hasConflictingReasoningEffortCode(SERIALIZED_WRAPPER_CONFLICTING_REFUSAL)).toBe(true);
    expect(hasConflictingReasoningEffortCode(UNEXHAUSTED_QUEUE_CANDIDATES_REFUSAL)).toBe(true);
    expect(hasConflictingReasoningEffortCode(BALANCED_MALFORMED_JSON_REFUSAL)).toBe(true);
    expect(isReasoningEffortRejection(BALANCED_MALFORMED_JSON_REFUSAL)).toBe(false);
    expect(hasConflictingReasoningEffortCode(BALANCED_MALFORMED_BRACKET_REFUSAL)).toBe(true);
    expect(isReasoningEffortRejection(BALANCED_MALFORMED_BRACKET_REFUSAL)).toBe(false);
    expect(hasConflictingReasoningEffortCode(CONFLICTING_PERMISSION_PREFIX_REFUSAL)).toBe(true);
    expect(isReasoningEffortRejection(CONFLICTING_PERMISSION_PREFIX_REFUSAL)).toBe(false);
    expect(hasConflictingReasoningEffortCode(PREFIXED_ECHOED_PERMISSION_DENIED_REFUSAL)).toBe(false);
    expect(isReasoningEffortRejection(PREFIXED_ECHOED_PERMISSION_DENIED_REFUSAL)).toBe(true);
    expect(hasConflictingReasoningEffortCode(NESTED_WRAPPED_CONFLICTING_PERMISSION_PREFIX)).toBe(true);
    expect(isReasoningEffortRejection(NESTED_WRAPPED_CONFLICTING_PERMISSION_PREFIX)).toBe(false);
    expect(hasConflictingReasoningEffortCode(NESTED_WRAPPED_ECHO_PERMISSION_DENIED)).toBe(false);
    expect(isReasoningEffortRejection(NESTED_WRAPPED_ECHO_PERMISSION_DENIED)).toBe(true);
    expect(hasConflictingReasoningEffortCode(VENDOR_EFFORT_REFUSAL)).toBe(false);
    expect(hasConflictingReasoningEffortCode(JSON.stringify({
      param: "reasoning_effort",
      details: [{ id: 1 }, { id: 2 }],
    }))).toBe(false);
  });

  test("stops before effort replay on serialized provider wrapper conflicting code (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(SERIALIZED_WRAPPER_CONFLICTING_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("permission_denied");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on serialized provider wrapper conflicting code (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(SERIALIZED_WRAPPER_CONFLICTING_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("permission_denied");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay when candidate queue leaves unexamined objects (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(UNEXHAUSTED_QUEUE_CANDIDATES_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("reasoning_effort");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay when candidate queue leaves unexamined objects (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(UNEXHAUSTED_QUEUE_CANDIDATES_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("reasoning_effort");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on incomplete structured wrapper (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(INCOMPLETE_STRUCTURED_WRAPPER_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("permission_denied");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on incomplete structured wrapper (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(INCOMPLETE_STRUCTURED_WRAPPER_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("permission_denied");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("replays downgrade when request content echoes origin_rejected or cyber wording (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(ECHOED_REQUEST_CONTENT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }
      return chatSuccess();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("replays downgrade when request content echoes origin_rejected or cyber wording (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(ECHOED_REQUEST_CONTENT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "resp-ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test.each([
    ["origin_rejected", PREFIXED_ECHOED_ORIGIN_REJECTED_REFUSAL],
    ["cyber_policy", PREFIXED_ECHOED_CYBER_POLICY_REFUSAL],
    ["bio_policy", PREFIXED_ECHOED_BIO_POLICY_REFUSAL],
    ["permission_denied", PREFIXED_ECHOED_PERMISSION_DENIED_REFUSAL],
  ])("replays downgrade when prefixed JSON diagnostic echoes %s in request input (openai-chat)", async (_name, payload) => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(payload, { status: 400, headers: { "content-type": "application/json" } });
      }
      return chatSuccess();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test.each([
    ["origin_rejected", PREFIXED_ECHOED_ORIGIN_REJECTED_REFUSAL],
    ["cyber_policy", PREFIXED_ECHOED_CYBER_POLICY_REFUSAL],
    ["bio_policy", PREFIXED_ECHOED_BIO_POLICY_REFUSAL],
    ["permission_denied", PREFIXED_ECHOED_PERMISSION_DENIED_REFUSAL],
  ])("replays downgrade when prefixed JSON diagnostic echoes %s in request input (openai-responses)", async (_name, payload) => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(payload, { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "resp-ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("stops before effort replay on genuine policy refusal inside prefixed diagnostic carrier (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(PREFIXED_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on genuine policy refusal inside prefixed diagnostic carrier (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(PREFIXED_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on outer hard-refusal prefix outside extracted envelope (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(HARD_REFUSAL_PREFIX_ENVELOPE, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on outer hard-refusal prefix outside extracted envelope (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(HARD_REFUSAL_PREFIX_ENVELOPE, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test.each([
    ["openai-chat", config],
    ["openai-responses", passthroughConfig],
  ])("stops before effort replay on conflicting permission diagnostic prefix outside extracted envelope (%s)", async (_name, makeConfig) => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(CONFLICTING_PERMISSION_PREFIX_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = makeConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("replays downgrade when nested upstream_error message echoes origin_rejected in request input (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(NESTED_WRAPPED_ECHO_ORIGIN_REJECTED, { status: 400, headers: { "content-type": "application/json" } });
      }
      return chatSuccess();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("replays downgrade when nested upstream_error message echoes origin_rejected in request input (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(NESTED_WRAPPED_ECHO_ORIGIN_REJECTED, { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "resp-ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("replays downgrade when nested upstream_error message has ordinary request input (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(NESTED_WRAPPED_ECHO_ORDINARY, { status: 400, headers: { "content-type": "application/json" } });
      }
      return chatSuccess();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("replays downgrade when nested upstream_error message has ordinary request input (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(NESTED_WRAPPED_ECHO_ORDINARY, { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "resp-ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("stops before effort replay when nested upstream_error message has hard-refusal prefix (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(NESTED_WRAPPED_HARD_REFUSAL_PREFIX, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay when nested upstream_error message has hard-refusal prefix (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(NESTED_WRAPPED_HARD_REFUSAL_PREFIX, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on incomplete outer object ending with inner brace (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(INCOMPLETE_OUTER_OBJECT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("unknown_terminal_code");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on incomplete outer object ending with inner brace (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(INCOMPLETE_OUTER_OBJECT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("unknown_terminal_code");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on hard policy refusal in errors carrier (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(ERRORS_BIO_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("bio_policy");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on hard policy refusal in errors carrier (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(ERRORS_BIO_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("bio_policy");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on conflicting code in errors carrier (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(ERRORS_CONFLICTING_CODE_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("permission_denied");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on conflicting code in errors carrier (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(ERRORS_CONFLICTING_CODE_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("permission_denied");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on serialized hard policy refusal inside errors array (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(SERIALIZED_ARRAY_BIO_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("bio_policy");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on serialized hard policy refusal inside errors array (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(SERIALIZED_ARRAY_BIO_POLICY_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("bio_policy");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on serialized conflicting code inside errors array (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(SERIALIZED_ARRAY_CONFLICTING_CODE_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("permission_denied");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on serialized conflicting code inside errors array (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(SERIALIZED_ARRAY_CONFLICTING_CODE_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("permission_denied");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on unrelated refusal with echoed request param (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(ECHOED_REQUEST_PARAM_UNRELATED_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("Invalid temperature.");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on unrelated refusal with echoed request param (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(ECHOED_REQUEST_PARAM_UNRELATED_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("Invalid temperature.");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on serialized wrapper containing echoed request param (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(SERIALIZED_WRAPPER_ECHOED_PARAM_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("Invalid temperature.");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on serialized wrapper containing echoed request param (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(SERIALIZED_WRAPPER_ECHOED_PARAM_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("Invalid temperature.");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("recovers and replays lower rung on authoritative detail reasoning effort refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(DETAIL_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("recovers and replays lower rung on authoritative detail reasoning effort refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(DETAIL_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("stops before effort replay on conflicting diagnostic parameters (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(CONFLICTING_PARAM_UNRELATED_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("Invalid temperature.");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on conflicting diagnostic parameters (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(CONFLICTING_PARAM_UNRELATED_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("Invalid temperature.");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("recovers and replays lower rung on authoritative detail array reasoning effort refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(DETAIL_ARRAY_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("recovers and replays lower rung on authoritative detail array reasoning effort refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(DETAIL_ARRAY_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("stops before effort replay on non-effort parameter with effort claim in detail (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(NON_EFFORT_PARAM_WITH_EFFORT_CLAIM_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("Invalid temperature.");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on non-effort parameter with effort claim in detail (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(NON_EFFORT_PARAM_WITH_EFFORT_CLAIM_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("Invalid temperature.");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("recovers and replays lower rung on authoritative details string reasoning effort refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(DETAILS_STRING_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("recovers and replays lower rung on authoritative details string reasoning effort refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(DETAILS_STRING_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("recovers and replays lower rung on authoritative last_error string reasoning effort refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(LAST_ERROR_STRING_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("recovers and replays lower rung on authoritative last_error string reasoning effort refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outbound.length === 1
        ? new Response(LAST_ERROR_STRING_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
        : success();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    await response.text();

    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(response.status).toBe(200);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("stops before effort replay on balanced malformed JSON refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(BALANCED_MALFORMED_JSON_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("unknown_terminal_code");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on balanced malformed JSON refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(BALANCED_MALFORMED_JSON_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("unknown_terminal_code");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("combo stops immediately on balanced malformed JSON refusal without walking ladder", async () => {
    writeSnapshot(["low", "high", "max"]);
    const attempts: Array<{ host: string; effort: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      attempts.push({ host: url.host, effort: effortOf(body) });
      return new Response(BALANCED_MALFORMED_JSON_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const comboConfig = {
      providers: {
        first: { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", authMode: "key", apiKey: "test-key" },
        fallback: { adapter: "openai-chat", baseUrl: "https://fallback.example/v1", authMode: "key", apiKey: "fallback-key" },
      },
      combos: {
        effort: {
          strategy: "failover",
          targets: [{ provider: "first", model: MODEL }, { provider: "fallback", model: MODEL }],
        },
      },
    } as OcxConfig;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(false, "combo/effort"), comboConfig, logCtx);
    const result = await response.text();

    expect(response.status).toBe(400);
    expect(result).toContain("unknown_terminal_code");
    expect(attempts).toEqual([
      { host: "opencode.ai", effort: "max" },
    ]);
  });

  test("stops before effort replay on balanced malformed bracket refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(BALANCED_MALFORMED_BRACKET_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("unknown_terminal_code");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on balanced malformed bracket refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(BALANCED_MALFORMED_BRACKET_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("unknown_terminal_code");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("combo stops immediately on balanced malformed bracket refusal without walking ladder", async () => {
    writeSnapshot(["low", "high", "max"]);
    const attempts: Array<{ host: string; effort: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      attempts.push({ host: url.host, effort: effortOf(body) });
      return new Response(BALANCED_MALFORMED_BRACKET_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const comboConfig = {
      providers: {
        first: { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", authMode: "key", apiKey: "test-key" },
        fallback: { adapter: "openai-chat", baseUrl: "https://fallback.example/v1", authMode: "key", apiKey: "fallback-key" },
      },
      combos: {
        effort: {
          strategy: "failover",
          targets: [{ provider: "first", model: MODEL }, { provider: "fallback", model: MODEL }],
        },
      },
    } as OcxConfig;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(false, "combo/effort"), comboConfig, logCtx);
    const result = await response.text();

    expect(response.status).toBe(400);
    expect(result).toContain("unknown_terminal_code");
    expect(attempts).toEqual([
      { host: "opencode.ai", effort: "max" },
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
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
 * Diagnostic envelope and boundary tests for reasoning effort refusals (#8173).
 *
 * Verifies robust extraction, handling of conflicting codes, incomplete/malformed envelopes,
 * echoed request context, and competing diagnostic prose.
 */

const originalFetch = globalThis.fetch;
const originalOpenCodexHome = process.env.OPENCODEX_HOME;
const MODEL = "muse-spark-1.3-contributor";

const VENDOR_EFFORT_REFUSAL = JSON.stringify({ code: "invalid-argument", error: "Invalid reasoning effort." });
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
const VALID_BRACKET_CONFLICTING_REFUSAL =
  'Gateway error: ["unknown_terminal_code", "unsupported reasoning effort"]';
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
const COMPETING_DIAGNOSTIC_PROSE_REFUSAL = JSON.stringify({
  code: "invalid-argument",
  error: "Invalid reasoning effort.",
  message: "Invalid temperature.",
});

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

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  testDir = mkdtempSync(join(tmpdir(), "ocx-reasoning-diag-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  resetReasoningMetadataCachesForTests();
});

afterEach(() => {
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

describe("reasoning effort diagnostic envelopes and boundaries", () => {
  test("hasConflictingReasoningEffortCode unit checks", () => {
    expect(hasConflictingReasoningEffortCode(SERIALIZED_WRAPPER_CONFLICTING_REFUSAL)).toBe(true);
    expect(hasConflictingReasoningEffortCode(UNEXHAUSTED_QUEUE_CANDIDATES_REFUSAL)).toBe(true);
    expect(hasConflictingReasoningEffortCode(BALANCED_MALFORMED_JSON_REFUSAL)).toBe(true);
    expect(isReasoningEffortRejection(BALANCED_MALFORMED_JSON_REFUSAL)).toBe(false);
    expect(hasConflictingReasoningEffortCode(BALANCED_MALFORMED_BRACKET_REFUSAL)).toBe(true);
    expect(isReasoningEffortRejection(BALANCED_MALFORMED_BRACKET_REFUSAL)).toBe(false);
    expect(hasConflictingReasoningEffortCode(VALID_BRACKET_CONFLICTING_REFUSAL)).toBe(true);
    expect(isReasoningEffortRejection(VALID_BRACKET_CONFLICTING_REFUSAL)).toBe(false);
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
    expect(hasConflictingReasoningEffortCode(COMPETING_DIAGNOSTIC_PROSE_REFUSAL)).toBe(true);
    expect(isReasoningEffortRejection(COMPETING_DIAGNOSTIC_PROSE_REFUSAL)).toBe(false);
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
    expect(text).toContain("permission_denied");
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
      return Response.json({ id: "resp-ok", object: "chat.completion", choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
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
      return Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test.each([
    ["origin_rejected", PREFIXED_ECHOED_ORIGIN_REJECTED_REFUSAL],
    ["cyber_policy", PREFIXED_ECHOED_CYBER_POLICY_REFUSAL],
    ["bio_policy", PREFIXED_ECHOED_BIO_POLICY_REFUSAL],
    ["permission_denied", PREFIXED_ECHOED_PERMISSION_DENIED_REFUSAL],
  ])("replays downgrade when prefixed JSON diagnostic echoes %s in request input (openai-chat)", async (_kind, refusal) => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(refusal, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "chat.completion", choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test.each([
    ["origin_rejected", PREFIXED_ECHOED_ORIGIN_REJECTED_REFUSAL],
    ["cyber_policy", PREFIXED_ECHOED_CYBER_POLICY_REFUSAL],
    ["bio_policy", PREFIXED_ECHOED_BIO_POLICY_REFUSAL],
    ["permission_denied", PREFIXED_ECHOED_PERMISSION_DENIED_REFUSAL],
  ])("replays downgrade when prefixed JSON diagnostic echoes %s in request input (openai-responses)", async (_kind, refusal) => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(refusal, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
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
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("cyber_policy");
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
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("cyber_policy");
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
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("origin_rejected");
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
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("origin_rejected");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("stops before effort replay on conflicting permission diagnostic prefix outside extracted envelope (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(CONFLICTING_PERMISSION_PREFIX_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
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

  test("stops before effort replay on conflicting permission diagnostic prefix outside extracted envelope (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(CONFLICTING_PERMISSION_PREFIX_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
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

  test("replays downgrade when nested upstream_error message echoes origin_rejected in request input (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(NESTED_WRAPPED_ECHO_ORIGIN_REJECTED, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "chat.completion", choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
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
      return Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
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
      return Response.json({ id: "resp-ok", object: "chat.completion", choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
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
      return Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
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
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("origin_rejected");
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
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("origin_rejected");
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
      if (outbound.length === 1) {
        return new Response(DETAIL_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "chat.completion", choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("recovers and replays lower rung on authoritative detail reasoning effort refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(DETAIL_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
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

  test("stops before effort replay on competing diagnostic prose (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(COMPETING_DIAGNOSTIC_PROSE_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
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

  test("stops before effort replay on competing diagnostic prose (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(COMPETING_DIAGNOSTIC_PROSE_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
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
      if (outbound.length === 1) {
        return new Response(DETAIL_ARRAY_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "chat.completion", choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("recovers and replays lower rung on authoritative detail array reasoning effort refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(DETAIL_ARRAY_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
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
      if (outbound.length === 1) {
        return new Response(DETAILS_STRING_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "chat.completion", choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("recovers and replays lower rung on authoritative details string reasoning effort refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(DETAILS_STRING_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("recovers and replays lower rung on authoritative last_error string reasoning effort refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(LAST_ERROR_STRING_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "chat.completion", choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
  });

  test("recovers and replays lower rung on authoritative last_error string reasoning effort refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(LAST_ERROR_STRING_REASONING_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    expect(effortOf(outbound[0])).toBe("max");
    expect(effortOf(outbound[1])).toBe("high");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual(["reasoning-effort-downgrade"]);
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

  test("stops before effort replay on valid bracket with conflicting code refusal (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(VALID_BRACKET_CONFLICTING_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
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

  test("stops before effort replay on valid bracket with conflicting code refusal (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(VALID_BRACKET_CONFLICTING_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
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

  test.each([
    ["JSON", BALANCED_MALFORMED_JSON_REFUSAL, "unknown_terminal_code"],
    ["bracket", BALANCED_MALFORMED_BRACKET_REFUSAL, "unknown_terminal_code"],
    ["valid bracket conflicting", VALID_BRACKET_CONFLICTING_REFUSAL, "unknown_terminal_code"],
    ["competing diagnostic prose", COMPETING_DIAGNOSTIC_PROSE_REFUSAL, "Invalid temperature."],
  ])("combo stops immediately on %s refusal without walking ladder", async (_label, refusal, expectedText) => {
    writeSnapshot(["low", "high", "max"]);
    const attempts: Array<{ host: string; effort: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      attempts.push({ host: url.host, effort: effortOf(body) });
      return new Response(refusal, { status: 400, headers: { "content-type": "application/json" } });
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
    expect(result).toContain(expectedText);
    expect(attempts).toEqual([{ host: "opencode.ai", effort: "max" }]);
  });

  test("combo preserves 413 translation-budget refusal on rebuild without trying fallback", async () => {
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

    const adapterRegistry = await import("../../src/adapters/registry");
    const originalCreate = adapterRegistry.createRegisteredAdapter;
    let buildAttempts = 0;
    const spy = spyOn(adapterRegistry, "createRegisteredAdapter").mockImplementation((wire, provider, ctx) => {
      const adapter = originalCreate(wire, provider, ctx);
      const originalBuild = adapter.buildRequest.bind(adapter);
      adapter.buildRequest = async (parsed, opts) => {
        buildAttempts += 1;
        if (buildAttempts === 2) {
          const { TranslatorBudgetExceededError } = await import("../../src/lib/translator-budget");
          throw new TranslatorBudgetExceededError("live_transient", 1);
        }
        return originalBuild(parsed, opts);
      };
      return adapter;
    });

    try {
      const response = await handleResponses(request(false, "combo/effort"), comboConfig, logCtx);
      expect(response.status).toBe(413);
      const json = await response.json() as Record<string, any>;
      expect(json.error?.code).toBe("context_length_exceeded");
      expect(attempts).toEqual([
        { host: "opencode.ai", effort: "max" },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("direct Chat gives cancellation precedence over rebuild budget error returning 499 rather than 413", async () => {
    writeSnapshot(["low", "high", "max"]);
    const controller = new AbortController();
    let sends = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      sends += 1;
      return new Response(VENDOR_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const cfg = config();
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const adapterRegistry = await import("../../src/adapters/registry");
    const originalCreate = adapterRegistry.createRegisteredAdapter;
    let buildAttempts = 0;
    const spy = spyOn(adapterRegistry, "createRegisteredAdapter").mockImplementation((wire, provider, ctx) => {
      const adapter = originalCreate(wire, provider, ctx);
      const originalBuild = adapter.buildRequest.bind(adapter);
      adapter.buildRequest = async (parsed, opts) => {
        buildAttempts += 1;
        if (buildAttempts === 2) {
          controller.abort();
          const { TranslatorBudgetExceededError } = await import("../../src/lib/translator-budget");
          throw new TranslatorBudgetExceededError("live_transient", 1);
        }
        return originalBuild(parsed, opts);
      };
      return adapter;
    });

    try {
      const response = await handleResponses(request(), cfg, logCtx, {
        abortSignal: controller.signal,
        inboundWire: "chat",
      });
      expect(response.status).toBe(499);
      expect(sends).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("direct Chat returns 413 when rebuild budget error occurs without client cancellation", async () => {
    writeSnapshot(["low", "high", "max"]);
    let sends = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      sends += 1;
      return new Response(VENDOR_EFFORT_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const cfg = config();
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const adapterRegistry = await import("../../src/adapters/registry");
    const originalCreate = adapterRegistry.createRegisteredAdapter;
    let buildAttempts = 0;
    const spy = spyOn(adapterRegistry, "createRegisteredAdapter").mockImplementation((wire, provider, ctx) => {
      const adapter = originalCreate(wire, provider, ctx);
      const originalBuild = adapter.buildRequest.bind(adapter);
      adapter.buildRequest = async (parsed, opts) => {
        buildAttempts += 1;
        if (buildAttempts === 2) {
          const { TranslatorBudgetExceededError } = await import("../../src/lib/translator-budget");
          throw new TranslatorBudgetExceededError("live_transient", 1);
        }
        return originalBuild(parsed, opts);
      };
      return adapter;
    });

    try {
      const response = await handleResponses(request(), cfg, logCtx, {
        inboundWire: "chat",
      });
      expect(response.status).toBe(413);
      expect(sends).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

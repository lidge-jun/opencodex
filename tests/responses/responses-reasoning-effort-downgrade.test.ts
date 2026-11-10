import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import { withRawBodyReasoningEffort } from "../../src/server/responses/core-opaque-recovery";
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
const UNLISTED_PARAM_DIAGNOSTIC_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "custom_field must be a string; reasoning_effort is high.",
  },
});
const MODE_INVALID_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "reasoning effort is unsupported; mode is invalid",
  },
});
const LEVEL_INVALID_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "reasoning effort is unsupported; level is invalid",
  },
});
const SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "Invalid reasoning effort. Max is not supported for this model.",
  },
});
const VENDOR_SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL = JSON.stringify({
  code: "invalid-argument",
  error: "Invalid reasoning effort. Max is not supported for this model.",
});
const EXPLICIT_FIELD_EFFORT_WORD_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "Invalid reasoning effort. The max field is invalid.",
  },
});
const INVALID_FIELD_COLON_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "Invalid reasoning effort. Invalid field: max.",
  },
});
const THE_NONE_FIELD_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "Invalid reasoning effort. The none field is invalid.",
  },
});
const UNQUOTED_PARAM_MAX_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "parameter max cannot be negative; reasoning effort high is unsupported",
  },
});
const ULTRA_EFFORT_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "Reasoning effort ultra is invalid",
  },
});
const THE_ULTRA_FIELD_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "Invalid reasoning effort. The ultra field is invalid.",
  },
});
const INVALID_FIELD_ULTRA_COLON_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "Invalid reasoning effort. Invalid field: ultra.",
  },
});
const REASONING_EFFORT_PARAMETER_IS_UNSUPPORTED_REFUSAL = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "The reasoning effort parameter is unsupported",
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

  test.each(["openai-chat", "openai-responses"] as const)(
    "replays once on requested reasoning effort not supported phrasing (%s)",
    async (adapter) => {
      writeSnapshot(["low", "high", "max"]);
      const requestedEffortRefusal = JSON.stringify({
        error: {
          message: "The requested reasoning effort is not supported for this model",
        },
      });
      const outbound: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return outbound.length === 1
          ? new Response(requestedEffortRefusal, { status: 400, headers: { "content-type": "application/json" } })
          : success();
      }) as typeof fetch;
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const cfg = adapter === "openai-chat" ? config() : passthroughConfig();
      const response = await handleResponses(request(true), cfg, logCtx);
      await response.text();

      expect(outbound).toHaveLength(2);
      expect(effortOf(outbound[0])).toBe("max");
      expect(effortOf(outbound[1])).toBe("high");
      expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["reasoning-effort-downgrade"]);
    },
  );

  test.each(["openai-chat", "openai-responses"] as const)(
    "replays once on translated param effort not supported phrasing (%s)",
    async (adapter) => {
      writeSnapshot(["low", "high", "max"]);
      const paramEffortRefusal = JSON.stringify({
        error: {
          type: "invalid_request_error",
          param: "reasoning_effort",
          message: "reasoning_effort max is not supported for this model",
        },
      });
      const outbound: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return outbound.length === 1
          ? new Response(paramEffortRefusal, { status: 400, headers: { "content-type": "application/json" } })
          : success();
      }) as typeof fetch;
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const cfg = adapter === "openai-chat" ? config() : passthroughConfig();
      const response = await handleResponses(request(true), cfg, logCtx);
      await response.text();

      expect(outbound).toHaveLength(2);
      expect(effortOf(outbound[0])).toBe("max");
      expect(effortOf(outbound[1])).toBe("high");
      expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["reasoning-effort-downgrade"]);
    },
  );

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

  test("classifies unlisted parameter predicate as conflicting diagnostic subject", () => {
    expect(hasConflictingReasoningEffortCode(UNLISTED_PARAM_DIAGNOSTIC_REFUSAL)).toBe(true);
    expect(isReasoningEffortRejection(UNLISTED_PARAM_DIAGNOSTIC_REFUSAL)).toBe(false);
  });

  test("does not replay effort or learn rejection when unlisted field is diagnostic subject (openai-chat)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(UNLISTED_PARAM_DIAGNOSTIC_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = config();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("custom_field must be a string");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test("does not replay effort or learn rejection when unlisted field is diagnostic subject (openai-responses)", async () => {
    writeSnapshot(["low", "high", "max"]);
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(UNLISTED_PARAM_DIAGNOSTIC_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const cfg = passthroughConfig();
    const response = await handleResponses(request(), cfg, logCtx);
    const text = await response.text();

    expect(outbound).toHaveLength(1);
    expect(effortOf(outbound[0])).toBe("max");
    expect(response.status).toBe(400);
    expect(text).toContain("custom_field must be a string");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
  });

  test.each(["openai-chat", "openai-responses"] as const)(
    "combo stops immediately without walking ladder when unlisted field is diagnostic subject (%s)",
    async (adapter) => {
      writeSnapshot(["low", "high", "max"]);
      const attempts: Array<{ host: string; effort: unknown }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        attempts.push({ host: url.host, effort: effortOf(body) });
        return new Response(UNLISTED_PARAM_DIAGNOSTIC_REFUSAL, { status: 400, headers: { "content-type": "application/json" } });
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

      expect(response.status).toBe(400);
      expect(result).toContain("custom_field must be a string");
      expect(attempts).toEqual([
        { host: "opencode.ai", effort: "max" },
      ]);
      expect(isReasoningEffortLearnedUnsupported(comboConfig.providers.first, MODEL, "max")).toBe(false);
    }
  );

  test.each([
    ["mode", MODE_INVALID_REFUSAL],
    ["level", LEVEL_INVALID_REFUSAL],
  ])("classifies explicitly invalid %s as conflicting diagnostic subject", (_field, refusal) => {
    expect(hasConflictingReasoningEffortCode(refusal)).toBe(true);
    expect(isReasoningEffortRejection(refusal)).toBe(false);
  });

  test.each([
    ["openai-chat", "mode", MODE_INVALID_REFUSAL],
    ["openai-chat", "level", LEVEL_INVALID_REFUSAL],
    ["openai-responses", "mode", MODE_INVALID_REFUSAL],
    ["openai-responses", "level", LEVEL_INVALID_REFUSAL],
  ] as const)(
    "stops after one send without effort replay or learned rejection when %s is invalid (%s)",
    async (adapter, field, refusal) => {
      writeSnapshot(["low", "high", "max"]);
      const outbound: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(refusal, { status: 400, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const cfg = adapter === "openai-chat" ? config() : passthroughConfig();
      const response = await handleResponses(request(), cfg, logCtx);
      const text = await response.text();

      expect(outbound).toHaveLength(1);
      expect(effortOf(outbound[0])).toBe("max");
      expect(response.status).toBe(400);
      expect(text).toContain(`${field} is invalid`);
      expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
      expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
    },
  );

  test.each([
    ["openai-chat", "mode", MODE_INVALID_REFUSAL],
    ["openai-chat", "level", LEVEL_INVALID_REFUSAL],
    ["openai-responses", "mode", MODE_INVALID_REFUSAL],
    ["openai-responses", "level", LEVEL_INVALID_REFUSAL],
  ] as const)(
    "combo stops immediately without walking ladder when %s is invalid (%s)",
    async (adapter, field, refusal) => {
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

      expect(response.status).toBe(400);
      expect(result).toContain(`${field} is invalid`);
      expect(attempts).toEqual([
        { host: "opencode.ai", effort: "max" },
      ]);
      expect(isReasoningEffortLearnedUnsupported(comboConfig.providers.first, MODEL, "max")).toBe(false);
    },
  );

  test.each([
    ["standard error envelope", SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL],
    ["vendor string error", VENDOR_SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL],
    ["ultra descriptor", ULTRA_EFFORT_REFUSAL],
    ["reasoning effort parameter is unsupported", REASONING_EFFORT_PARAMETER_IS_UNSUPPORTED_REFUSAL],
  ])("classifies named effort value or descriptor as valid effort rejection (%s)", (_label, refusal) => {
    expect(hasConflictingReasoningEffortCode(refusal)).toBe(false);
    expect(isReasoningEffortRejection(refusal)).toBe(true);
  });

  test.each([
    ["openai-chat", "standard error", SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL],
    ["openai-chat", "vendor error", VENDOR_SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL],
    ["openai-chat", "ultra descriptor", ULTRA_EFFORT_REFUSAL],
    ["openai-chat", "verb following effort parameter", REASONING_EFFORT_PARAMETER_IS_UNSUPPORTED_REFUSAL],
    ["openai-responses", "standard error", SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL],
    ["openai-responses", "vendor error", VENDOR_SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL],
    ["openai-responses", "ultra descriptor", ULTRA_EFFORT_REFUSAL],
    ["openai-responses", "verb following effort parameter", REASONING_EFFORT_PARAMETER_IS_UNSUPPORTED_REFUSAL],
  ] as const)(
    "replays and downgrades from max to high when effort value is in separate sentence, ultra descriptor, or verb follows effort parameter (%s, %s)",
    async (adapter, _kind, refusal) => {
      writeSnapshot(["low", "high", "max"]);
      const attempts: Array<{ host: string; effort: unknown }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        attempts.push({ host: url.host, effort: effortOf(body) });
        return attempts.length === 1
          ? new Response(refusal, { status: 400, headers: { "content-type": "application/json" } })
          : chatSuccess("served at high effort", MODEL);
      }) as typeof fetch;
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const cfg = adapter === "openai-chat" ? config() : passthroughConfig();
      const response = await handleResponses(request(), cfg, logCtx);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain("served at high effort");
      expect(attempts).toEqual([
        { host: "opencode.ai", effort: "max" },
        { host: "opencode.ai", effort: "high" },
      ]);
      expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
    },
  );

  test.each([
    ["openai-chat", "standard error", SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL],
    ["openai-chat", "vendor error", VENDOR_SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL],
    ["openai-chat", "ultra descriptor", ULTRA_EFFORT_REFUSAL],
    ["openai-chat", "verb following effort parameter", REASONING_EFFORT_PARAMETER_IS_UNSUPPORTED_REFUSAL],
    ["openai-responses", "standard error", SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL],
    ["openai-responses", "vendor error", VENDOR_SEPARATE_SENTENCE_EFFORT_VALUE_REFUSAL],
    ["openai-responses", "ultra descriptor", ULTRA_EFFORT_REFUSAL],
    ["openai-responses", "verb following effort parameter", REASONING_EFFORT_PARAMETER_IS_UNSUPPORTED_REFUSAL],
  ] as const)(
    "combo probe downgrades effort and succeeds on lower rung when effort value is in separate sentence (%s, %s)",
    async (adapter, _kind, refusal) => {
      writeSnapshot(["low", "high", "max"]);
      const attempts: Array<{ host: string; effort: unknown }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        attempts.push({ host: url.host, effort: effortOf(body) });
        return attempts.length === 1
          ? new Response(refusal, { status: 400, headers: { "content-type": "application/json" } })
          : chatSuccess("served at high effort", MODEL);
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
      expect(result).toContain("served at high effort");
      expect(attempts).toEqual([
        { host: "opencode.ai", effort: "max" },
        { host: "opencode.ai", effort: "high" },
      ]);
      expect(isReasoningEffortLearnedUnsupported(comboConfig.providers.first, MODEL, "max")).toBe(true);
    },
  );

  test.each([
    ["The max field is invalid", EXPLICIT_FIELD_EFFORT_WORD_REFUSAL],
    ["Invalid field: max", INVALID_FIELD_COLON_REFUSAL],
    ["The none field is invalid", THE_NONE_FIELD_REFUSAL],
    ["parameter max cannot be negative", UNQUOTED_PARAM_MAX_REFUSAL],
    ["The ultra field is invalid", THE_ULTRA_FIELD_REFUSAL],
    ["Invalid field: ultra", INVALID_FIELD_ULTRA_COLON_REFUSAL],
  ])("classifies explicit invalid field (%s) as conflicting diagnostic subject", (_desc, refusal) => {
    expect(hasConflictingReasoningEffortCode(refusal)).toBe(true);
    expect(isReasoningEffortRejection(refusal)).toBe(false);
  });

  test.each([
    ["openai-chat", "The max field is invalid", EXPLICIT_FIELD_EFFORT_WORD_REFUSAL, "max field is invalid"],
    ["openai-chat", "Invalid field: max", INVALID_FIELD_COLON_REFUSAL, "Invalid field: max"],
    ["openai-chat", "The none field is invalid", THE_NONE_FIELD_REFUSAL, "none field is invalid"],
    ["openai-chat", "parameter max cannot be negative", UNQUOTED_PARAM_MAX_REFUSAL, "parameter max cannot be negative"],
    ["openai-chat", "The ultra field is invalid", THE_ULTRA_FIELD_REFUSAL, "ultra field is invalid"],
    ["openai-chat", "Invalid field: ultra", INVALID_FIELD_ULTRA_COLON_REFUSAL, "Invalid field: ultra"],
    ["openai-responses", "The max field is invalid", EXPLICIT_FIELD_EFFORT_WORD_REFUSAL, "max field is invalid"],
    ["openai-responses", "Invalid field: max", INVALID_FIELD_COLON_REFUSAL, "Invalid field: max"],
    ["openai-responses", "The none field is invalid", THE_NONE_FIELD_REFUSAL, "none field is invalid"],
    ["openai-responses", "parameter max cannot be negative", UNQUOTED_PARAM_MAX_REFUSAL, "parameter max cannot be negative"],
    ["openai-responses", "The ultra field is invalid", THE_ULTRA_FIELD_REFUSAL, "ultra field is invalid"],
    ["openai-responses", "Invalid field: ultra", INVALID_FIELD_ULTRA_COLON_REFUSAL, "Invalid field: ultra"],
  ] as const)(
    "stops after one send without effort replay or learned rejection when effort word is an explicit invalid field (%s, %s)",
    async (adapter, _desc, refusal, expectedSubstring) => {
      writeSnapshot(["low", "high", "max"]);
      const outbound: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(refusal, { status: 400, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const cfg = adapter === "openai-chat" ? config() : passthroughConfig();
      const response = await handleResponses(request(), cfg, logCtx);
      const text = await response.text();

      expect(outbound).toHaveLength(1);
      expect(effortOf(outbound[0])).toBe("max");
      expect(response.status).toBe(400);
      expect(text).toContain(expectedSubstring);
      expect(logCtx.activeAttempt?.recoveryKinds ?? []).toEqual([]);
      expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(false);
    },
  );

  test.each([
    ["openai-chat", "The max field is invalid", EXPLICIT_FIELD_EFFORT_WORD_REFUSAL, "max field is invalid"],
    ["openai-chat", "Invalid field: max", INVALID_FIELD_COLON_REFUSAL, "Invalid field: max"],
    ["openai-chat", "The none field is invalid", THE_NONE_FIELD_REFUSAL, "none field is invalid"],
    ["openai-chat", "parameter max cannot be negative", UNQUOTED_PARAM_MAX_REFUSAL, "parameter max cannot be negative"],
    ["openai-chat", "The ultra field is invalid", THE_ULTRA_FIELD_REFUSAL, "ultra field is invalid"],
    ["openai-chat", "Invalid field: ultra", INVALID_FIELD_ULTRA_COLON_REFUSAL, "Invalid field: ultra"],
    ["openai-responses", "The max field is invalid", EXPLICIT_FIELD_EFFORT_WORD_REFUSAL, "max field is invalid"],
    ["openai-responses", "Invalid field: max", INVALID_FIELD_COLON_REFUSAL, "Invalid field: max"],
    ["openai-responses", "The none field is invalid", THE_NONE_FIELD_REFUSAL, "none field is invalid"],
    ["openai-responses", "parameter max cannot be negative", UNQUOTED_PARAM_MAX_REFUSAL, "parameter max cannot be negative"],
    ["openai-responses", "The ultra field is invalid", THE_ULTRA_FIELD_REFUSAL, "ultra field is invalid"],
    ["openai-responses", "Invalid field: ultra", INVALID_FIELD_ULTRA_COLON_REFUSAL, "Invalid field: ultra"],
  ] as const)(
    "combo stops after one send without walking ladder when effort word is an explicit invalid field (%s, %s)",
    async (adapter, _desc, refusal, expectedSubstring) => {
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

      expect(response.status).toBe(400);
      expect(result).toContain(expectedSubstring);
      expect(attempts).toEqual([
        { host: "opencode.ai", effort: "max" },
      ]);
      expect(isReasoningEffortLearnedUnsupported(comboConfig.providers.first, MODEL, "max")).toBe(false);
    },
  );
});

/**
 * Canonical effort refusals from real upstreams (#8173). Each one names reasoning effort through
 * its structured param, its prose, or both, and quotes the refused rung. The classifier used to
 * read the leading diagnostic adjective ("Unsupported parameter") or the quoted rung
 * ("Unsupported value: 'max'") as a competing field, so every one of these was terminal even
 * with a structured `param: reasoning_effort`.
 */
const CANONICAL_EFFORT_REFUSALS = [
  [
    "openai unsupported_value for a max rung",
    JSON.stringify({
      error: {
        message: "Unsupported value: 'max' is not supported with this model. Supported values are: 'low','medium','high'.",
        param: "reasoning_effort",
        code: "unsupported_value",
      },
    }),
  ],
  [
    "openai unsupported_value for an xhigh rung",
    JSON.stringify({
      error: {
        message: "Unsupported value: 'xhigh' is not supported with this model. Supported values are: 'low','medium','high'.",
        param: "reasoning_effort",
        code: "unsupported_value",
      },
    }),
  ],
  [
    "openai unsupported_value for a low rung",
    JSON.stringify({
      error: {
        message: "Unsupported value: 'low' is not supported with this model. Supported values are: 'low','medium','high'.",
        param: "reasoning_effort",
        code: "unsupported_value",
      },
    }),
  ],
  [
    "openai unsupported_value for a minimal rung",
    JSON.stringify({
      error: {
        message: "Unsupported value: 'minimal' is not supported with this model. Supported values are: 'low','medium','high'.",
        param: "reasoning_effort",
        code: "unsupported_value",
      },
    }),
  ],
  [
    "openai unsupported_parameter",
    JSON.stringify({
      error: {
        message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
        param: "reasoning_effort",
        code: "unsupported_parameter",
      },
    }),
  ],
  [
    "anthropic thinking budget",
    JSON.stringify({ error: { message: "thinking budget 32000 is not supported for this model" } }),
  ],
  [
    "vllm enumeration prose",
    "reasoning_effort must be one of ['low','medium','high']",
  ],
  [
    "google numeric status",
    JSON.stringify({ code: 400, error: { message: "reasoning effort max is unsupported" } }),
  ],
  [
    "volcengine ark PascalCase code",
    JSON.stringify({
      error: {
        code: "InvalidParameter",
        message: "The parameter reasoning_effort specified in the request are not valid: max",
      },
    }),
  ],
] as const;

describe("canonical upstream effort refusals", () => {
  test.each(CANONICAL_EFFORT_REFUSALS)("classifies %s as an effort rejection", (_label, refusal) => {
    expect(hasConflictingReasoningEffortCode(refusal)).toBe(false);
    expect(isReasoningEffortRejection(refusal)).toBe(true);
  });

  test.each(CANONICAL_EFFORT_REFUSALS.flatMap(([label, refusal]) => ([
    ["openai-chat", label, refusal] as const,
    ["openai-responses", label, refusal] as const,
  ])))(
    "repairs once from max to high on a direct request (%s, %s)",
    async (adapter, _label, refusal) => {
      writeSnapshot(["low", "medium", "high", "max"]);
      const outbound: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (outbound.length === 1) {
          return new Response(refusal, { status: 400, headers: { "content-type": "application/json" } });
        }
        return adapter === "openai-chat"
          ? chatSuccess("served at high effort", MODEL)
          : Response.json({ id: "resp-ok", object: "response", status: "completed", model: MODEL, output: [] });
      }) as typeof fetch;
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const cfg = adapter === "openai-chat" ? config() : passthroughConfig();
      const response = await handleResponses(request(), cfg, logCtx);
      const text = await response.text();

      expect(response.status).toBe(200);
      if (adapter === "openai-chat") expect(text).toContain("served at high effort");
      expect(outbound).toHaveLength(2);
      expect(effortOf(outbound[0])).toBe("max");
      expect(effortOf(outbound[1])).toBe("high");
      expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["reasoning-effort-downgrade"]);
      expect(isReasoningEffortLearnedUnsupported(cfg.providers.first, MODEL, "max")).toBe(true);
    },
  );

  test.each(CANONICAL_EFFORT_REFUSALS.flatMap(([label, refusal]) => ([
    ["openai-chat", label, refusal] as const,
    ["openai-responses", label, refusal] as const,
  ])))(
    "combo walks max to high on the same target (%s, %s)",
    async (adapter, _label, refusal) => {
      writeSnapshot(["low", "medium", "high", "max"]);
      const attempts: Array<{ host: string; effort: unknown }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        attempts.push({ host: url.host, effort: effortOf(body) });
        return attempts.length === 1
          ? new Response(refusal, { status: 400, headers: { "content-type": "application/json" } })
          : chatSuccess("served at high effort", MODEL);
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
      expect(result).toContain("served at high effort");
      expect(attempts).toEqual([
        { host: "opencode.ai", effort: "max" },
        { host: "opencode.ai", effort: "high" },
      ]);
      expect(isReasoningEffortLearnedUnsupported(comboConfig.providers.first, MODEL, "max")).toBe(true);
    },
  );
});

describe("raw body effort rewrite", () => {
  test("writes reasoning.effort only when the incoming body carried an object reasoning", () => {
    expect(withRawBodyReasoningEffort({ input: [], reasoning: { summary: "auto" } }, "high"))
      .toEqual({ input: [], reasoning: { summary: "auto", effort: "high" } });
  });

  test("keeps a reasoning_effort field in step when the caller sent one", () => {
    expect(withRawBodyReasoningEffort({ input: [], reasoning_effort: "max" }, "high"))
      .toEqual({ input: [], reasoning_effort: "high" });
  });

  test("does not invent a reasoning object when the body carried none", () => {
    expect(withRawBodyReasoningEffort({ input: [], model: "m" }, "high"))
      .toEqual({ input: [], model: "m" });
  });

  test("leaves a string or null reasoning untouched", () => {
    expect(withRawBodyReasoningEffort({ input: [], reasoning: "max" }, "high"))
      .toEqual({ input: [], reasoning: "max" });
    expect(withRawBodyReasoningEffort({ input: [], reasoning: null }, "high"))
      .toEqual({ input: [], reasoning: null });
  });
});

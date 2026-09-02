/**
 * Shadow call intercept source-model matching (issue #311): Codex 0.145.0 moved
 * its hard-coded helper model from gpt-5.4-mini to gpt-5.6-luna. The current
 * default follows modern clients, while sourceModels keeps an escape hatch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, isShadowSourceModel } from "../src/server/responses";
import { shouldInterceptShadowCall } from "../src/lib/shadow-call";
import { handleManagementAPI } from "../src/server/management-api";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("isShadowSourceModel", () => {
  test("matches default shadow source models by prefix", () => {
    expect(isShadowSourceModel("gpt-5.6-luna")).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-luna-2026-08")).toBe(true);
  });

  test("does not match the legacy helper by default but supports an explicit override", () => {
    expect(isShadowSourceModel("gpt-5.4-mini")).toBe(false);
    expect(isShadowSourceModel("gpt-5.4-mini", ["gpt-5.4-mini"])).toBe(true);
  });

  test("does not match non-helper models", () => {
    expect(isShadowSourceModel("gpt-5.6-terra")).toBe(false);
    expect(isShadowSourceModel("gpt-5.5")).toBe(false);
    expect(isShadowSourceModel("gpt-5.6-sol")).toBe(false);
  });

  test("hard-excludes slash-prefixed routed ids, even for configured overrides", () => {
    expect(isShadowSourceModel("openai/gpt-5.6-luna")).toBe(false);
    expect(isShadowSourceModel("openai/gpt-5.6-luna", ["openai/gpt-5.6-luna"])).toBe(false);
  });

  test("configured sourceModels replace the defaults", () => {
    expect(isShadowSourceModel("custom-helper-v2", ["custom-helper"])).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-luna", ["custom-helper"])).toBe(false);
  });

  test("tolerates malformed persisted config without throwing", () => {
    expect(isShadowSourceModel("x-model", [1, "", "x"])).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-luna", [1, ""])).toBe(true); // no valid strings -> defaults
    expect(isShadowSourceModel("gpt-5.6-luna", "not-an-array")).toBe(true); // non-array -> defaults
  });

  test("empty array falls back to defaults", () => {
    expect(isShadowSourceModel("gpt-5.6-luna", [])).toBe(true);
  });
});

describe("shouldInterceptShadowCall", () => {
  test("intercepts every shadow source model unconditionally (#1684)", () => {
    const source = { providerName: "openai", modelId: "gpt-5.6-luna" };
    const target = { providerName: "xai", modelId: "grok-4.5" };
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, source, target)).toBe(true);
    expect(shouldInterceptShadowCall("gpt-5.6-luna-2026-08", undefined, source, target)).toBe(true);
  });

  test("does not intercept non-source models", () => {
    const source = { providerName: "openai", modelId: "gpt-5.6-luna" };
    const target = { providerName: "xai", modelId: "grok-4.5" };
    expect(shouldInterceptShadowCall("gpt-5.6-terra", undefined, source, target)).toBe(false);
    expect(shouldInterceptShadowCall("gpt-5.5", undefined, source, target)).toBe(false);
  });

  test("respects configured sourceModels override", () => {
    const source = { providerName: "openai", modelId: "custom-helper" };
    const target = { providerName: "xai", modelId: "grok-4.5" };
    expect(shouldInterceptShadowCall("custom-helper-v2", ["custom-helper"], source, target)).toBe(true);
    expect(shouldInterceptShadowCall("gpt-5.6-luna", ["custom-helper"], source, target)).toBe(false);
  });

  test("matches source-target intersections by provider and model, not slug alone (#2706)", () => {
    const source = {
      providerName: "openai",
      modelId: "gpt-5.6-luna",
    };
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, source, {
      providerName: "openai",
      modelId: "gpt-5.6-luna",
    })).toBe(false);
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, source, {
      providerName: "xai",
      modelId: "gpt-5.6-luna",
    })).toBe(true);
  });
});

function interceptConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "test-xai-key",
      },
    },
    shadowCallIntercept: { enabled: true, model: "xai/grok-4.5" },
  } as OcxConfig;
}

async function post(
  config: OcxConfig,
  model: string,
  requestKind?: string,
  logCtx: RequestLogContext = { model: "", provider: "" },
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (requestKind) {
    headers["x-codex-turn-metadata"] = JSON.stringify({ request_kind: requestKind });
  }
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: false,
      reasoning: { effort: "high" },
    }),
  }), config, logCtx);
}

describe("shadow call intercept request path (issue #311)", () => {
  test("rewrites a gpt-5.6-luna helper call without overriding configured effort (#2706)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await post(interceptConfig(), "gpt-5.6-luna", "memory");

    expect(bodies.length).toBe(1);
    // Routed through xai openai-chat: upstream model is the decoded routed id, not the helper id
    expect(String(bodies[0]?.model ?? "")).toContain("grok-4.5");
    const effort = (bodies[0]?.reasoning as { effort?: string } | undefined)?.effort
      ?? bodies[0]?.reasoning_effort;
    expect(effort).toBe("high");
  });

  test("a self-target is a no-op instead of an intercept loop (#2706)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as typeof fetch;

    const config = interceptConfig();
    config.shadowCallIntercept = {
      enabled: true,
      model: "xai/custom-helper",
      sourceModels: ["custom-helper"],
    };

    const response = await post(config, "custom-helper", "turn", logCtx);

    expect(response.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.model).toBe("custom-helper");
    expect(logCtx.shadowCallRewrittenFrom).toBeUndefined();
  });

  test("rewrites a gpt-5.6-luna turn request too (#1684)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await post(interceptConfig(), "gpt-5.6-luna", "turn", logCtx);

    expect(bodies.length).toBe(1);
    expect(String(bodies[0]?.model ?? "")).toContain("grok-4.5");
    expect(logCtx.shadowCallRewrittenFrom).toBe("gpt-5.6-luna");
  });

  // The intercept matches by PREFIX, so a caller can append anything and still be intercepted.
  // The recorded marker is persisted to usage.jsonl and served from /api/logs, and the runtime
  // redactor is pattern-based: a credential family it does not recognize would survive verbatim.
  // Recording the operator-configured prefix instead of the caller's raw string removes the
  // class, rather than adding one more pattern to a deny-list.
  test("the recorded marker is the configured prefix, never the caller's raw model string", async () => {
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    // A Google-shaped key: the runtime redactor has no rule for this family, and the newline
    // is stripped before redaction runs, so the old code persisted this string intact.
    const smuggled = "gpt-5.6-luna\nAIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6";
    await post(interceptConfig(), smuggled, "turn", logCtx);

    expect(logCtx.shadowCallRewrittenFrom).toBe("gpt-5.6-luna");
    expect(logCtx.shadowCallRewrittenFrom ?? "").not.toContain("AIza");
  });

  test("a configured non-default prefix is recorded as itself", async () => {
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const config = interceptConfig();
    config.shadowCallIntercept = { enabled: true, model: "grok-4.5", sourceModels: ["gpt-5.4-mini"] };
    await post(config, "gpt-5.4-mini-2024-07-18", "turn", logCtx);

    expect(logCtx.shadowCallRewrittenFrom).toBe("gpt-5.4-mini");
  });

  test("leaves gpt-5.6-terra requests unrewritten", async () => {
    let sawFetch = false;
    globalThis.fetch = (async () => {
      sawFetch = true;
      return new Response(JSON.stringify({ error: { message: "unreachable" } }), { status: 500 });
    }) as typeof fetch;

    const response = await post(interceptConfig(), "gpt-5.6-terra");
    // gpt-5.6-terra is not routable in this minimal config: the request must fail
    // routing (404) BEFORE any upstream fetch — proving no shadow rewrite happened.
    expect(sawFetch).toBe(false);
    expect(response.status).toBe(404);
  });
});

/**
 * The GUI badge/tooltip used to hard-code "5.4-mini", so it kept naming a model
 * Codex no longer sends. The management API is the single source of truth for
 * which models are intercepted; every client renders what it reports.
 */
async function withTempHome<T>(run: () => Promise<T>): Promise<T> {
  const previousHome = process.env.OPENCODEX_HOME;
  const dir = mkdtempSync(join(tmpdir(), "ocx-shadow-"));
  process.env.OPENCODEX_HOME = dir;
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(dir);
  }
}

async function shadowApi(config: OcxConfig, method: string, body?: unknown): Promise<Record<string, unknown>> {
  // Management API enforces a same-origin gate; a browserless caller must look local.
  const headers: Record<string, string> = { origin: "http://127.0.0.1:10100", host: "127.0.0.1:10100" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request("http://localhost/api/shadow-call-settings", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  return await res!.json() as Record<string, unknown>;
}

async function shadowApiResponse(config: OcxConfig, body: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/shadow-call-settings", {
    method: "PUT",
    headers: {
      origin: "http://127.0.0.1:10100",
      host: "127.0.0.1:10100",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  expect(res).not.toBeNull();
  return res!;
}

describe("shadow-call settings API reports the intercepted source models", () => {
  test("GET reports the 0.145.0+ helper-model default", async () => {
    await withTempHome(async () => {
      const body = await shadowApi({ port: 0, defaultProvider: "xai", providers: {} } as OcxConfig, "GET");
      expect(body.sourceModels).toEqual(["gpt-5.6-luna"]);
    });
  });

  test("GET and PUT report a configured override instead of the defaults", async () => {
    await withTempHome(async () => {
      const config = {
        port: 0,
        defaultProvider: "xai",
        providers: {
          xai: {
            adapter: "openai-chat",
            baseUrl: "https://api.x.ai/v1",
            authMode: "key",
            apiKey: "test-xai-key",
          },
        },
        shadowCallIntercept: { enabled: true, model: "xai/grok-4.5", sourceModels: ["gpt-5.6-luna"] },
      } as OcxConfig;
      expect((await shadowApi(config, "GET")).sourceModels).toEqual(["gpt-5.6-luna"]);
      const put = await shadowApi(config, "PUT", { enabled: true });
      expect(put.sourceModels).toEqual(["gpt-5.6-luna"]);
    });
  });

  test("PUT rejects an invalid self-target without persisting it (#2706)", async () => {
    await withTempHome(async () => {
      const config = {
        port: 0,
        defaultProvider: "xai",
        providers: {
          xai: {
            adapter: "openai-chat",
            baseUrl: "https://api.x.ai/v1",
            authMode: "key",
            apiKey: "test-xai-key",
          },
        },
        shadowCallIntercept: { sourceModels: ["custom-helper"] },
      } as OcxConfig;

      const response = await shadowApiResponse(config, { enabled: true, model: "xai/custom-helper" });

      expect(response.status).toBe(400);
      expect(config.shadowCallIntercept).toEqual({ sourceModels: ["custom-helper"] });
    });
  });
});

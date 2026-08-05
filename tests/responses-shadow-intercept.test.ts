/**
 * Shadow call intercept source-model matching (issue #311): Codex 0.145.0 moved
 * its hard-coded helper model from gpt-5.4-mini to gpt-5.6-luna, so the intercept
 * must match a source-model set, not a single literal.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, isShadowSourceModel } from "../src/server/responses";
import { shouldInterceptShadowCall } from "../src/lib/shadow-call";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("isShadowSourceModel", () => {
  test("matches default shadow source models by prefix", () => {
    expect(isShadowSourceModel("gpt-5.4-mini")).toBe(true);
    expect(isShadowSourceModel("gpt-5.4-mini-2026-01")).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-luna")).toBe(true);
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
  const metadata = (requestKind: string) => new Headers({
    "x-codex-turn-metadata": JSON.stringify({ request_kind: requestKind }),
  });

  test("intercepts recognized maintenance kinds but not normal turns", () => {
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, metadata("memory"))).toBe(true);
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, metadata("compaction"))).toBe(true);
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, metadata("prewarm"))).toBe(true);
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, metadata("turn"))).toBe(false);
  });

  test("keeps legacy matching for headerless, malformed, and unrecognized metadata", () => {
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, new Headers())).toBe(true);
    expect(shouldInterceptShadowCall(
      "gpt-5.6-luna",
      undefined,
      new Headers({ "x-codex-turn-metadata": "{" }),
    )).toBe(true);
    expect(shouldInterceptShadowCall(
      "gpt-5.6-luna",
      undefined,
      new Headers({ "x-codex-turn-metadata": "{}" }),
    )).toBe(true);
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, metadata("future-kind"))).toBe(true);
  });

  test("uses case-insensitive Headers lookup and still excludes non-source models", () => {
    const headers = new Headers({
      "X-CoDeX-TuRn-MeTaDaTa": JSON.stringify({ request_kind: "turn" }),
    });
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, headers)).toBe(false);
    expect(shouldInterceptShadowCall("gpt-5.6-terra", undefined, metadata("memory"))).toBe(false);
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

async function post(config: OcxConfig, model: string, requestKind?: string): Promise<Response> {
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
  }), config, { model: "", provider: "" });
}

describe("shadow call intercept request path (issue #311)", () => {
  test("rewrites a gpt-5.6-luna helper call to the configured model with low effort", async () => {
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
    expect(effort).toBe("low");
  });

  test("does not rewrite a foreground gpt-5.6-luna turn", async () => {
    let sawFetch = false;
    globalThis.fetch = (async () => {
      sawFetch = true;
      return new Response(JSON.stringify({ error: { message: "unreachable" } }), { status: 500 });
    }) as typeof fetch;

    const response = await post(interceptConfig(), "gpt-5.6-luna", "turn");

    expect(sawFetch).toBe(false);
    expect(response.status).toBe(404);
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
    rmSync(dir, { recursive: true, force: true });
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

describe("shadow-call settings API reports the intercepted source models", () => {
  test("GET reports the defaults, including the 0.145.0 helper model", async () => {
    await withTempHome(async () => {
      const body = await shadowApi({ port: 0, defaultProvider: "xai", providers: {} } as OcxConfig, "GET");
      expect(body.sourceModels).toEqual(["gpt-5.4-mini", "gpt-5.6-luna"]);
    });
  });

  test("GET and PUT report a configured override instead of the defaults", async () => {
    await withTempHome(async () => {
      const config = {
        port: 0,
        defaultProvider: "xai",
        providers: {},
        shadowCallIntercept: { enabled: true, model: "gpt-5.5", sourceModels: ["gpt-5.6-luna"] },
      } as OcxConfig;
      expect((await shadowApi(config, "GET")).sourceModels).toEqual(["gpt-5.6-luna"]);
      const put = await shadowApi(config, "PUT", { enabled: true });
      expect(put.sourceModels).toEqual(["gpt-5.6-luna"]);
    });
  });
});

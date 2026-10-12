import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest } from "../helpers/management-auth";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";

function chatStream(text: string): Response {
  const chunks = [
    { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
    { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } },
  ];
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function makeConfig(options: { judgeReply?: string; judgeSeen?: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> } = {}): OcxConfig {
  const judge: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://judge.example.test/v1",
    authMode: "key",
    apiKey: "judge-row-key",
    liveModels: false,
    models: ["judge-small"],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      options.judgeSeen?.push({ url: String(input), body, authorization: new Headers(init?.headers).get("authorization") });
      return chatStream(options.judgeReply ?? '{"choice":"probe/decision:high"}');
    }) as typeof fetch,
  };
  return {
    port: 0,
    defaultProvider: "judge",
    providers: {
      jev: {
        adapter: "jev-decision",
        baseUrl: JEV_URL,
        authMode: "key",
        apiKey: "typesafe-key",
        liveModels: false,
        fetch: (async () => Response.json({ answers: { route: { choice: "probe/decision:low" } } })) as typeof fetch,
      },
      "broken-row": { adapter: "jev-decision", baseUrl: "http://127.0.0.1:9/v1/decide", liveModels: false },
      judge,
    },
    combos: {
      auto: { strategy: "jev", targets: [{ provider: "judge", model: "judge-small" }] },
    },
  } as OcxConfig;
}

async function call(config: OcxConfig, method: string, path: string, body?: unknown): Promise<Response> {
  const request = new ManagementRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const response = await handleManagementAPI(request, new URL(request.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  if (!response) throw new Error("route not handled");
  return response;
}

describe("decision-method management routes", () => {
  test("decision-test probes TypeSafe by default and reports the backend", async () => {
    const response = await call(makeConfig(), "POST", "/api/combos/decision-test", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, backend: "typesafe", gate: "apply", effort: "low" });
  });

  test("decision-test runs an opencodex model on its own row credential", async () => {
    const judgeSeen: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const response = await call(makeConfig({ judgeSeen }), "POST", "/api/combos/decision-test", {
      decisionModel: "judge/judge-small",
      decisionTimeoutMs: 5000,
    });
    expect(await response.json()).toMatchObject({ ok: true, backend: "model", gate: "apply", effort: "high" });
    expect(judgeSeen).toHaveLength(1);
    expect(judgeSeen[0]!.authorization).toBe("Bearer judge-row-key");
    expect(JSON.stringify(judgeSeen[0]!.body)).toContain("probe/decision:high");
  });

  test("decision-test reports a non-allowlisted model answer as fail-open", async () => {
    const response = await call(makeConfig({ judgeReply: "probably the big one" }), "POST", "/api/combos/decision-test", {
      decisionModel: "judge/judge-small",
    });
    expect(await response.json()).toMatchObject({ ok: false, backend: "model", gate: "malformed" });
  });

  test("decision-test rejects invalid selections before sending anything", async () => {
    const config = makeConfig();
    for (const body of [
      { decisionProvider: "jev", decisionModel: "judge/judge-small" },
      { decisionProvider: "judge" },
      { decisionModel: "combo/auto" },
      { decisionTimeoutMs: 10 },
    ]) {
      expect((await call(config, "POST", "/api/combos/decision-test", body)).status).toBe(400);
    }
  });

  test("decision-test refuses an unusable System One row by name instead of probing it", async () => {
    const config = makeConfig();
    config.providers.tev = { adapter: "jev-decision", baseUrl: "https://tev.example.test/v1/systemone", liveModels: false, disabled: true, defaultModel: "tev1" };
    config.providers["tev-nomodel"] = { adapter: "jev-decision", baseUrl: "https://tev.example.test/v1/systemone", liveModels: false };
    for (const [decisionProvider, issue] of [["tev", "disabled"], ["tev-nomodel", "model"], ["broken-row", "endpoint"]] as const) {
      const response = await call(config, "POST", "/api/combos/decision-test", { decisionProvider });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ issue });
    }
  });

  test("decision-discovery lists configured rows with their usability", async () => {
    const response = await call(makeConfig(), "GET", "/api/combos/decision-discovery");
    const payload = await response.json() as { configured: Array<Record<string, unknown>>; discovered: unknown[] };
    expect(payload.configured).toContainEqual(expect.objectContaining({ id: "jev", usable: true }));
    expect(payload.configured).toContainEqual(expect.objectContaining({ id: "broken-row", usable: false, issue: "endpoint" }));
    expect(Array.isArray(payload.discovered)).toBeTrue();
  });
});

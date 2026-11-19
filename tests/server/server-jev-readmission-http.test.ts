import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import * as admissionModelScope from "../../src/server/admission-model-scope";
import { readUsageEntries } from "../../src/usage/log";
import { perTurnConfig, resetState, SOL, LUNA } from "../helpers/jev-session-pin";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

beforeEach(resetState);
afterEach(() => { mock.restore(); resetState(); });

const CALLER_KEY = "ocx_data_" + "c".repeat(40);
const WIRES = ["responses", "chat/completions", "messages"] as const;
const UNAVAILABLE = {
  responses: { type: "server_error", code: "combo_unavailable" },
  "chat/completions": { type: "server_error", code: "server_is_overloaded" },
  messages: { type: "api_error", code: "combo_unavailable" },
} as const;
type Scenario = "served" | "consent revoked" | "scope narrowed" | "recheck throws";

// The paid decision is persisted exactly once whatever happens to the send it chose. Spend
// authority changes arrive through the real management routes while the decision is in flight.
test.each(WIRES.flatMap(wire => (["served", "consent revoked", "scope narrowed", "recheck throws"] as const)
  .map(scenario => [wire, scenario] as const)))("%s: %s after the paid decision", async (endpoint, scenario: Scenario) => {
  const home = createTempHome("ocx-jev-readmission-");
  const releaseSpend = acquireOwnedSpendHome();
  const config = perTurnConfig([], []);
  // A keyed listener, so the caller's configured key (and its live scope) is the admission.
  config.hostname = scenario === "scope narrowed" ? "0.0.0.0" : "127.0.0.1";
  config.apiSurfaces = { messages: { enabled: true } };
  const combo = config.combos!.auto!;
  delete combo.sessionPin;
  combo.capabilityPolicy = "union";
  if (scenario === "consent revoked") {
    combo.allowMeteredTargets = true;
    combo.targets = combo.targets.map(target => ({ ...target, metered: true }));
  }
  if (scenario === "scope narrowed") {
    config.apiKeys = [{ id: "caller", name: "caller", key: CALLER_KEY, createdAt: "2026-01-01T00:00:00.000Z",
      allowedModels: ["test-decision", SOL.model, LUNA.model] }];
  }
  let decisions = 0;
  let children = 0;
  let server: ReturnType<typeof startServer> | undefined;
  const manage = async (method: string, path: string, body: unknown) => {
    const token = (await Bun.file(home.path("admin-api-token")).text()).trim();
    const response = await fetch(new URL(path, server!.url), {
      method, headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
  };
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/systemone") {
        decisions++;
        if (scenario === "consent revoked") {
          await manage("PUT", "/api/combos", { id: "auto", combo: { ...combo, allowMeteredTargets: false } });
        }
        if (scenario === "scope narrowed") await manage("PATCH", "/api/keys", { id: "caller", allowedModels: ["test-decision"] });
        return Response.json({ answers: { route: { choice: "sol/gpt-5.6-sol:high", confidence: 0.8 } },
          usage: { input_tokens: 8, output_tokens: 2 } });
      }
      children++;
      const { model, stream } = await request.json() as { model: string; stream?: boolean };
      const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
      if (!stream) {
        return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 0, model,
          choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage });
      }
      const chunk = (choices: unknown[], extra = {}) =>
        "data: " + JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model, choices, ...extra }) + "\n\n";
      return new Response(chunk([{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }])
        + chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) + chunk([], { usage }) + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
    },
  });
  delete config.providers.jev;
  config.providers.decision = { adapter: "jev-decision", baseUrl: new URL("/systemone", upstream.url).href,
    authMode: "key", apiKey: "test-key", defaultModel: "test-decision", liveModels: false, allowPrivateNetwork: true };
  combo.decisionProvider = "decision";
  for (const provider of [config.providers.sol!, config.providers.luna!]) {
    provider.baseUrl = new URL("/v1", upstream.url).href;
    provider.allowPrivateNetwork = true;
  }
  const details = "synthetic internal recheck failure";
  if (scenario === "recheck throws") {
    const resolve = admissionModelScope.resolveAdmissionModelScope;
    spyOn(admissionModelScope, "resolveAdmissionModelScope").mockImplementation((...args) => {
      if (decisions) throw new Error(details);
      return resolve(...args);
    });
  }
  try {
    saveConfig(config);
    server = startServer(0);
    const messages = [{ role: "user", content: "Implement the next step." }];
    const response = await fetch(new URL("/v1/" + endpoint, server.url), {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01",
        ...(scenario === "scope narrowed" ? { authorization: "Bearer " + CALLER_KEY } : {}) },
      body: JSON.stringify({ model: "jev-auto", stream: false,
        ...(endpoint === "responses" ? { input: messages } : { messages, max_tokens: 64 }) }),
    });
    const text = await response.text();
    expect(decisions).toBe(1);
    expect(children).toBe(scenario === "served" ? 1 : 0);
    expect(text).not.toContain(details);
    if (scenario === "served") expect(response.status, text).toBe(200);
    else {
      // No member is left to send to: the JEV ladder's own local refusal, on each wire's contract.
      expect(response.status, text).toBe(503);
      expect(JSON.parse(text).error).toMatchObject(UNAVAILABLE[endpoint]);
    }
    const rows = readUsageEntries().filter(row => row.jevDecision);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jevDecision?.usage).toMatchObject({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
  } finally {
    try { await server?.stop(true); }
    finally {
      await upstream.stop(true);
      try { releaseSpend(); }
      finally { home.remove(); }
    }
  }
});

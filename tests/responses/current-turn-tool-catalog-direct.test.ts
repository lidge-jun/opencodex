import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { saveCredential } from "../../src/oauth/store";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clientWireOf } from "../../src/server/inference/client-wire";
import { messagesDirectRequestOption, planMessagesAntigravityDirect } from "../../src/server/messages-antigravity-direct";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const MODEL = "google-antigravity/gemini-3.8-flash";
const API_BASE = "https://daily-cloudcode-pa.googleapis.com";
const SIGNATURE = "c2ln".repeat(8192);
const config: OcxConfig = {
  port: 0, hostname: "127.0.0.1", defaultProvider: "google-antigravity",
  protocols: { rollout: { antigravityDirect: true } },
  providers: {
    "google-antigravity": {
      adapter: "google", baseUrl: API_BASE, authMode: "oauth", googleMode: "cloud-code-assist",
      project: "fixture-project", models: ["gemini-3.8-flash"], liveModels: false,
    },
  },
};

let home: ReturnType<typeof createTempHome>;
let releaseHome: (() => void) | undefined;
let originalFetch: typeof fetch;
let sent: Array<Record<string, unknown>>;

beforeEach(async () => {
  home = createTempHome("ocx-current-catalog-direct-");
  releaseHome = acquireOwnedSpendHome();
  clearResponseStateForTests();
  clearGenericFailoverHealth();
  sent = [];
  originalFetch = globalThis.fetch;
  saveConfig(config);
  await saveCredential("google-antigravity", {
    access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000,
    accountId: "fixture-account", projectId: "fixture-project", source: "oauth",
  });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== API_BASE || !["/v1internal:streamGenerateContent", "/v1internal:generateContent"].includes(url.pathname)) {
      throw new Error("the direct catalog fixture must not send another upstream request");
    }
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const payload = { response: {
      candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "default.lookup", args: { q: "fixture" } } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 },
    } };
    return url.searchParams.get("alt") === "sse"
      ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json(payload);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  releaseHome?.();
  releaseHome = undefined;
  closeRequestHistoryIndex();
  await flushResponseState();
  clearResponseStateForTests();
  clearGenericFailoverHealth();
  resetProviderRequestPacingForTest();
  home.remove();
});

function messagesBody(): Record<string, unknown> {
  return {
    model: MODEL, max_tokens: 200,
    tools: [{ name: "lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    messages: [
      { role: "user", content: "look up the fixture" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Use the lookup tool.", signature: SIGNATURE },
        { type: "text", text: "Ready." },
      ] },
      { role: "user", content: "continue" },
    ],
  };
}

for (const stream of [false, true]) {
  test(`direct Messages catalog capture preserves signed-history budget and normalizes tool names (${stream ? "SSE" : "JSON"})`, async () => {
    const body = messagesBody();
    // Leave room for normal delivery, but not another full translation on top of the
    // direct decoder's retained reasoning. Measure the real decoder, not its formula.
    const measured = createTestTranslatorBudget();
    expect(planMessagesAntigravityDirect(body, undefined, config, measured)).toBeDefined();
    const decoded = measured.snapshot();
    expect(decoded.currentBytes).toBeGreaterThan(0);
    const maxTurnBytes = decoded.highWaterBytes + Math.floor(decoded.currentBytes / 2);
    measured.dispose();

    const budget = createTestTranslatorBudget({ maxTurnBytes });
    const plan = planMessagesAntigravityDirect(body, undefined, config, budget)!;
    expect(plan).toBeDefined();
    expect(budget.snapshot().currentBytes).toBe(decoded.currentBytes);
    expect(plan.conversation.context.messages.some(message => message.role === "assistant"
      && message.content.some(part => part.type === "thinking" && part.signature === SIGNATURE))).toBe(true);
    const direct = messagesDirectRequestOption(plan, body, undefined, budget);
    const bridge = spyOn(direct, "bridgeConversation");
    const releaseDecode = spyOn(plan, "releaseDecodeCharges");
    try {
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...plan.settingsBody, stream: true }),
      }), config, { model: "", provider: "", surface: "claude" }, {
        inboundWire: "anthropic", translatorBudget: budget, directRequest: direct,
        nativeReasoningReplay: plan.conversation.nativeReasoningReplay,
        clientEncoder: { protocol: "messages", stream, model: MODEL, requestLane: "direct" },
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(clientWireOf(response)).toBe("messages");
      expect(sent).toHaveLength(1);
      // The final route owns signature forwarding; catalog capture keeps the conversation
      // and current declaration without translating the signed history a second time.
      expect(JSON.stringify(sent[0])).toContain("Ready.");
      expect(JSON.stringify(sent[0])).toContain('"name":"lookup"');
      expect(text).toContain('"name":"lookup"');
      expect(text).not.toContain("default.lookup");
      expect(text).not.toContain("translation_buffer_limit");
      expect(text).toContain(stream ? "event: content_block_start" : '"type":"message"');
      expect(bridge).not.toHaveBeenCalled();
      expect(releaseDecode).not.toHaveBeenCalled();
      expect(budget.snapshot().overflows).toBe(0);
    } finally {
      bridge.mockRestore();
      releaseDecode.mockRestore();
    }
  });
}

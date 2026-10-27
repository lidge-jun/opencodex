import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createM365CopilotAdapter, clearM365CopilotConversations } from "../../src/adapters/m365-copilot";
import { M365CopilotTurnError, type M365TurnOptions } from "../../src/adapters/m365-copilot/transport";
import { M365_COPILOT_BASE_URL } from "../../src/providers/m365-copilot-models";
import { createTempHome } from "../helpers/temp-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { clearComboSelectionState } from "../../src/combos/resolve";
import { clearComboTargetCooldowns } from "../../src/combos/failover";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearRequestLogsForTests } from "../../src/server/request-log";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { saveCredential } from "../../src/oauth/store";

const realResolver = { ...(await import("../../src/server/adapter-resolve")) };
let turn: ((options: M365TurnOptions) => Promise<string>) | undefined;
mock.module("../../src/server/adapter-resolve", () => ({
  ...realResolver,
  resolveAdapter(provider: OcxProviderConfig, retention?: "none" | "short" | "long") {
    return provider.adapter === "m365-copilot"
      ? createM365CopilotAdapter(provider, { turn: options => turn!(options) })
      : realResolver.resolveAdapter(provider, retention);
  },
}));
afterAll(() => { mock.module("../../src/server/adapter-resolve", () => realResolver); });
const { handleResponses } = await import("../../src/server/responses");
const token = "header." + Buffer.from(JSON.stringify({ oid: "11111111-1111-1111-1111-111111111111", tid: "22222222-2222-2222-2222-222222222222", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".signature";
let home: ReturnType<typeof createTempHome>, release: () => void;
beforeEach(async () => {
  home = createTempHome("ocx-m365-failover-"); release = acquireOwnedSpendHome();
  clearComboSelectionState(); clearComboTargetCooldowns(); clearComboRecallForTests(); clearM365CopilotConversations(); clearRequestLogsForTests(); clearResponseStateForTests();
  await saveCredential("m365-copilot", { access: token, refresh: "fixture-refresh", expires: Date.now() + 3_600_000, accountId: "11111111-1111-1111-1111-111111111111@22222222-2222-2222-2222-222222222222" });
});
afterEach(async () => {
  await flushResponseState(); clearResponseStateForTests();
  release(); home.remove(); turn = undefined;
  clearComboSelectionState(); clearComboTargetCooldowns(); clearComboRecallForTests(); clearM365CopilotConversations(); clearRequestLogsForTests();
});
const config = (): OcxConfig => ({ defaultProvider: "m365-copilot", providers: {
  "m365-copilot": { adapter: "m365-copilot", baseUrl: M365_COPILOT_BASE_URL, authMode: "oauth", liveModels: false, models: ["Claude_Opus", "Gpt_61_Sol_Reasoning"] },
}, combos: { planners: { strategy: "failover", targets: [{ provider: "m365-copilot", model: "Claude_Opus" }, { provider: "m365-copilot", model: "Gpt_61_Sol_Reasoning" }] } } });

for (const stream of [true, false]) {
  test((stream ? "streaming" : "buffered") + " Copilot quota refusal after empty thinking advances planners to GPT", async () => {
    const hits: string[] = [];
    turn = async options => {
      options.beforeSend?.(); hits.push(options.model);
      if (options.model === "Claude_Opus") {
        options.onThinking?.("");
        throw new M365CopilotTurnError("Microsoft 365 Copilot account quota or rate limit reached", 429);
      }
      options.onText("backup served"); return "backup served";
    };
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/planners", input: "fixture", stream, tools: [{ type: "function", name: "fixture_tool", parameters: { type: "object", properties: {} } }] }),
    }), config(), { model: "", provider: "" });
    const body = await response.text();
    expect(hits).toEqual(["Claude_Opus", "Gpt_61_Sol_Reasoning"]);
    expect(response.status).toBe(200); expect(body).toContain("backup served");
    expect(body).not.toContain("rate_limit_exceeded");
  }, 30_000);
}
test("real Copilot thinking output keeps a subsequent refusal on the committed model", async () => {
  const hits: string[] = [];
  turn = async options => {
    options.beforeSend?.(); hits.push(options.model); options.onThinking?.("visible reasoning");
    throw new M365CopilotTurnError("Microsoft 365 Copilot account quota or rate limit reached", 429);
  };
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/planners", input: "fixture", stream: true }),
  }), config(), { model: "", provider: "" });
  const body = await response.text();
  expect(hits).toEqual(["Claude_Opus"]); expect(body).not.toContain("backup served"); expect(body).toContain("rate_limit_exceeded");
}, 30_000);

test("two Copilot quota refusals advance to the next provider in planners", async () => {
  const hits: string[] = [];
  turn = async options => {
    options.beforeSend?.(); hits.push(options.model); options.onThinking?.("");
    throw new M365CopilotTurnError("Microsoft 365 Copilot account quota or rate limit reached", 429);
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    hits.push("backup-model");
    return Response.json({ choices: [{ message: { role: "assistant", content: "next provider served" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } });
  try {
    const c = config();
    c.providers.backup = { adapter: "openai-chat", baseUrl: "http://127.0.0.1:" + server.port + "/v1", apiKey: "fixture-key", authMode: "key", allowPrivateNetwork: true, liveModels: false };
    c.combos!.planners!.targets.push({ provider: "backup", model: "backup-model" });
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/planners", input: "fixture", stream: false }),
    }), c, { model: "", provider: "" });
    const body = await response.text();
    expect(hits).toEqual(["Claude_Opus", "Gpt_61_Sol_Reasoning", "backup-model"]);
    expect(response.status).toBe(200); expect(body).toContain("next provider served");
  } finally { await server.stop(true); }
}, 30_000);

/**
 * Legacy Chat `functions` history across a reasoning-preserving combo failover.
 *
 * #5844 translates legacy `functions` / `function_call` / `role: "function"` into Responses
 * tools and a paired call/output, and #5843 keeps the Chat reasoning intent through a combo
 * whose first target has an empty effort ladder. Each is pinned on its own; this case pins the
 * union on one request, read off the wire of both loopback upstreams.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { responsesSuccess } from "../helpers/combo-failover-upstream";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type Rec = Record<string, unknown>;

setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

function resetRoutingState(): void {
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chat-legacy-combo-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chat-legacy-combo-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  resetRoutingState();
  clearResponseStateForTests();
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  for (const server of servers.splice(0)) await server.stop(true);
  // Policy routes open the routing-history index under OPENCODEX_HOME; Windows cannot remove
  // the home while that SQLite handle is open (EBUSY).
  closeRequestHistoryIndex();
  await flushResponseState();
  clearResponseStateForTests();
  resetRoutingState();
  resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function upstream(answer: () => Response) {
  const bodies: Rec[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push(await request.json() as Rec);
      return answer();
    },
  });
  servers.push(server);
  return { bodies, baseUrl: new URL("/v1", server.url).href };
}

function provider(baseUrl: string, extra: Partial<OcxProviderConfig>): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl, allowPrivateNetwork: true, authMode: "key", apiKey: "key", ...extra };
}

function responsesStream(text: string): Response {
  return new Response([
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text, item_id: "msg_backup", output_index: 0, content_index: 0 })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: responsesSuccess(text, "m2") })}\n\n`,
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

test("legacy function history keeps its pairing and reasoning intent through combo failover", async () => {
  const a = upstream(() => Response.json({ error: { message: "fixture outage" } }, { status: 503 }));
  const b = upstream(() => responsesStream("sunny"));
  const config: OcxConfig = {
    port: 0,
    defaultProvider: "a",
    providers: {
      a: provider(a.baseUrl, { reasoningEfforts: [] }),
      b: provider(b.baseUrl, { reasoningEfforts: ["low", "high"] }),
    },
    combos: { pair: { strategy: "failover", targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } },
  };

  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "combo/pair",
      stream: false,
      reasoning_effort: "high",
      messages: [
        { role: "user", content: "weather in Seoul?" },
        { role: "assistant", content: null, function_call: { name: "get_weather", arguments: "{\"city\":\"Seoul\"}" } },
        { role: "function", name: "get_weather", content: "{\"temp\":21}" },
      ],
      functions: [{ name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
      function_call: "auto",
    }),
  }), config, { model: "", provider: "" }, { requestId: `legacy-combo-${crypto.randomUUID()}`, start: Date.now() });

  expect(response.status).toBe(200);
  expect(await response.text()).toContain("sunny");
  expect(a.bodies.length).toBeGreaterThan(0);
  for (const body of a.bodies) expect((body.reasoning as Rec | undefined)?.effort).toBeUndefined();

  expect(b.bodies).toHaveLength(1);
  const sent = b.bodies[0]!;
  expect((sent.reasoning as Rec | undefined)?.effort).toBe("high");
  expect(sent.tool_choice).toBe("auto");
  expect(sent.tools).toEqual([expect.objectContaining({ type: "function", name: "get_weather" })]);
  const input = sent.input as Rec[];
  const call = input.find(item => item.type === "function_call");
  const output = input.find(item => item.type === "function_call_output");
  expect(call).toMatchObject({ name: "get_weather", arguments: "{\"city\":\"Seoul\"}" });
  expect(output).toMatchObject({ call_id: call!.call_id, output: "{\"temp\":21}" });
});

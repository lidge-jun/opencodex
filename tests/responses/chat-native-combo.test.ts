/**
 * Native Chat candidates inside a combo (PF-07).
 *
 * With `protocols.rollout.nativeChatCombos` on, a Chat combo's openai-chat candidate is sent on
 * the native Chat lane from the caller's own body, while every other candidate keeps the
 * Chat -> Responses bridge. The cases drive the real Chat ingress against loopback upstreams and
 * read what each upstream received, because the point of the change is the body on the wire and
 * the sends the combo is allowed to make, neither of which an in-process stub can show.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { getRequestLogEntries } from "../../src/server/request-log";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { chatErrorStream, chatStream, responsesSuccess } from "../helpers/combo-failover-upstream";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type Rec = Record<string, unknown>;

// A transient ladder with backoff plus a loopback failover can pass 5s under suite load.
setDefaultTimeout(30_000);

const MESSAGES = [{ role: "user", content: "fixture" }];

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chat-native-combo-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chat-native-combo-"));
  process.env.OPENCODEX_HOME = testDir;
  // Taken after the home is installed so the physical sends own this journal.
  releaseSpendHome = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
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
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

/** A loopback upstream that records every body it receives. */
function upstream(answer: (body: Rec, hit: number) => Response | Promise<Response>) {
  const bodies: Rec[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as Rec;
      bodies.push(body);
      return answer(body, bodies.length);
    },
  });
  servers.push(server);
  return { bodies, baseUrl: new URL("/v1", server.url).href };
}

function provider(adapter: string, baseUrl: string, extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter, baseUrl, allowPrivateNetwork: true, authMode: "key", apiKey: `key-${adapter}`, ...extra };
}

/** A completed Responses stream, which is what the bridge always asks a Responses upstream for. */
function responsesStream(text: string): Response {
  const response = responsesSuccess(text, "m2");
  return new Response([
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text, item_id: "msg_backup", output_index: 0, content_index: 0 })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

/** A Chat completion carrying two choices with logprobs: only the native lane can return it. */
function twoChoiceCompletion(): Response {
  const choice = (index: number) => ({
    index,
    message: { role: "assistant", content: `choice ${index}` },
    logprobs: { content: [{ token: "choice", logprob: -0.1, top_logprobs: [] }] },
    finish_reason: "stop",
  });
  return Response.json({
    id: "chatcmpl-native",
    object: "chat.completion",
    model: "m1",
    choices: [choice(0), choice(1)],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  });
}

function comboConfig(
  providers: Record<string, OcxProviderConfig>,
  targets: Array<{ provider: string; model: string }>,
  protocols?: OcxConfig["protocols"],
): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: { pair: { strategy: "failover", targets } },
    ...(protocols ? { protocols } : {}),
  };
}

const NATIVE_ON: OcxConfig["protocols"] = { rollout: { nativeChatCombos: true } };

async function send(config: OcxConfig, body: Rec) {
  const requestId = `pf07-${crypto.randomUUID()}`;
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/pair", messages: MESSAGES, ...body }),
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
  const text = await response.text();
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  return { response, text, rows };
}

describe("native Chat candidates in a combo", () => {
  test("a native candidate receives the caller's own Chat body, n and logprobs included", async () => {
    const a = upstream(() => twoChoiceCompletion());
    const b = upstream(() => responsesStream("bridge"));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl), b: provider("openai-responses", b.baseUrl) },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      NATIVE_ON,
    );

    const { response, text, rows } = await send(config, { stream: false, n: 2, logprobs: true, top_logprobs: 1 });

    expect(response.status).toBe(200);
    const completion = JSON.parse(text) as { choices: unknown[] };
    // Both choices reach the client: the Responses bridge would have folded them into one.
    expect(completion.choices).toHaveLength(2);
    expect(a.bodies).toHaveLength(1);
    expect(a.bodies[0]).toMatchObject({ model: "m1", messages: MESSAGES, n: 2, logprobs: true, top_logprobs: 1, stream: false });
    expect(b.bodies).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(200);
    expect(rows[0]!.provider).toBe("combo");
    expect(rows[0]!.protocolTrace).toMatchObject({
      inbound: "chat", mode: "native", requestPath: ["chat", "chat"],
      attempts: [{ ordinal: 1, mode: "native", requestPath: ["chat", "chat"] }],
    });
  });

  test("a failed native candidate fails over to the bridge within the shared send budget", async () => {
    // Five sends on its own ladder, but the combo's per-target budget holds one back for the
    // second declared target: the native child may reach its upstream three times, not five.
    const a = upstream(() => Response.json({ error: { message: "fixture outage", type: "server_error" } }, { status: 503 }));
    const b = upstream(() => responsesStream("recovered on the bridge"));
    const config = comboConfig(
      {
        a: provider("openai-chat", a.baseUrl, { transientRetryOn5xx: { attempts: 5 } }),
        b: provider("openai-responses", b.baseUrl),
      },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      NATIVE_ON,
    );

    const { response, text, rows } = await send(config, { stream: false, n: 2 });

    expect(response.status).toBe(200);
    expect(text).toContain("recovered on the bridge");
    expect(a.bodies).toHaveLength(3);
    for (const body of a.bodies) expect(body).toMatchObject({ n: 2, messages: MESSAGES });
    expect(b.bodies).toHaveLength(1);
    // The bridge candidate got a Responses body, built from the source rather than from A's.
    expect(b.bodies[0]).toHaveProperty("input");
    expect(b.bodies[0]).not.toHaveProperty("messages");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts?.map(attempt => attempt.status)).toEqual([503, 200]);
    expect(rows[0]!.protocolTrace).toMatchObject({
      inbound: "chat",
      requestPath: ["chat", "responses"],
      attempts: [
        { ordinal: 1, mode: "native", requestPath: ["chat", "chat"] },
        { ordinal: 2, requestPath: ["chat", "responses"] },
      ],
    });
  });

  test("Chat reasoning intent survives an empty-ladder first target and reaches failover", async () => {
    const a = upstream(() => Response.json({ error: { message: "fixture outage" } }, { status: 503 }));
    const b = upstream(() => responsesStream("reasoned fallback"));
    const config = comboConfig(
      {
        a: provider("openai-responses", a.baseUrl, { reasoningEfforts: [] }),
        b: provider("openai-responses", b.baseUrl, { reasoningEfforts: ["low", "high"] }),
      },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
    );

    const { response, text } = await send(config, { stream: false, reasoning_effort: "high" });

    expect(response.status).toBe(200);
    expect(text).toContain("reasoned fallback");
    expect(a.bodies).toHaveLength(3);
    for (const body of a.bodies) {
      expect((body.reasoning as Rec | undefined)?.effort).toBeUndefined();
    }
    expect(b.bodies).toHaveLength(1);
    expect((b.bodies[0]!.reasoning as Rec | undefined)?.effort).toBe("high");
  });

  test("Chat policy fallback strips only the empty-ladder attempt's reasoning effort", async () => {
    const a = upstream(() => Response.json({ error: { message: "fixture outage" } }, { status: 503 }));
    const b = upstream(() => responsesStream("reasoned policy fallback"));
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "a",
      providers: {
        // Anthropic consumes parsed options rather than the Responses raw-body
        // sanitizer, so this catches an effort that leaks past policy selection.
        a: provider("anthropic", a.baseUrl, { models: ["m1"], reasoningEfforts: [] }),
        b: provider("openai-responses", b.baseUrl, { models: ["m2"], reasoningEfforts: ["low", "high"] }),
      },
      routingProfiles: { daily: { candidates: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } },
    };

    const { response, text, rows } = await send(config, {
      model: "policy/daily", stream: false, reasoning_effort: "high", include_reasoning: true,
    });

    expect(response.status).toBe(200);
    expect(text).toContain("reasoned policy fallback");
    expect(a.bodies.length).toBeGreaterThan(0);
    for (const body of a.bodies) {
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    }
    expect(b.bodies).toHaveLength(1);
    expect(b.bodies[0]!.reasoning).toMatchObject({ effort: "high", summary: "auto" });
    expect(rows[0]!.attempts?.map(attempt => attempt.status)).toEqual([503, 200]);
  });

  test("a streamed native answer that fails after output is not re-sent to the next target", async () => {
    const a = upstream(() => chatErrorStream("fixture broke mid-stream", "partial answer"));
    const b = upstream(() => responsesStream("must not run"));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl), b: provider("openai-responses", b.baseUrl) },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      NATIVE_ON,
    );

    const { response, text } = await send(config, { stream: true });

    expect(response.status).toBe(200);
    expect(text).toContain("partial answer");
    expect(a.bodies).toHaveLength(1);
    expect(b.bodies).toHaveLength(0);
  });

  test("a folded native answer that fails after output stops the combo instead of hopping", async () => {
    // The caller asked for JSON, so the native lane folds the stream before answering. Output
    // already left the upstream, so the failure must end the combo, as it does on the bridge.
    const a = upstream(() => chatErrorStream("fixture broke mid-stream", "partial answer"));
    const b = upstream(() => responsesStream("must not run"));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl), b: provider("openai-responses", b.baseUrl) },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      NATIVE_ON,
    );

    const { response } = await send(config, { stream: false });

    expect(response.status).not.toBe(200);
    expect(a.bodies).toHaveLength(1);
    expect(b.bodies).toHaveLength(0);
  });

  test("with the switch off the same combo keeps the Responses bridge", async () => {
    const a = upstream(body => body.stream === true ? chatStream("bridged") : twoChoiceCompletion());
    const b = upstream(() => responsesStream("unused"));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl), b: provider("openai-responses", b.baseUrl) },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
    );

    const { response, text, rows } = await send(config, { stream: false, n: 2 });

    expect(response.status).toBe(200);
    expect(text).toContain("bridged");
    expect(a.bodies).toHaveLength(1);
    // The bridge always streams internally and cannot carry `n`.
    expect(a.bodies[0]!.stream).toBe(true);
    expect(a.bodies[0]).not.toHaveProperty("n");
    expect(rows[0]!.protocolTrace).toMatchObject({ mode: "legacy-bridge" });
  });
});

describe("unrepresentable candidates under the reject policy", () => {
  const REJECT: OcxConfig["protocols"] = { unrepresentable: "reject", rollout: { nativeChatCombos: true } };

  test("a candidate whose path cannot carry n is skipped with its reason recorded", async () => {
    const a = upstream(() => twoChoiceCompletion());
    const b = upstream(() => responsesStream("must not run"));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl), b: provider("openai-responses", b.baseUrl) },
      // The unrepresentable candidate is declared first, so only the skip can explain A serving.
      [{ provider: "b", model: "m2" }, { provider: "a", model: "m1" }],
      REJECT,
    );

    const { response, text, rows } = await send(config, { stream: false, n: 2 });

    expect(response.status).toBe(200);
    expect((JSON.parse(text) as { choices: unknown[] }).choices).toHaveLength(2);
    expect(b.bodies).toHaveLength(0);
    expect(a.bodies).toHaveLength(1);
    expect(rows[0]!.attempts).toHaveLength(1);
    expect(rows[0]!.protocolTrace).toMatchObject({ mode: "native" });
    expect(rows[0]!.protocolTrace!.reasonCodes).toContain("feature-unrepresentable");
  });

  test("when every candidate is skipped the combo answers the ingress refusal with no send", async () => {
    const b = upstream(() => responsesStream("must not run"));
    const config = comboConfig(
      { b: provider("openai-responses", b.baseUrl) },
      [{ provider: "b", model: "m2" }],
      REJECT,
    );

    const { response, text, rows } = await send(config, { stream: false, n: 2 });

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ error: {
      type: "invalid_request_error",
      code: "unsupported_feature",
      message: "The selected route cannot carry these request features: request.multiple_choices",
    } });
    expect(b.bodies).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(400);
    expect(rows[0]!.protocolTrace).toMatchObject({
      inbound: "chat", mode: "blocked", requestPath: [], reasonCodes: ["feature-unrepresentable"],
    });
  });
});

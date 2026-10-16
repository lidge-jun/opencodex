/**
 * Antigravity direct lane, end to end through the Chat ingress against a fake Cloud Code Assist
 * upstream.
 *
 * With `protocols.rollout.antigravityDirect` on (the default), the same Chat request must reach Antigravity as
 * the same wire body it gets on the bridge, reach the client as the same answer, and be traced as
 * `chat -> ir -> other` both ways. The core receives only the request settings: the conversation is
 * decoded straight from the Chat body.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { saveCredential } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const DAILY_API_BASE = "https://daily-cloudcode-pa.googleapis.com";
const GENERATE_PATHS = ["/v1internal:streamGenerateContent", "/v1internal:generateContent"];

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
let originalFetch: typeof fetch;
let upstreamBodies: string[] = [];

beforeEach(async () => {
  clearGenericFailoverHealth();
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-agy-direct-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-agy-direct-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  upstreamBodies = [];
  await saveCredential("google-antigravity", {
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "antigravity-fixture-account",
    projectId: "fixture-project",
    source: "oauth",
  });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === DAILY_API_BASE && GENERATE_PATHS.includes(url.pathname)) {
      upstreamBodies.push(typeof init?.body === "string" ? init.body : "");
      const payload = {
        response: {
          candidates: [{ content: { role: "model", parts: [{ text: "direct answer" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 },
        },
      };
      return url.searchParams.get("alt") === "sse"
        ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json(payload);
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return originalFetch(input, init);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearGenericFailoverHealth();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function antigravityConfig(direct: boolean): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        adapter: "google",
        baseUrl: DAILY_API_BASE,
        authMode: "oauth",
        googleMode: "cloud-code-assist",
        project: "fixture-project",
        models: ["gemini-3.8-flash"],
      },
    },
    // Explicit both ways: the switch is on by default, so the bridge side has to turn it off.
    protocols: { rollout: { antigravityDirect: direct } },
  } as OcxConfig;
}

function chatBody(stream: boolean): Record<string, unknown> {
  return {
    model: "google-antigravity/gemini-3.8-flash",
    stream,
    temperature: 0.3,
    max_tokens: 200,
    tools: [{ type: "function", function: { name: "lookup", description: "find", parameters: { type: "object", properties: { q: { type: "string" } } } } }],
    messages: [
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "look something up" },
      { role: "assistant", content: "Looking.", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
      { role: "tool", tool_call_id: "call_fixture", content: "found x" },
      { role: "user", content: "and now?" },
    ],
  };
}

async function send(direct: boolean, stream: boolean): Promise<{ status: number; text: string; requestId: string }> {
  const config = antigravityConfig(direct);
  saveConfig(config);
  const requestId = `agy-direct-${direct}-${stream}-${crypto.randomUUID()}`;
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody(stream)),
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
  return { status: response.status, text: await response.text(), requestId };
}

/** The wire body without the per-request random id. */
function wire(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed.requestId;
  return parsed;
}

/** Client answers without their random ids and creation times. */
function answer(text: string, stream: boolean): unknown {
  const scrub = (value: Record<string, unknown>) => ({ ...value, id: "ID", created: 0 });
  if (!stream) return scrub(JSON.parse(text) as Record<string, unknown>);
  return text.split("\n\n").filter(block => block.startsWith("data:")).map(block => {
    const data = block.slice(5).trim();
    return data === "[DONE]" ? data : scrub(JSON.parse(data) as Record<string, unknown>);
  });
}

async function traceFor(requestId: string): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < 100; i++) {
    const row = getRequestLogEntries().find(entry => entry.requestId === requestId);
    if (row?.protocolTrace) return row.protocolTrace as unknown as Record<string, unknown>;
    await Bun.sleep(10);
  }
  return undefined;
}

describe("Antigravity direct lane through the Chat ingress", () => {
  for (const stream of [false, true]) {
    test(`same upstream wire and same answer as the bridge (stream=${stream})`, async () => {
      const bridge = await send(false, stream);
      const direct = await send(true, stream);
      expect(bridge.status).toBe(200);
      expect(direct.status).toBe(200);
      expect(upstreamBodies).toHaveLength(2);
      expect(wire(upstreamBodies[1]!)).toEqual(wire(upstreamBodies[0]!));
      expect(answer(direct.text, stream)).toEqual(answer(bridge.text, stream));
      expect(direct.text).toContain("direct answer");

      expect(await traceFor(bridge.requestId)).toMatchObject({
        mode: "legacy-bridge",
        requestPath: ["chat", "responses-internal", "ir", "other"],
      });
      expect(await traceFor(direct.requestId)).toMatchObject({
        mode: "translated",
        requestPath: ["chat", "ir", "other"],
        responsePath: ["other", "ir", "chat"],
      });
    });
  }

  test("a declined request names the reason and keeps the bridge", async () => {
    // The sidecar is off so the hosted tool is simply dropped on the bridge: the case is about the
    // lane decision, not about running a search.
    const config = { ...antigravityConfig(true), webSearchSidecar: { enabled: false } } as OcxConfig;
    saveConfig(config);
    const requestId = `agy-direct-declined-${crypto.randomUUID()}`;
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...chatBody(false), tools: [{ type: "web_search" }] }),
    }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
    await response.text();
    const trace = await traceFor(requestId);
    expect(trace).toMatchObject({ mode: "legacy-bridge", requestPath: ["chat", "responses-internal", "ir", "other"] });
    expect(trace?.reasonCodes).toContain("hosted-tool");
  });
});

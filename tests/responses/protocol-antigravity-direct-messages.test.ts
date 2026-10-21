/**
 * Antigravity direct lane, end to end through the Messages ingress against a fake Cloud Code
 * Assist upstream.
 *
 * With `protocols.rollout.antigravityDirect` on (the default), the same Messages request (system prompt, tool
 * catalog, signed thinking, a tool call and its result in history) must reach Antigravity as the
 * same wire body it gets on the bridge, reach the client as the same answer, and be traced as
 * `messages -> ir -> other` both ways. The core receives only the request settings: the
 * conversation is decoded straight from the Messages body.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { saveCredential } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { handleClaudeMessages } from "../../src/server/claude-messages";
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
let replyTool: string | undefined;

beforeEach(async () => {
  clearGenericFailoverHealth();
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-agy-direct-msg-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-agy-direct-msg-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  upstreamBodies = [];
  replyTool = undefined;
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
          candidates: [{
            content: {
              role: "model",
              parts: replyTool ? [{ functionCall: { name: replyTool, args: { q: "fixture" } } }] : [
                { text: "weighing it", thought: true, thoughtSignature: "c2lnLWFuc3dlcg==" },
                { text: "direct answer" },
              ],
            },
            finishReason: "STOP",
          }],
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

function antigravityConfig(direct: boolean, extra: Partial<OcxConfig> = {}): OcxConfig {
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
    ...extra,
  } as OcxConfig;
}

function messagesBody(stream: boolean): Record<string, unknown> {
  return {
    model: "google-antigravity/gemini-3.8-flash",
    stream,
    max_tokens: 200,
    temperature: 0.3,
    system: "Answer briefly.",
    thinking: { type: "enabled", budget_tokens: 2048 },
    tools: [{ name: "lookup", description: "find", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    messages: [
      { role: "user", content: "look something up" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "I should look it up.", signature: "c2lnLWhpc3Rvcnk=" },
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "toolu_fixture", name: "lookup", input: { q: "x" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_fixture", content: "found x" },
        { type: "text", text: "and now?" },
      ] },
    ],
  };
}

async function send(config: OcxConfig, body: Record<string, unknown>, tag: string): Promise<{ status: number; text: string; requestId: string }> {
  saveConfig(config);
  const requestId = `agy-direct-msg-${tag}-${crypto.randomUUID()}`;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
  return { status: response.status, text: await response.text(), requestId };
}

/** The wire body without the per-request random id. */
function wire(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed.requestId;
  return parsed;
}

/** Client answers without their random message ids and keepalive pings. */
function answer(text: string, stream: boolean): unknown {
  const scrubbed = text.replace(/msg_[A-Za-z0-9_-]+/g, "msg_ID");
  if (!stream) return JSON.parse(scrubbed);
  return scrubbed.split("\n\n").filter(block => block.trim().length > 0 && !block.includes("event: ping"));
}

async function traceFor(requestId: string): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < 100; i++) {
    const row = getRequestLogEntries().find(entry => entry.requestId === requestId);
    if (row?.protocolTrace) return row.protocolTrace as unknown as Record<string, unknown>;
    await Bun.sleep(10);
  }
  return undefined;
}

describe("Antigravity direct lane through the Messages ingress", () => {
  for (const direct of [false, true]) for (const stream of [false, true]) {
    for (const catalog of ["empty", "omitted", "partial"] as const) {
      test(`tool catalog ${catalog}, direct=${direct}, SSE=${stream}`, async () => {
        replyTool = "Write";
        const body = { ...messagesBody(stream), messages: [{ role: "user", content: "fixture question" }] };
        if (catalog === "empty") body.tools = [];
        if (catalog === "omitted") delete body.tools;
        const result = await send(antigravityConfig(direct), body, `catalog-${catalog}-${direct}-${stream}`);
        expect(upstreamBodies).toHaveLength(1);
        if (catalog === "empty") {
          expect(result.text).toContain("undeclared_tool_call");
          expect(result.text).not.toContain('"type":"tool_use"');
          expect(result.text).not.toContain("message_stop");
        } else {
          expect(result.status, result.text).toBe(200);
          expect(result.text).not.toContain("undeclared_tool_call");
          expect(result.text).toContain('"name":"Write"');
        }
        expect(await traceFor(result.requestId)).toMatchObject({
          mode: direct ? "translated" : "legacy-bridge",
          requestPath: direct ? ["messages", "ir", "other"] : ["messages", "responses-internal", "ir", "other"],
        });
      });
    }
  }
  for (const stream of [false, true]) {
    test(`same upstream wire and same answer as the bridge (stream=${stream})`, async () => {
      const bridge = await send(antigravityConfig(false), messagesBody(stream), `bridge-${stream}`);
      const direct = await send(antigravityConfig(true), messagesBody(stream), `direct-${stream}`);
      expect(bridge.status).toBe(200);
      expect(direct.status).toBe(200);
      expect(upstreamBodies).toHaveLength(2);
      expect(wire(upstreamBodies[1]!)).toEqual(wire(upstreamBodies[0]!));
      expect(answer(direct.text, stream)).toEqual(answer(bridge.text, stream));
      expect(direct.text).toContain("direct answer");

      expect(await traceFor(bridge.requestId)).toMatchObject({
        mode: "legacy-bridge",
        requestPath: ["messages", "responses-internal", "ir", "other"],
      });
      expect(await traceFor(direct.requestId)).toMatchObject({
        mode: "translated",
        requestPath: ["messages", "ir", "other"],
        responsePath: ["other", "ir", "messages"],
      });
    });
  }

  test("a declined request names the reason and keeps the bridge", async () => {
    // The sidecar is off so the hosted tool is simply dropped on the bridge: the case is about the
    // lane decision, not about running a search.
    const config = antigravityConfig(true, { webSearchSidecar: { enabled: false } } as Partial<OcxConfig>);
    const body = { ...messagesBody(false), tools: [{ type: "web_search_20250305", name: "web_search" }] };
    const declined = await send(config, body, "declined");
    expect(declined.status).toBe(200);
    const trace = await traceFor(declined.requestId);
    expect(trace).toMatchObject({ mode: "legacy-bridge", requestPath: ["messages", "responses-internal", "ir", "other"] });
    expect(trace?.reasonCodes).toContain("hosted-tool");
  });

  test("a refusal is the bridge's refusal", async () => {
    const body = { ...messagesBody(false), messages: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_x" }] }] };
    const bridge = await send(antigravityConfig(false), body, "refused-bridge");
    const direct = await send(antigravityConfig(true), body, "refused-direct");
    expect(direct.status).toBe(400);
    expect(direct.status).toBe(bridge.status);
    expect(direct.text).toBe(bridge.text);
    expect(upstreamBodies).toHaveLength(0);
  });
});


import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { comboProviderFactory } from "../helpers/combo-provider";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { addFinalRequestLog, clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import {
  clearResponseStateForTests,
  flushResponseState,
  responseStatePersistPendingForTests,
} from "../../src/responses/state";
import type { OcxConfig } from "../../src/types";
import { item as hostedImage } from "../fixtures/hosted-image-display";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { deliverPassthroughResponse } from "../../src/server/responses/passthrough-delivery";

/**
 * #7456: a Responses combo child that answers a `tool_choice`-required request with a buffered
 * `status: "completed"` body carrying zero call items is a false success. The combo used to
 * accept any 200 before commit, so the client received `completed` with nothing to execute and
 * its agent loop ended silently — the hop machinery was only reachable from a non-OK response.
 *
 * The scope is exactly the safe half of the issue's acceptance criteria: buffered non-streaming
 * successful children, requests that explicitly require a tool, judged before any commit.
 * Streaming children keep their conservative preflight rules; the last tests here pin that no
 * judgment reaches past them.
 */

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const provider = comboProviderFactory(() => undefined);
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-required-tool-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-required-tool-"));
  process.env.OPENCODEX_HOME = testDir;
  // Direct handler dispatches need the writer lease that startServer normally holds.
  releaseSpendHome = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  clearRequestLogsForTests();
  clearResponseStateForTests();
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  let responseStatePending = true;
  try {
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    responseStatePending = responseStatePersistPendingForTests();
  } finally {
    clearResponseStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    clearCodexUpstreamHealth();
    clearRequestLogsForTests();
  }
  expect(responseStatePending).toBe(false);
});

/** Loopback upstream whose lifetime the afterEach owns. */
function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}

function comboConfig(providers: OcxConfig["providers"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: {
      free: {
        strategy: "failover",
        targets: Object.keys(providers).map((name, index) => ({ provider: name, model: `m${index + 1}` })),
      },
    },
  };
}

/** A completed buffered Responses body whose output is only a text message. */
function completedNoCall(model: string, text: string): Record<string, unknown> {
  return {
    id: `resp-${model}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_a",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

/** A completed buffered Responses body whose only output item is a tool call. */
function completedWithCall(
  model: string,
  name: string,
  itemType: "function_call" | "custom_tool_call" = "function_call",
): Record<string, unknown> {
  return {
    id: `resp-call-${model}`,
    object: "response",
    status: "completed",
    model,
    output: [{ id: `call_${model}`, type: itemType, name, call_id: `call_${model}`, arguments: "{}" }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

/** A completed buffered Responses body whose only output item is a hosted-tool call. */
function completedWithHostedCall(model: string, itemType: string): Record<string, unknown> {
  return {
    id: `resp-hosted-${model}`,
    object: "response",
    status: "completed",
    model,
    output: [{ id: `hs_${model}`, type: itemType, status: "completed" }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

const tools = [{ type: "function", name: "shell", parameters: { type: "object" } }];

function requiredRequest(extra: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, tools, ...extra }),
  });
}

describe("combo required-tool contract on buffered children (#7456)", () => {
  test("a folded-SSE contract failure settles reported usage without completion effects", async () => {
    let effects = 0;
    let settled: unknown;
    const context: RequestLogContext = { provider: "fixture", model: "m1", spendTracker: { settle(usage) { settled = usage; } } };
    const request = requiredRequest({ tools: [...tools, { type: "image_generation" }], tool_choice: { type: "function", name: "shell" } });
    const result = await deliverCanonicalBufferedImage(request, hostedImage, () => { effects++; }, context);
    expect(result.status).toBe(400);
    addFinalRequestLog("folded-required-tool", Date.now(), context, result.status, undefined, () => {});
    expect(settled).toMatchObject({ inputTokens: 7, outputTokens: 2 });
    expect(effects).toBe(0);
  });
  test("buffered image display validation precedes completion effects", async () => {
    let effects = 0;
    const request = requiredRequest({ tools: [{ type: "image_generation" }], tool_choice: "required" });
    request.headers.set("originator", "Codex Desktop");
    const result = await deliverCanonicalBufferedImage(request, {
      ...hostedImage, internal_chat_message_metadata_passthrough: { value: "x".repeat(256 * 1024) },
    }, () => { effects++; });
    expect(result.status).toBe(502);
    expect(effects).toBe(0);
  });
  for (const format of ["json", "sse"]) for (const named of [false, true]) {
    test(`local Codex image display preserves required-tool evidence (${format}, named=${named})`, async () => {
      let sends = 0;
      const upstream = serve(() => {
        sends++;
        const payload = { id: "resp_image_required", object: "response", status: "completed", model: "m1", output: [hostedImage] };
        return format === "json" ? Response.json(payload) : new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const config = comboConfig({ a: provider("openai-responses", baseUrl(upstream), "key-a") });
      const request = new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json", originator: "Codex Desktop" },
        body: JSON.stringify({ model: "combo/free", input: "synthetic image", stream: false,
          tools: [...tools, { type: "image_generation" }],
          tool_choice: named ? { type: "function", name: "shell" } : "required" }),
      });
      const response = format === "sse" ? await deliverCanonicalBufferedImage(request) : await handleResponses(request, config, { model: "", provider: "" }, {
        admission: { kind: "loopback", source: "loopback" }, inboundWire: "responses",
      });
      expect(sends).toBe(format === "sse" ? 0 : 1);
      expect(response.status).toBe(named ? 400 : 200);
      const body = await response.text();
      if (named) {
        expect(body).toContain("required_tool_contract_unsatisfied");
        expect(response.headers.get("x-should-retry")).toBe("false");
      } else {
        expect(body).toContain("Generated image");
        expect(body).not.toContain("image_generation_call");
      }
    });
  }

  test("buffered completed with zero call items hops when tool_choice requires a tool", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedNoCall("m1", "false success text"));
    });
    const b = serve(() => {
      hits.push("b");
      return Response.json(completedWithCall("m2", "shell"));
    });
    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    }), requiredRequest({ tool_choice: "required" }), parent);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("call_m2");
    expect(body).not.toContain("false success text");
    expect(hits).toEqual(["a", "b"]);
    expect(parent).toMatchObject({
      provider: "combo",
      model: "combo/free",
      resolvedModel: "m2",
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", status: 502 },
        { ordinal: 2, provider: "b", model: "m2" },
      ],
    });
  });

  test("a named tool_choice violation hops; a matching call is accepted", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedWithCall("m1", "web"));
    });
    const b = serve(() => {
      hits.push("b");
      return Response.json(completedWithCall("m2", "shell"));
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    }), requiredRequest({
      tool_choice: { type: "function", name: "shell" },
      // Declare BOTH tools: with `web` undeclared the existing undeclared-tool guard would be
      // what hops, and the named-choice arm of the contract would go untested.
      tools: [
        { type: "function", name: "shell", parameters: { type: "object" } },
        { type: "function", name: "web", parameters: { type: "object" } },
      ],
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("call_m2");
    expect(hits).toEqual(["a", "b"]);
  });

  test("a satisfied required contract is accepted on the first target", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedWithCall("m1", "shell"));
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(a), "key-b"),
    }), requiredRequest({ tool_choice: "required" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("call_m1");
    expect(hits).toEqual(["a"]);
  });

  test("a custom_tool_call item satisfies a required contract", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedWithCall("m1", "apply_patch", "custom_tool_call"));
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(a), "key-b"),
    }), requiredRequest({
      tool_choice: "required",
      // The undeclared-tool guard must not be what answers here: declare the custom tool the
      // fixture calls, so only the required-tool contract is under test.
      tools: [{ type: "custom", name: "apply_patch" }],
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("call_m1");
    expect(hits).toEqual(["a"]);
  });

  test("a hosted-tool call satisfies a required contract when the hosted tool is declared", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedWithHostedCall("m1", "web_search_call"));
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(a), "key-b"),
    }), requiredRequest({
      tool_choice: "required",
      // The combo forwards hosted-tool declarations to children verbatim, so a child that
      // honors `required` with a hosted call is a legitimate success, not a violation.
      tools: [{ type: "web_search" }],
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("web_search_call");
    expect(hits).toEqual(["a"]);
  });

  test("a hosted-tool call cannot satisfy a named function-tool demand", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedWithHostedCall("m1", "web_search_call"));
    });
    const b = serve(() => {
      hits.push("b");
      return Response.json(completedWithCall("m2", "shell"));
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    }), requiredRequest({
      tool_choice: { type: "function", name: "shell" },
      tools: [
        { type: "function", name: "shell", parameters: { type: "object" } },
        { type: "web_search" },
      ],
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("required_tool_contract_unsatisfied");
    expect(hits).toEqual(["a"]); // The hosted call may already have executed.
  });

  test("a hosted call for a hosted tool the request never declared still violates", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedWithHostedCall("m1", "web_search_call"));
    });
    const b = serve(() => {
      hits.push("b");
      return Response.json(completedWithCall("m2", "shell"));
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    }), requiredRequest({
      // Function-only catalog: with the default `shell` tools there is no hosted capability
      // this child was allowed to execute, so its web_search_call satisfies nothing — were
      // hosted items trusted unconditionally, every target could skip its real job this way.
      tool_choice: "required",
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("required_tool_contract_unsatisfied");
    expect(hits).toEqual(["a"]); // Undeclared hosted effects cannot authorize replay either.
  });

  test("a declared hosted capability does not whitelist a different hosted capability", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedWithHostedCall("m1", "file_search_call"));
    });
    const b = serve(() => {
      hits.push("b");
      return Response.json(completedWithCall("m2", "shell"));
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    }), requiredRequest({
      tool_choice: "required",
      // Declare shell too, so the accepting target's call is not what the undeclared-tool
      // guard would answer here — only the hosted-capability mismatch is under test.
      tools: [
        { type: "web_search" },
        { type: "function", name: "shell", parameters: { type: "object" } },
      ],
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("required_tool_contract_unsatisfied");
    expect(hits).toEqual(["a"]);
  });

  test("an alias declaration covers its capability", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedWithHostedCall("m1", "web_search_call"));
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(a), "key-b"),
    }), requiredRequest({
      tool_choice: "required",
      // hosted-tool-policy folds web_search_preview onto the same capability as web_search.
      tools: [{ type: "web_search_preview" }],
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("web_search_call");
    expect(hits).toEqual(["a"]);
  });

  test("no tool_choice means the contract is never judged", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedNoCall("m1", "ordinary answer"));
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(a), "key-b"),
    }), requiredRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ordinary answer");
    expect(hits).toEqual(["a"]);
  });

  test("every target violating returns the typed compatibility error, not a false completed", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json(completedNoCall("m1", "first false success"));
    });
    const b = serve(() => {
      hits.push("b");
      return Response.json(completedNoCall("m2", "second false success"));
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    }), requiredRequest({ tool_choice: "required" }));
    expect(hits).toEqual(["a", "b"]);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("required_tool_contract_unsatisfied");
    expect(body).not.toContain("first false success");
    expect(body).not.toContain("second false success");
  });

  test("an incomplete buffered child stays delivered even with a required contract", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return Response.json({
        ...completedNoCall("m1", "ran out of budget"),
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      });
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(a), "key-b"),
    }), requiredRequest({ tool_choice: "required" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ran out of budget");
    expect(hits).toEqual(["a"]);
  });

  test("a streaming completed stream without call items is never re-judged", async () => {
    const hits: string[] = [];
    const sse = (events: unknown[]) => new Response(
      events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
    const a = serve(() => {
      hits.push("a");
      return sse([
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        { type: "response.output_text.delta", delta: "streamed text" },
        { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
      ]);
    });
    const response = await handleResponsesWith(comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(a), "key-b"),
    }), requiredRequest({ stream: true, tool_choice: "required" }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("response.completed");
    expect(body).toContain("streamed text");
    expect(hits).toEqual(["a"]);
  });

  test("151-tool fallback preserves upstream choice, catalog, call ID, usage and result continuation", async () => {
    const catalog = Array.from({ length: 151 }, (_, i) => ({
      type: "function", name: `marker_${i}`, parameters: { type: "object", properties: {} },
    }));
    const sent: Array<{ target: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const upstream = (target: string) => serve(async request => {
      const body = await request.json() as Record<string, unknown>;
      sent.push({ target, body, authorization: request.headers.get("authorization") });
      if (body.tool_choice === "auto") {
        expect(body.input).toContainEqual({ type: "function_call_output", call_id: "call_m2", output: "synthetic result" });
        return Response.json(completedNoCall(String(body.model), "synthetic result received"));
      }
      return Response.json(target === "a" ? completedNoCall("m1", "false success") : completedWithCall("m2", "marker_150"));
    });
    const a = upstream("a"), b = upstream("b");
    const config = comboConfig({ a: provider("openai-responses", baseUrl(a), "key-a"), b: provider("openai-responses", baseUrl(b), "key-b") });
    const parent: RequestLogContext = { model: "", provider: "" };
    const first = await handleResponsesWith(config, requiredRequest({ tools: catalog, tool_choice: "required", store: false }), parent);
    const firstBody = await first.json() as { output: Array<Record<string, unknown>> };
    expect(first.status).toBe(200);
    expect(firstBody.output).toHaveLength(1);
    expect(firstBody.output[0]).toMatchObject({ type: "function_call", name: "marker_150", call_id: "call_m2" });
    expect(sent.map(x => x.target)).toEqual(["a", "b"]);
    for (const request of sent) {
      expect(request.body.tools).toEqual(catalog);
      expect(request.body.tool_choice).toBe("required");
      expect(request.authorization).toBe(`Bearer key-${request.target}`);
    }
    expect(parent.model).toBe("combo/free");
    expect(parent.resolvedModel).toBe("m2");
    expect(parent.attempts?.[0]?.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 });
    const second = await handleResponsesWith(config, requiredRequest({
      tools: catalog, tool_choice: "auto", store: false,
      input: [{ role: "user", content: "Use a marker" }, firstBody.output[0],
        { type: "function_call_output", call_id: "call_m2", output: "synthetic result" }],
    }));
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("synthetic result received");
    expect(sent).toHaveLength(3);
    expect(sent[2]!.body.tools).toEqual(catalog);
  });

  test("a retrying client cannot repeat a hosted-effect violation", async () => {
    let sends = 0;
    const a = serve(() => { sends++; return Response.json(completedWithHostedCall("m1", "web_search_call")); });
    const config = comboConfig({ a: provider("openai-responses", baseUrl(a), "key-a") });
    let result!: Response;
    // Stainless clients honor x-should-retry before their 408/409/429/5xx status table;
    // Codex's configured policy retries 5xx and does not retry ordinary 400s.
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await handleResponsesWith(config, requiredRequest({ tool_choice: { type: "function", name: "shell" } }));
      if (result.headers.get("x-should-retry") === "false"
        || !([408, 409, 429].includes(result.status) || result.status >= 500)) break;
      await result.text();
    }
    expect(sends).toBe(1);
    expect(result.status).toBe(400);
    expect(result.headers.get("x-should-retry")).toBe("false");
    expect(result.headers.get("retry-after")).toBeNull();
    expect(await result.json()).toMatchObject({ error: { code: "required_tool_contract_unsatisfied" } });
  });
});

const { handleResponses } = await import("../../src/server/responses");

// The canonical forward lane buffers SSE for JSON clients; noncanonical SSE stays streaming.
async function deliverCanonicalBufferedImage(request: Request, image: Record<string, unknown> = hostedImage, observed = () => {}, logCtx: RequestLogContext = { model: "", provider: "" }): Promise<Response> {
  const rawBody = await request.json();
  const payload = { id: "resp_image_required", object: "response", status: "completed", model: "m1", output: [image],
    usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } };
  const upstream = new AbortController();
  return deliverPassthroughResponse(
    { req: request, config: { providers: {} }, logCtx, options: { comboAttempt: true,
      admission: { kind: "loopback", source: "loopback" }, inboundWire: "responses" } } as Parameters<typeof deliverPassthroughResponse>[0],
    { authCtx: { kind: "none" } } as Parameters<typeof deliverPassthroughResponse>[1],
    { parsed: { stream: true, modelId: "m1", _rawBody: rawBody }, clientRequestedStream: false,
      translatorBudget: createTestTranslatorBudget(), route: { provider: { adapter: "openai-responses", authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex" }, providerName: "fixture", modelId: "m1", staticPolicy: { model: {} } } } as Parameters<typeof deliverPassthroughResponse>[2],
    { requestBindings: new Map() } as Parameters<typeof deliverPassthroughResponse>[3], {} as Parameters<typeof deliverPassthroughResponse>[4],
    { plaintextV2AgentMessageToolNames: new Set(), plaintextV2AgentMessageAliasedToolNames: new Set(),
      routedMuseToolNameAliases: new Map(), routedNamespaceToolAliases: new Map(),
      commitReasoningReplayServingRoute() {}, recordTerminalOutcomes: false } as Parameters<typeof deliverPassthroughResponse>[5],
    { upstreamResponse: new Response(`data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } }), upstream, request, connectMs: 0,
      imageGenCallAliases: new Map(), selfNamedNamespaceScrubAuthorization: new Set(), authorizedBareNamespaceToolAliases: new Map(),
      routedCustomToolNames: new Set(), routedCustomToolRepairNames: new Set(), declaredWireToolNames: new Set(["shell"]),
      routedToolSearchNames: new Set(), functionRepairSchemas: new Map(), declaredNamelessClientCallTypes: new Set(),
      providerExecutedCallTypes: new Set(), declaredBareWireToolNames: new Set(), recoverableBareCustomWireToolNames: new Set(),
      undeclaredToolGuardActive: true, rememberPassthroughResponse: false, rememberPassthroughResponseChecked() {}, noteInspectedPayload: observed,
      normalizeFunctionCompletionJson: (value: string) => value, outboundRequestBody: "{}" } as Parameters<typeof deliverPassthroughResponse>[6],
  );
}
const { guardBufferedComboRequiredTool, judgeBufferedRequiredTool, requiredToolContractOf } = await import("../../src/server/responses/combo-required-tool-contract");
const { attachResponseToolOwnership, responseToolOwnership } = await import("../../src/server/responses/response-tool-ownership");
const { isNonReplayableResponse, markResponseNonReplayable } = await import("../../src/lib/upstream-retry");
const { formatErrorResponse } = await import("../../src/bridge/errors");

describe("buffered required-tool safety controls", () => {
  for (const choice of ["required", { type: "function", name: "shell" }]) {
    test(`provider-owned custom calls cannot be replayed as client calls: ${JSON.stringify(choice)}`, async () => {
      const original = attachResponseToolOwnership(Response.json({ status: "completed", output: [{
        type: "custom_tool_call", name: "x_keyword_search", call_id: "xs_call-1", input: "synthetic search",
      }] }), new Set([{ itemType: "custom_tool_call", callIdPrefix: "xs_call-" }]));
      const result = await guardBufferedComboRequiredTool(original, { tools, tool_choice: choice }, "openai-responses");
      expect(result.status).toBe(400);
      expect(result.headers.get("x-should-retry")).toBe("false");
      expect(isNonReplayableResponse(result)).toBe(true);
      expect(await result.json()).toMatchObject({ error: { code: "required_tool_contract_unsatisfied" } });
    });
  }
  test("error formatter retains the contract code without overriding cyber-policy precedence", async () => {
    const response = formatErrorResponse(502, "upstream_error", "missing required call", { code: "required_tool_contract_unsatisfied" });
    expect(await response.json()).toMatchObject({ error: { code: "required_tool_contract_unsatisfied" } });
    const cyber = formatErrorResponse(400, "cyber_policy", "cyber policy refusal", { code: "required_tool_contract_unsatisfied" });
    expect(await cyber.json()).toMatchObject({ error: { code: "cyber_policy" } });
  });
  test("accepted rebuild preserves ownership and removes stale representation headers", async () => {
    const payload = completedWithCall("m1", "shell");
    const original = attachResponseToolOwnership(new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": "999" },
    }), new Set([{ itemType: "custom_tool_call", callIdPrefix: "xs_call-" }]));
    const accepted = await judgeBufferedRequiredTool(original, { kind: "named", name: "shell" });
    expect(accepted.headers.get("content-encoding")).toBeNull();
    expect(accepted.headers.get("content-length")).toBeNull();
    expect(responseToolOwnership(accepted)).toEqual(new Set([{ itemType: "custom_tool_call", callIdPrefix: "xs_call-" }]));
    expect(await accepted.json()).toEqual(payload);
  });

  for (const text of ["not JSON", "null", '{"status":"completed"}', '{"status":"failed","output":[]}', '{"status":"incomplete","output":[]}']) {
    test(`opaque or non-completed payload is not a contract verdict: ${text}`, async () => {
      const result = await judgeBufferedRequiredTool(new Response(text), { kind: "named", name: "shell" });
      expect(result.status).toBe(200);
      expect(await result.text()).toBe(text);
    });
  }

  for (const choice of [undefined, "auto", "none", null, {}]) {
    test(`no mandatory choice is inferred from ${JSON.stringify(choice)}`, () => {
      expect(requiredToolContractOf({ tools, tool_choice: choice })).toBeUndefined();
    });
  }
  test("unrecognized hosted output contracts abstain", () => {
    for (const type of ["tool_search", "local_shell", "x_search", "future_tool", "namespace"]) {
      expect(requiredToolContractOf({ tools: [{ type }], tool_choice: "required" })).toBeUndefined();
    }
    expect(requiredToolContractOf({ tools: [], tool_choice: "required" })).toBeUndefined();
  });

  test("a non-replayable success is neither consumed nor converted into a hop", async () => {
    const original = Response.json(completedNoCall("m1", "already executed"));
    markResponseNonReplayable(original);
    const result = await guardBufferedComboRequiredTool(original, { tools, tool_choice: "required" }, "openai-responses");
    expect(result).toBe(original);
    expect(result.bodyUsed).toBe(false);
    expect(isNonReplayableResponse(result)).toBe(true);
  });
  for (const adapter of ["openai-chat", "test-run-turn", undefined]) {
    test(`adapter terminal ownership stays with ${adapter}`, async () => {
      const original = Response.json(completedNoCall("m1", "adapter-owned"));
      expect(await guardBufferedComboRequiredTool(original, { tools, tool_choice: "required" }, adapter)).toBe(original);
      expect(original.bodyUsed).toBe(false);
    });
  }
  test("body-read failures propagate without inventing required-tool evidence", async () => {
    const failure = new Error("synthetic body failure");
    const original = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    expect(judgeBufferedRequiredTool(original, { kind: "named", name: "shell" })).rejects.toBe(failure);
  });
});

async function handleResponsesWith(config: OcxConfig, request: Request, parent?: RequestLogContext) {
  return handleResponses(request, config, parent ?? { model: "", provider: "" });
}

import assert from "node:assert/strict";
import { handleResponses } from "../../src/server/responses/core";
import { acquireOwnedSpendHome } from "./owned-spend-home";

export interface CompletionCase {
  name: string;
  frames: string[];
  sends: number;
  searches?: number;
  maxSearchesPerTurn?: number;
  checkBodies?: (bodies: readonly string[]) => void;
  search?: boolean;
  empty?: boolean;
  guard?: boolean;
  envOff?: boolean;
  input?: string;
  noTools?: boolean;
  final?: "response.failed" | "response.incomplete";
  errorCode?: string;
  identicalRetry?: boolean;
  /** The search backend answers 500, so later calls for the same query get the repeat placeholder. */
  searchFails?: boolean;
}

// Synthetic full Responses dispatch. No real provider or search requests are sent.
export async function checkHostedChatCompletion(row: CompletionCase, stream: boolean): Promise<void> {
  const release = acquireOwnedSpendHome();
  const actualFetch = globalThis.fetch;
  const originalOverride = process.env.OCX_EMPTY_COMPLETION_RETRY;
  try {
    let sends = 0;
    let searches = 0;
    const bodies: string[] = [];
    globalThis.fetch = async (input: any) => {
      assert.equal(String(input), "https://api.exa.ai/search", "unexpected external request");
      searches++;
      if (row.searchFails) return new Response("search backend unavailable", { status: 500 });
      return Response.json({ results: [
        { title: "Fixture", url: "https://example.invalid/fixture", text: "Fixture result" },
      ] });
    };
    const provider = {
      adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1",
      apiKey: "synthetic-not-a-key", models: ["zai-glm-5-3-flash"],
      terminalContinuationGuard: row.guard === true,
      fetch: async (_url: any, init: any) => {
        bodies.push(String(init?.body));
        const frame = row.frames[sends++];
        assert.notEqual(frame, undefined, "unexpected retry: " + row.name);
        let delta: any = { content: frame === "plan" ? "I'll inspect the file and apply the fix." : frame };
        let reason = "stop";
        if (frame === "thinking") delta = { reasoning_content: "Checking the fixture." };
        if (frame === "refusal" || frame === "truncated") {
          delta = {};
          reason = frame === "refusal" ? "content_filter" : "length";
        }
        if (frame === "tool" || frame === "search") {
          delta = { tool_calls: [{ index: 0, id: "fixture-call-" + sends, type: "function", function: {
            name: frame === "search" ? "web_search" : "read_fixture",
            arguments: frame === "search" ? '{"query":"fixture"}' : "{}",
          } }] };
          reason = "tool_calls";
        }
        if (JSON.parse(String(init?.body)).stream !== true) {
          return Response.json({ choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: reason }],
            usage: { prompt_tokens: 10, completion_tokens: 19, total_tokens: 29 } });
        }
        const wire = "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }],
          usage: { prompt_tokens: 10, completion_tokens: 19, total_tokens: 29 },
        }) + "\n\ndata: [DONE]\n\n";
        return new Response(wire, { headers: { "content-type": "text/event-stream" } });
      },
    };
    if (row.envOff) process.env.OCX_EMPTY_COMPLETION_RETRY = "0";
    else delete process.env.OCX_EMPTY_COMPLETION_RETRY;
    const config = {
      port: 0, defaultProvider: "fixture", emptyCompletionRetry: row.empty === true,
      providers: { fixture: provider },
      webSearchSidecar: { enabled: true, backend: "exa", exaApiKey: "synthetic-not-a-key", maxSearchesPerTurn: row.maxSearchesPerTurn },
    };
    const tools: any[] = row.noTools ? [] : [
      { type: "function", name: "read_fixture", parameters: { type: "object", properties: {} } },
    ];
    if (row.search !== false && !row.noTools) tools.push({ type: "web_search" });
    const request = new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/zai-glm-5-3-flash",
        input: row.input ?? "Please fix the file and test it.", stream, store: false, tools }),
    });
    const logContext: any = { model: "", provider: "" };
    const response = await handleResponses(request, config, logContext);
    const result = await response.text();
    assert.equal(sends, row.sends, row.name + " sends");
    assert.equal(searches, row.searches ?? 0, row.name + " searches");
    let final: any;
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const events = result.split("\n").filter(line => line.startsWith("data: ") && line.slice(6) !== "[DONE]")
        .map(line => JSON.parse(line.slice(6)));
      const terminals = events.filter(event => ["response.completed", "response.incomplete", "response.failed"].includes(event.type));
      assert.equal(terminals.length, 1, row.name + " single terminal");
      assert.equal(terminals[0]?.type, row.final ?? "response.completed", row.name + " terminal");
      final = terminals[0]?.response;
    } else {
      final = JSON.parse(result);
      assert.equal(final.status, row.final?.replace("response.", "") ?? "completed", row.name + " terminal");
    }
    if (row.errorCode) assert.equal(final.error?.code, row.errorCode, row.name + " error code");
    if (sends > 1 && row.search !== false) {
      assert.equal(logContext.usage?.totalTokens, sends * 29, row.name + " accumulated usage ledger");
    }
    if (row.identicalRetry) assert.equal(bodies[0], bodies[1], "empty retry must preserve request bytes");
    row.checkBodies?.(bodies);
    if (row.searches) {
      for (const body of bodies.slice(1)) {
        assert.ok(JSON.parse(body).messages.some((message: any) => message.role === "tool"), "search results retained");
      }
    }
  } finally {
    globalThis.fetch = actualFetch;
    if (originalOverride === undefined) delete process.env.OCX_EMPTY_COMPLETION_RETRY;
    else process.env.OCX_EMPTY_COMPLETION_RETRY = originalOverride;
    release();
  }
}


// Exercise iteration policy directly, including live output and the forced-answer request.
export async function checkHostedRecoveryIteration(
  frames: string[],
  { live = false, terminalContinuationGuard = false } = {},
) {
  const release = acquireOwnedSpendHome();
  const { runWithWebSearch } = await import("../../src/web-search/loop");
  const { buildWebSearchTool } = await import("../../src/web-search/synthetic-tool");
  const { createTestTranslatorBudget } = await import("./translator-budget");
  const originalFetch = globalThis.fetch;
  const seen: import("../../src/types").OcxParsedRequest[] = [];
  let frame: string | undefined;
  let searches = 0;
  try {
    globalThis.fetch = async () => { searches++; return Response.json({ results: [] }); };
    const response = await runWithWebSearch({
      emptyCompletionRetry: true, terminalContinuationGuard, streamRoutedModelOutput: live,
      parsed: { modelId: "fixture", stream: true, options: {}, context: {
        messages: [{ role: "user", content: "Please fix the file and test it." }],
        tools: [{ name: "read_fixture", parameters: { type: "object", properties: {} } }, buildWebSearchTool()],
      } },
      adapter: {
        name: "openai-chat",
        buildRequest(request) {
          frame = frames[seen.length];
          seen.push(structuredClone(request));
          assert.notEqual(frame, undefined, "unexpected recovery send");
          return { url: "https://fixture.invalid", method: "POST", headers: {}, body: "{}" };
        },
        fetchResponse: async () => new Response("wire"),
        async *parseStream() {
          if (frame === "search") {
            yield { type: "tool_call_start", id: "fixture-search", name: "web_search" };
            yield { type: "tool_call_delta", arguments: '{"query":"fixture"}' };
            yield { type: "tool_call_end" };
          } else if (frame === "thinking") yield { type: "thinking_delta", thinking: "Checking the fixture." };
          else if (frame) yield { type: "text_delta", text: frame === "plan" ? "I'll inspect the file and apply the fix." : frame };
          yield { type: "done" };
        },
      },
      backend: "exa", exaApiKey: "synthetic-not-a-key", hostedTool: { type: "web_search" },
      settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    });
    const text = await response.text();
    return { seen, searches, text };
  } finally { globalThis.fetch = originalFetch; release(); }
}

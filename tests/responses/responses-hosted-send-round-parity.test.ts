/**
 * A hosted web-search turn under transientRetryOn5xx: { attempts: 1 } makes the same model sends
 * whether the caller names the provider directly or reaches it as a Combo target.
 *
 * Round 1 asks for web_search, the bridge runs one (stubbed) Exa search, and round 2 answers.
 * Hosted bridge rounds are not transient retries, so neither path counts round 2 against the
 * configured attempts. The child-owned prepaid booking must not change that for Combo targets:
 * before it existed, the Combo path and the direct path already agreed at two sends, and a regression
 * to one send on either path would cut the hosted turn short.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { handleResponses } from "../../src/server/responses/core";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let priorHome: string | undefined;
let codex: IsolatedCodexHome;
let releaseSpend: () => void;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  priorHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "hosted-round-parity-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("hosted-round-parity-codex-");
  releaseSpend = acquireOwnedSpendHome();
  clearComboSelectionState(); clearComboTargetCooldowns();
});

afterEach(() => {
  try {
    releaseSpend();
  } finally {
    globalThis.fetch = originalFetch;
    clearComboSelectionState(); clearComboTargetCooldowns();
    codex.restore();
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorHome;
    removeTreeWithRetry(home);
  }
});

/** Round 1 calls web_search; every later round answers. */
function chatRound(round: number): Response {
  const chunks = round === 1
    ? [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_search", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ]
    : [
      { choices: [{ index: 0, delta: { content: "synthetic final answer" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

/** The last terminal Responses event in a drained SSE body. */
function terminalEvent(body: string): string | undefined {
  const types = body.split(/\r?\n\r?\n/).map(block => {
    const named = block.match(/^event:\s*(.+)$/m)?.[1];
    if (named) return named;
    try { return (JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] ?? "{}") as { type?: string }).type; } catch { return undefined; }
  });
  return types.filter(type => type === "response.completed" || type === "response.failed" || type === "response.incomplete" || type === "error").at(-1);
}

async function hostedSearchTurn(model: "a/m" | "combo/auto") {
  let modelSends = 0;
  let searches = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("api.exa.ai/search")) throw new Error(`unexpected network call: ${url}`);
    searches++;
    return Response.json({ results: [{ title: "Synthetic result", url: "https://example.test/x", content: "Synthetic result", text: "Synthetic result" }] });
  }) as typeof fetch;
  const config = {
    port: 0,
    defaultProvider: "a",
    providers: {
      a: {
        adapter: "openai-chat", authMode: "key", apiKey: "synthetic-key", baseUrl: "https://synthetic.invalid/v1",
        liveModels: false, models: ["m"], transientRetryOn5xx: { attempts: 1 },
        fetch: (async () => chatRound(++modelSends)) as unknown as typeof fetch,
      },
    },
    combos: { auto: { strategy: "failover", targets: [{ provider: "a", model: "m" }] } },
    webSearchSidecar: { backend: "exa", exaApiKey: "synthetic-unused-key" },
  } as unknown as OcxConfig;
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, input: "Search for x", tools: [{ type: "web_search" }] }),
  });
  const response = await handleResponses(request, config, { model: "", provider: "" });
  const terminal = terminalEvent(await response.text());
  return { status: response.status, terminal, modelSends, searches };
}

test("a hosted search turn sends both model rounds for a direct request and a Combo target alike", async () => {
  const direct = await hostedSearchTurn("a/m");
  clearComboSelectionState(); clearComboTargetCooldowns();
  const combo = await hostedSearchTurn("combo/auto");
  expect(direct).toEqual({ status: 200, terminal: "response.completed", modelSends: 2, searches: 1 });
  expect(combo).toEqual({ status: 200, terminal: "response.completed", modelSends: 2, searches: 1 });
});


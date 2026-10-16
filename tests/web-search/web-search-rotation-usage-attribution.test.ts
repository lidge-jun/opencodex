/**
 * A web-search turn whose second round is refused with a 429 rotates the OAuth account and
 * splits the request into two attempt rows. Each row must carry the usage its own account spent:
 * the search round billed account 0, the answer round billed account 1. Reporting the loop's
 * total once at the end put both rounds on account 1 and left account 0's row empty.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { addFinalRequestLog, type RequestLogContext, type RequestLogEntry } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";
let releaseSpendHome: (() => void) | undefined;
let handleResponses: typeof import("../../src/server/responses")["handleResponses"];

function chatSse(promptTokens: number, completionTokens: number, delta: object, finishReason: string): Response {
  const chunks = [
    { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
    { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    { id: "c1", object: "chat.completion.chunk", choices: [],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } },
  ];
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  // Copied before mocking: the live namespace would resolve to the mock itself.
  const actualWebSearch = { ...await import("../../src/web-search") };
  mock.module("../../src/web-search", () => ({
    ...actualWebSearch,
    shouldResolveOpenAiWebSearchSidecar: () => false,
    // exa without a key answers each search with an error result, so no search leaves the process.
    planWebSearch: () => ({
      backend: "exa",
      hostedTool: { type: "web_search" },
      settings: { model: "fixture", reasoning: "low", timeoutMs: 1_000 },
      maxSearches: 1,
    }),
  }));
  ({ handleResponses } = await import("../../src/server/responses"));
});

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-sidecar-usage-attribution-"));
  process.env.OPENCODEX_HOME = testHome;
  clearGenericFailoverHealth();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearGenericFailoverHealth();
  removeTreeWithRetry(testHome);
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  mock.restore();
});

test("each attempt row carries the usage of the account that served its rounds", async () => {
  for (const accountId of ["first", "second"]) {
    await saveCredential("xai", {
      access: `access-${accountId}`, refresh: `refresh-${accountId}`, expires: Date.now() + 3_600_000, accountId,
    });
  }
  await setActiveAccount("xai", getAccountSet("xai")!.accounts[0]!.id);
  const sends: string[] = [];
  const config = {
    port: 0,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        models: ["model"],
        fetch: (async (_input, init) => {
          sends.push(new Headers(init?.headers).get("authorization") ?? "");
          if (sends.length === 1) {
            return chatSse(100, 10, { tool_calls: [{ index: 0, id: "call_1", type: "function",
              function: { name: "web_search", arguments: JSON.stringify({ query: "fixture" }) } }] }, "tool_calls");
          }
          if (sends.length === 2) return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
          return chatSse(300, 30, { content: "answer" }, "stop");
        }) as typeof fetch,
      },
    },
  } as unknown as OcxConfig;
  const logCtx = { model: "", provider: "" } as RequestLogContext;

  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "xai/model", input: "search", stream: true, tools: [{ type: "web_search" }] }),
  }), config, logCtx);
  expect(response.status).toBe(200);
  await response.text();
  expect(sends).toEqual(["Bearer access-first", "Bearer access-first", "Bearer access-second"]);

  let entry: RequestLogEntry | undefined;
  addFinalRequestLog("req-attribution", Date.now(), logCtx, 200, undefined, logged => { entry = logged; });
  const rows = entry?.attempts ?? [];
  expect(rows).toHaveLength(2);
  expect(rows[0]!.accountLogLabel).not.toBe(rows[1]!.accountLogLabel);
  expect(rows.map(row => [row.usage?.inputTokens, row.usage?.outputTokens])).toEqual([[100, 10], [300, 30]]);
});

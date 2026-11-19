import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { handleResponses } from "../../src/server/responses/core";
import { attachRequestSpendTracker } from "../../src/server/responses/request-spend";
import { createRequestExecutionBudget, type RequestExecutionBudget } from "../../src/lib/request-execution-budget";
import {
  configureSharedSpendLedger, parseSpendJournalRecord, SPEND_LEDGER_JOURNAL_FILENAME, spendPolicyFromConfig,
} from "../../src/lib/spend-reservation-ledger";
import type { AdapterEvent, OcxConfig, OcxUsage } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// A hosted Chat terminal re-ask is one more physical send. It must be charged at guarded dispatch
// like the initial send, refused before dispatch by an exhausted send budget or spend ceiling,
// and settled in the pool spend ledger. Synthetic relay and search backend; no real requests.
const RELAY = "https://relay.example.com/v1/chat/completions";
const SEARCH = "https://api.exa.ai/search";

interface Case {
  stream: boolean;
  frames: string[];
  search?: boolean;
  sendCap?: number;
  poolCeiling?: number;
  emptyRetry?: boolean;
  /** Connection resets before each iteration's successful send. */
  resetsPerIteration?: number;
  /** The last frame's send reports no usage object. */
  usagelessFinal?: boolean;
  /** The parser adds a credit reading of 2 to every usage it reports (#8452). */
  credits?: boolean;
}

async function hostedReask(row: Case) {
  const home = mkdtempSync(join(tmpdir(), "ocx-search-reask-budget-"));
  const previousHome = process.env.OPENCODEX_HOME;
  const previousOverride = process.env.OCX_EMPTY_COMPLETION_RETRY;
  const previousFetch = globalThis.fetch;
  process.env.OPENCODEX_HOME = home;
  delete process.env.OCX_EMPTY_COMPLETION_RETRY;
  const release = acquireOwnedSpendHome();
  let budget: RequestExecutionBudget | undefined;
  const usedAtDispatch: number[] = [];
  let physical = 0;
  let iterations = 0;
  let resets = 0;
  const create = ADAPTER_REGISTRY["openai-chat"].create;
  const adapter = row.credits ? spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => {
    const original = create(...args);
    const withCredits = (event: AdapterEvent): AdapterEvent => "usage" in event && event.usage
      ? { ...event, usage: { ...event.usage, providerCredits: 2 } } as AdapterEvent : event;
    return {
      ...original,
      async *parseStream(...params) { for await (const event of original.parseStream(...params)) yield withCredits(event); },
      ...(original.parseResponse ? { parseResponse: async (...params: Parameters<NonNullable<typeof original.parseResponse>>) =>
        (await original.parseResponse!(...params)).map(withCredits) } : {}),
    };
  }) : undefined;
  try {
    if (row.poolCeiling !== undefined) {
      configureSharedSpendLedger(spendPolicyFromConfig({ pool: { maxTokens: row.poolCeiling } }, undefined, ["relay"]));
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === SEARCH) return new Response("search backend unavailable", { status: 500 });
      if (url !== RELAY) throw new Error("unexpected network target");
      physical++;
      if (budget) usedAtDispatch.push(budget.used);
      if (resets < (row.resetsPerIteration ?? 0)) {
        resets++;
        throw Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" });
      }
      resets = 0;
      const frame = row.frames[iterations++];
      if (frame === undefined) throw new Error("unexpected extra provider send");
      let delta: Record<string, unknown> = { content: frame === "plan" ? "I'll inspect the file and apply the fix." : frame };
      let reason = "stop";
      if (frame === "cut") reason = "length";
      if (frame === "tool" || frame === "search") {
        delta = { tool_calls: [{ index: 0, id: `fixture-call-${iterations}`, type: "function", function: {
          name: frame === "search" ? "web_search" : "read_fixture",
          arguments: frame === "search" ? '{"query":"fixture"}' : "{}",
        } }] };
        reason = "tool_calls";
      }
      const usage = row.usagelessFinal && iterations === row.frames.length ? undefined
        : { prompt_tokens: 10, completion_tokens: 19, total_tokens: 29 };
      if (JSON.parse(String(init?.body)).stream !== true) {
        return Response.json({ choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: reason }], usage });
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }], usage })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const config = {
      defaultProvider: "relay", emptyCompletionRetry: row.emptyRetry === true,
      providers: { relay: { adapter: "openai-chat", authMode: "key", baseUrl: "https://relay.example.com/v1",
        apiKey: "synthetic-not-a-key", models: ["m"], terminalContinuationGuard: true } },
      webSearchSidecar: { enabled: true, backend: "exa", exaApiKey: "synthetic-not-a-key" },
    } as OcxConfig;
    const tools: unknown[] = [{ type: "function", name: "read_fixture", parameters: { type: "object", properties: {} } }];
    if (row.search !== false) tools.push({ type: "web_search" });
    const request = new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay/m", input: "Please fix the file and test it.", stream: row.stream,
        store: false, max_output_tokens: 256, tools }),
    });
    const log: Parameters<typeof handleResponses>[2] = { model: "", provider: "" };
    budget = row.sendCap === undefined ? undefined : createRequestExecutionBudget({
      maxTotalModelSends: row.sendCap, baseSendAllowance: row.sendCap, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    }, undefined, attachRequestSpendTracker(request, log));
    const response = await handleResponses(request, config, log, budget ? { sendBudget: budget } : {});
    const text = await response.text();
    log.spendTracker?.settle(log.usage);
    const journal = Bun.file(join(home, SPEND_LEDGER_JOURNAL_FILENAME));
    const records = await journal.exists() ? (await journal.text()).trim().split("\n").map(parseSpendJournalRecord) : [];
    return { status: response.status, text, physical, usedAtDispatch, used: budget?.used,
      recordedSends: log.activeAttempt?.sendCount, logUsage: log.usage, records,
      settled: records.filter(record => record?.kind === "settle").map(record => record?.kind === "settle" && record.tokens),
      lost: records.filter(record => record?.kind === "lost").length };
  } finally {
    try { release(); adapter?.mockRestore(); } finally {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousOverride === undefined) delete process.env.OCX_EMPTY_COMPLETION_RETRY;
      else process.env.OCX_EMPTY_COMPLETION_RETRY = previousOverride;
      removeTreeWithRetry(home);
    }
  }
}

for (const stream of [true, false]) {
  test(`a one-send budget refuses the hosted re-ask before dispatch (stream=${stream})`, async () => {
    const result = await hostedReask({ stream, sendCap: 1, frames: ["plan", "tool"] });
    expect({ physical: result.physical, usedAtDispatch: result.usedAtDispatch, used: result.used,
      recordedSends: result.recordedSends }).toEqual({ physical: 1, usedAtDispatch: [1], used: 1, recordedSends: 1 });
    expect(result.text).toContain("request_send_budget_exhausted");
    expect(result.text).not.toContain("read_fixture");
  });

  test(`a two-send budget charges and records the hosted re-ask once (stream=${stream})`, async () => {
    const result = await hostedReask({ stream, sendCap: 2, frames: ["plan", "tool"] });
    expect({ physical: result.physical, usedAtDispatch: result.usedAtDispatch, used: result.used,
      recordedSends: result.recordedSends }).toEqual({ physical: 2, usedAtDispatch: [1, 2], used: 2, recordedSends: 2 });
    expect(result.text).toContain("read_fixture");
  });

  test(`a one-token pool ceiling refuses hosted Chat before any send, like plain Chat (stream=${stream})`, async () => {
    for (const search of [false, true]) {
      const result = await hostedReask({ stream, search, poolCeiling: 1, frames: ["plan", "tool"] });
      expect({ search, status: result.status, physical: result.physical, recordedSends: result.recordedSends })
        .toEqual({ search, status: 429, physical: 0, recordedSends: 0 });
      expect(result.text).toContain("request_send_budget_exhausted");
    }
  });

  test(`the pool spend ledger reserves and settles the hosted re-ask (stream=${stream})`, async () => {
    const result = await hostedReask({ stream, poolCeiling: 100_000, frames: ["plan", "tool"] });
    expect(result.physical).toBe(2);
    expect(result.records.filter(record => record?.kind === "reserve")).toHaveLength(2);
    expect(result.records.filter(record => record?.kind === "dispatch")).toHaveLength(2);
    // #8902: each send settles its own reservation with its own usage (29 tokens each); neither is
    // left unresolved and nothing is booked twice.
    expect({ settled: result.settled, lost: result.lost }).toEqual({ settled: [29, 29], lost: 0 });
  });

  // #8877 on both Chat delivery paths: plain adapter delivery (no web_search) and the hosted loop.
  // Each leg re-sends the conversation, so the client terminal reports one leg's usage (10 + 19)
  // for its context window, while the send budget, the attempt's send count, the request log and
  // the pool spend ledger count both legs.
  test.each([false, true])(`client usage is the final leg's; sends, log and ledger count both legs (stream=${stream}, search=%p)`, async search => {
    const result = await hostedReask({ stream, search, sendCap: 2, poolCeiling: 100_000, frames: ["plan", "tool"] });
    expect({ status: result.status, physical: result.physical, used: result.used, recordedSends: result.recordedSends })
      .toEqual({ status: 200, physical: 2, used: 2, recordedSends: 2 });
    // A buffered hosted turn is still framed as SSE at this layer (see hosted-chat-completion.ts).
    const clientUsage = result.text.trimStart().startsWith("{")
      ? JSON.parse(result.text).usage
      : result.text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
        .find(frame => frame.type === "response.completed")?.response?.usage;
    expect(clientUsage).toMatchObject({ input_tokens: 10, output_tokens: 19, total_tokens: 29 });
    expect(result.logUsage).toMatchObject({ inputTokens: 20, outputTokens: 38 });
    expect({ settled: result.settled, lost: result.lost }).toEqual({ settled: [29, 29], lost: 0 });
  });

  // A failed or incomplete terminal after a re-ask is not a context checkpoint: the client sees
  // the summed usage there (plain guard and hosted loop alike), and the log and ledger use that
  // same sum once.
  test.each([
    [false, "cut"], [true, "cut"], [false, "plan"], [true, "plan"],
  ] as const)(`a failed or incomplete terminal after a re-ask carries the summed usage (stream=${stream}, search=%p, final=%p)`, async (search, final) => {
    const result = await hostedReask({ stream, search, sendCap: 2, poolCeiling: 100_000, frames: ["plan", final] });
    expect({ physical: result.physical, used: result.used }).toEqual({ physical: 2, used: 2 });
    expect(result.text).toContain(final === "plan" ? "terminal_continuation_failed" : "incomplete");
    if (stream) {
      const terminal = result.text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
        .find(frame => frame.type === "response.failed" || frame.type === "response.incomplete");
      expect(terminal?.response?.usage).toMatchObject({ input_tokens: 20, output_tokens: 38, total_tokens: 58 });
    }
    expect(result.logUsage).toMatchObject({ inputTokens: 20, outputTokens: 38 });
    expect({ settled: result.settled, lost: result.lost }).toEqual({ settled: [29, 29], lost: 0 });
  });

  // #8902 on the empty-completion retry: the empty send, the retry that announces work and its
  // re-ask each settle their own 29 tokens.
  test.each([false, true])(`a re-ask inside the empty-completion retry settles every send on its own (stream=${stream}, search=%p)`, async search => {
    const result = await hostedReask({ stream, search, emptyRetry: true, sendCap: 3, poolCeiling: 100_000, frames: ["", "plan", "tool"] });
    expect({ status: result.status, physical: result.physical, used: result.used }).toEqual({ status: 200, physical: 3, used: 3 });
    expect(result.logUsage).toMatchObject({ inputTokens: 30, outputTokens: 57 });
    expect({ settled: result.settled, lost: result.lost }).toEqual({ settled: [29, 29, 29], lost: 0 });
  });

  // #8452: the final leg was dispatched and reported no usage, so the credit total is incomplete
  // (-1) rather than the first leg's 2. Tokens stay deduplicated per response; the usage-less
  // send has no reading of its own and stays unresolved in the ledger.
  test.each([false, true])(`a usage-less final leg leaves the credit total incomplete (stream=${stream}, search=%p)`, async search => {
    const result = await hostedReask({ stream, search, sendCap: 2, poolCeiling: 100_000, frames: ["plan", "tool"],
      usagelessFinal: true, credits: true });
    expect({ status: result.status, physical: result.physical }).toEqual({ status: 200, physical: 2 });
    expect(result.logUsage).toMatchObject({ inputTokens: 10, outputTokens: 19, providerCredits: -1 });
    expect({ settled: result.settled, lost: result.lost }).toEqual({ settled: [29], lost: 1 });
  });

  test(`the default hosted allowance funds a re-ask after every other iteration is used (stream=${stream})`, async () => {
    // Three default searches fail, the forced answer is empty, its retry announces work, and the
    // re-ask announces it again: every loop slot is used, and each one spends its reset ladder.
    const result = await hostedReask({ stream, emptyRetry: true, resetsPerIteration: 2,
      frames: ["search", "search", "search", "search", "search", "", "plan", "plan"] });
    expect(result.physical).toBe(24);
    expect(result.recordedSends).toBe(24);
    expect(result.text).toContain("terminal_continuation_failed");
    expect(result.text).not.toContain("request_send_budget_exhausted");
  }, 20_000);
}

// #8452 credit accounting: the re-ask is a dispatched leg like any other hosted iteration, so its
// credit reading joins the announcing pass's instead of marking the evidence incomplete (-1).
test.each([
  [["plan", "tool"], 5, "response.completed"],
  [["plan", "plan"], 5, "terminal_continuation_failed"],
] as const)("hosted re-ask credits reach the usage ledger once (%p)", async (frames, credits, terminal) => {
  const { runWithWebSearch } = await import("../../src/web-search/loop");
  const { buildWebSearchTool } = await import("../../src/web-search/synthetic-tool");
  const { createTestTranslatorBudget } = await import("../helpers/translator-budget");
  const previousFetch = globalThis.fetch;
  const reported: (OcxUsage | undefined)[] = [];
  let iteration = 0;
  let events: AdapterEvent[] = [];
  try {
    globalThis.fetch = (async () => Response.json({ results: [] })) as unknown as typeof fetch;
    const response = await runWithWebSearch({
      terminalContinuationGuard: true,
      parsed: { modelId: "m", stream: true, options: {}, context: {
        messages: [{ role: "user", content: "Please fix the file and test it.", timestamp: 0 }],
        tools: [{ name: "read_fixture", description: "", parameters: { type: "object", properties: {} } }, buildWebSearchTool()],
      } },
      adapter: {
        name: "openai-chat",
        buildRequest() {
          const frame = frames[iteration];
          const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12, providerCredits: iteration === 0 ? 2 : 3 };
          iteration++;
          events = frame === "tool"
            ? [{ type: "tool_call_start", id: "call_fixture", name: "read_fixture" }, { type: "tool_call_delta", arguments: "{}" },
              { type: "tool_call_end" }, { type: "done", stopReason: "tool_use", usage }]
            : [{ type: "text_delta", text: "I'll inspect the file and apply the fix." }, { type: "done", stopReason: "stop", usage }];
          return { url: "https://relay.example.com/v1/chat/completions", method: "POST", headers: {}, body: "{}" };
        },
        fetchResponse: async (_request, ctx) => {
          ctx?.onPhysicalSend?.({ ordinal: 1 });
          return new Response("wire");
        },
        async *parseStream() { yield* events; },
      },
      backend: "exa", exaApiKey: "synthetic-not-a-key", hostedTool: { type: "web_search" },
      settings: { model: "m", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      onUsage: usage => reported.push(usage),
    });
    const text = await response.text();
    expect(iteration).toBe(2);
    expect(text).toContain(terminal);
    expect(reported).toEqual([expect.objectContaining({ inputTokens: 20, outputTokens: 4, providerCredits: credits })]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

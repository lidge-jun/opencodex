import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { markResponseNonReplayable, SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY, type SpendJournal } from "../../src/lib/spend-reservation-ledger";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import { encodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
const SIGNATURE = "SyntheticSearchSignature123456==";
const REDACTED = "synthetic-search-redacted-thinking";
const REJECTION = "Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the thinking block and retry.";
let home = "";
let release: (() => void) | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-search-thinking-recovery-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  resetWorkflowBudgetsForTest();
});
afterEach(() => {
  try { release?.(); } finally {
    release = undefined;
    globalThis.fetch = originalFetch;
    clearReasoningReplayCacheForTests();
    resetThoughtSignatureReplayForTests();
    resetWorkflowBudgetsForTest();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  }
});

function config(): OcxConfig {
  return {
    defaultProvider: "anthropic-test", emptyCompletionRetry: false,
    webSearchSidecar: { backend: "exa", exaApiKey: "synthetic-search-key", maxSearchesPerTurn: 2 },
    providers: { "anthropic-test": {
      adapter: "anthropic", baseUrl: "https://anthropic.example.test", authMode: "key",
      apiKey: "synthetic-test-key", proxy: "direct", models: ["claude-sonnet-4-5"],
    } },
  } as OcxConfig;
}
function request(stream = true, thread = "search-thinking-thread", signed = true): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "x-codex-parent-thread-id": thread },
    body: JSON.stringify({ model: "anthropic-test/claude-sonnet-4-5", stream, store: false,
      tools: [{ type: "web_search" }, { type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "earlier question" }] },
        ...(signed ? [{ type: "reasoning", summary: [{ type: "summary_text", text: "earlier reasoning" }],
          encrypted_content: encodeReasoningEnvelope({ sig: SIGNATURE, red: [REDACTED] }) }] : []),
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "search this fixture" }] },
      ],
    }),
  });
}
function frame(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}
function sse(...frames: string[]): Response {
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}
function rejection(message = REJECTION): Response {
  return Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status: 400 });
}
function streamRejection(...prefix: string[]): Response {
  return sse(...prefix, frame("error", { error: { type: "invalid_request_error", message: REJECTION } }));
}
function textFrame(text: string): string {
  return frame("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
}
function success(text = "Recovered search answer", stopReason = "end_turn"): Response {
  return sse(frame("message_start", { message: { usage: { input_tokens: 2 } } }),
    ...(text ? [textFrame(text)] : []),
    frame("message_delta", { delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } }), frame("message_stop"));
}
function search(id = "ws_fixture", query = "fixture", signature = SIGNATURE): Response {
  return sse(frame("message_start", { message: { usage: { input_tokens: 2 } } }),
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "search reasoning" } }),
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature } }),
    frame("content_block_stop", { index: 0 }),
    frame("content_block_start", { index: 1, content_block: { type: "tool_use", id, name: "web_search", input: {} } }),
    frame("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) } }),
    frame("content_block_stop", { index: 1 }),
    frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }), frame("message_stop"));
}
function transport(answer: (index: number, init?: RequestInit) => Response | Promise<Response>) {
  const bodies: string[] = [];
  const queries: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://api.exa.ai/search") {
      queries.push(String(init?.body));
      return Response.json({ results: [{ title: "fixture", url: "https://fixture.example.test", text: "retained search result" }] });
    }
    if (!["https://anthropic.example.test/v1/messages", "https://other-anthropic.example.test/v1/messages", "https://api.anthropic.com/v1/messages"].includes(url)) throw new Error(`Unexpected network target blocked: ${url}`);
    bodies.push(String(init?.body));
    return answer(bodies.length, init);
  }) as typeof fetch;
  return { bodies, queries };
}
async function send(options: Parameters<typeof handleResponses>[3] = {}, cfg = config(), req = request()) {
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(req, cfg, log, options);
  return { response, text: await response.text(), log };
}
function expectStripped(body: string): void {
  expect(body).not.toContain(SIGNATURE);
  expect(body).not.toContain(REDACTED);
  expect(body).not.toContain('"type":"thinking"');
  expect(body).not.toContain('"type":"redacted_thinking"');
  expect(body).toContain("earlier answer");
  expect(body).toContain("search this fixture");
}
function removeThinking(body: string): unknown {
  const parsed = JSON.parse(body);
  for (const message of parsed.messages) {
    if (Array.isArray(message.content)) message.content = message.content.filter(
      (part: { type: string }) => part.type !== "thinking" && part.type !== "redacted_thinking");
  }
  return parsed;
}

describe("hosted web search Anthropic thinking-signature recovery", () => {
  for (const rawSse of [false, true]) {
    test(`signed progress created during search remains eligible for recovery (SSE=${rawSse})`, async () => {
      const cfg = config();
      cfg.providers["anthropic-test"]!.baseUrl = "https://api.anthropic.com";
      cfg.providers["anthropic-test"]!.models = ["claude-opus-5-5"];
      const input = request(true, "search-progress-recovery", false);
      const body = await input.json() as Record<string, unknown>;
      body.model = "anthropic-test/claude-opus-5-5";
      body.reasoning = { effort: "high" };
      const req = new Request(input.url, { method: "POST", headers: input.headers, body: JSON.stringify(body) });
      const { bodies, queries } = transport(index => index === 1 ? search() : index === 2
        ? rawSse ? streamRejection(frame("ping")) : rejection() : success());
      const result = await send({}, cfg, req);
      expect(result.text).toContain("Recovered search answer");
      expect(result.text).not.toContain("response.failed");
      expect(bodies).toHaveLength(3);
      expect(JSON.parse(bodies[0]).thinking.display).toBe("updates");
      expect(bodies[0]).not.toContain(SIGNATURE);
      expect(bodies[1]).toContain(SIGNATURE);
      expect(bodies[2]).not.toContain(SIGNATURE);
      expect(JSON.parse(bodies[2])).toEqual(removeThinking(bodies[1]));
      expect(queries).toHaveLength(1);
      expect(bodies[2]).toContain("retained search result");
      expect(result.log.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
    });
  }
  for (const stream of [false, true]) {
    test(`HTTP 400 rebuilds current iteration and memoizes final completion (stream=${stream})`, async () => {
      const { bodies, queries } = transport(index => index === 1 ? rejection() : success());
      const result = await send({}, config(), request(stream));
      expect(result.response.status).toBe(200);
      expect(result.text).toContain("Recovered search answer");
      expect(result.text).not.toContain("response.failed");
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toContain(SIGNATURE);
      expectStripped(bodies[1]);
      expect(JSON.parse(bodies[1])).toEqual(removeThinking(bodies[0]));
      expect(queries).toHaveLength(0);
      expect(result.log.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
      await send({}, config(), request(stream));
      expect(bodies).toHaveLength(3);
      expectStripped(bodies[2]);
    });
  }
  test("initial raw SSE error after pings retries before any current-send output", async () => {
    const { bodies } = transport(index => index === 1 ? streamRejection(": keepalive\n\n", frame("ping")) : success());
    const result = await send();
    expect(result.text).toContain("Recovered search answer");
    expect(result.text).toContain("response.completed");
    expect(result.text).not.toContain(REJECTION);
    expect(bodies).toHaveLength(2);
    expectStripped(bodies[1]);
  });
  for (const rawSse of [false, true]) {
    test(`rejection after search replays only current iteration and retains tool history (SSE=${rawSse})`, async () => {
      const { bodies, queries } = transport(index => index === 1 ? search() : index === 2
        ? rawSse ? streamRejection(frame("ping")) : rejection() : success());
      const result = await send();
      expect(result.text).toContain("Recovered search answer");
      expect(result.text).not.toContain("response.failed");
      expect(bodies).toHaveLength(3);
      expect(queries).toHaveLength(1);
      expect(bodies[1]).toContain(SIGNATURE);
      expectStripped(bodies[2]);
      expect(bodies[2]).toContain("retained search result");
      expect(bodies[2]).toContain("ws_fixture");
      expect(JSON.parse(bodies[2])).toEqual(removeThinking(bodies[1]));
      expect(result.log.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
    });
  }

  test("old stripping persists while newly issued search thinking remains replayable", async () => {
    const firstFresh = "SyntheticFreshFirstSignature123456==";
    const secondFresh = "SyntheticFreshSecondSignature123456==";
    const { bodies, queries } = transport(index => index === 1 ? rejection()
      : index === 2 ? search("ws_first", "first fixture", firstFresh)
        : index === 3 ? search("ws_second", "second fixture", secondFresh) : success());
    const result = await send();
    expect(result.text).toContain("Recovered search answer");
    expect(bodies).toHaveLength(4);
    expect(queries).toHaveLength(2);
    expectStripped(bodies[1]);
    for (const body of bodies.slice(2)) { expect(body).not.toContain(SIGNATURE); expect(body).not.toContain(REDACTED); }
    expect(bodies[2]).toContain(firstFresh);
    expect(bodies[3]).toContain(firstFresh);
    expect(bodies[3]).toContain(secondFresh);
    expect(bodies[3]).toContain("ws_first");
    expect(bodies[3]).toContain("ws_second");
    expect(result.log.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
  });
  for (const firstSse of [false, true]) {
    test(`HTTP and SSE refusals share one request-wide guard across rounds (first SSE=${firstSse})`, async () => {
      const fresh = "SyntheticFreshGuardSignature123456==";
      const { bodies, queries } = transport(index => index === 1 ? firstSse ? streamRejection() : rejection()
        : index === 2 ? search("ws_fixture", "fixture", fresh) : index === 3 ? firstSse ? rejection() : streamRejection() : success());
      const result = await send();
      expect(bodies).toHaveLength(3);
      expect(queries).toHaveLength(1);
      expectStripped(bodies[1]);
      expect(bodies[2]).not.toContain(SIGNATURE);
      expect(bodies[2]).not.toContain(REDACTED);
      expect(bodies[2]).toContain(fresh);
      expect(result.text).toContain("response.failed");
      expect(result.text).toContain(REJECTION);
      await send();
      expect(bodies).toHaveLength(4);
      expect(bodies[3]).toContain(SIGNATURE);
    });
    test(`HTTP and SSE refusals share one allowance within a send (first SSE=${firstSse})`, async () => {
      const { bodies } = transport(index => index === 1 ? firstSse ? streamRejection() : rejection()
        : firstSse ? rejection() : streamRejection());
      const result = await send();
      expect(bodies).toHaveLength(2);
      expectStripped(bodies[1]);
      expect(result.text).toContain(REJECTION);
    });
  }
  for (const prefix of [
    { name: "visible text", value: textFrame("Already visible") },
    { name: "thinking start", value: frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }) },
    { name: "tool call start", value: frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "lookup_fixture", name: "lookup", input: {} } }) },
    { name: "hosted search start", value: frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "ws_unsafe", name: "web_search", input: {} } }) },
  ]) for (const afterSearch of [false, true]) {
    test(`current-send ${prefix.name} fences recovery (prior search=${afterSearch})`, async () => {
      const { bodies, queries } = transport(index => afterSearch && index === 1 ? search() : streamRejection(prefix.value));
      const result = await send();
      expect(bodies).toHaveLength(afterSearch ? 2 : 1);
      expect(queries).toHaveLength(afterSearch ? 1 : 0);
      expect(result.text).toContain("response.failed");
      expect(result.text).toContain(REJECTION);
    });
  }
  for (const retry of ["http", "raw-error", "empty", "truncated", "incomplete", "thinking-only", "search-then-fail"] as const) {
    test(`a ${retry} replacement cannot memoize stripped history`, async () => {
      const { bodies } = transport(index => index === 1 ? streamRejection() : index === 2
        ? retry === "http" ? rejection("Synthetic replacement refusal")
          : retry === "raw-error" ? streamRejection()
            : retry === "empty" ? success("")
              : retry === "truncated" ? sse(textFrame("Partial answer"))
                : retry === "incomplete" ? success("Partial answer", "max_tokens")
                  : retry === "thinking-only" ? sse(frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
                    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Only thinking" } }),
                    frame("content_block_stop", { index: 0 }), frame("message_delta", { delta: { stop_reason: "end_turn" } }), frame("message_stop"))
                    : search()
        : index === 3 && retry === "search-then-fail" ? rejection("Synthetic final refusal") : success());
      const result = await send();
      expect(bodies).toHaveLength(retry === "search-then-fail" ? 3 : 2);
      expectStripped(bodies[1]);
      if (retry === "http") expect(result.text).toContain("Synthetic replacement refusal");
      if (retry === "search-then-fail") expect(result.text).toContain("Synthetic final refusal");
      await send();
      expect(bodies.at(-1)).toContain(SIGNATURE);
    });
  }
  test("non-replayable HTTP refusal never authorizes stripping", async () => {
    const { bodies } = transport(() => {
      const response = rejection(); markResponseNonReplayable(response); return response;
    });
    const result = await send();
    expect(result.response.status).toBe(400);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(SIGNATURE);
  });
  test("unrelated refusal text and unsigned history never gain a resend", async () => {
    for (const message of ["Invalid `signature` in `thinking` block", "The block is bound to a different conversation", "Invalid API key"]) {
      const { bodies } = transport(() => rejection(message));
      expect((await send()).response.status).toBe(400);
      expect(bodies).toHaveLength(1);
    }
    const { bodies } = transport(() => rejection());
    expect((await send({}, config(), request(true, "unsigned-search-thread", false))).response.status).toBe(400);
    expect(bodies).toHaveLength(1);
  });
  for (const combo of [false, true]) for (const rawSse of [false, true]) {
    test(`shared budget denies recovery without another physical send (Combo=${combo}, SSE=${rawSse})`, async () => {
      const budget = createRequestExecutionBudget({ maxTotalModelSends: combo ? 1 : 0,
        baseSendAllowance: combo ? 1 : 0, finalRecoveryAllowance: 0,
        maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, "search-recovery-refused");
      const options: Parameters<typeof handleResponses>[3] = { sendBudget: budget };
      if (combo) {
        const booking = budget.reserveDispatch({ sendClass: "initial", targetKey: "anthropic-test|https://anthropic.example.test/v1/messages|claude-sonnet-4-5", countedExternally: true });
        if (!booking.allowed) throw new Error("Synthetic initial booking refused");
        options.comboAttempt = true;
        options.comboInitialSend = { permit: booking.permit };
      }
      const { bodies } = transport(index => index === 1 ? rawSse ? streamRejection() : rejection() : success());
      await send(options);
      expect(bodies).toHaveLength(1);
      expect(budget.used).toBe(1);
      await send();
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain(SIGNATURE);
    });
  }
  for (const rawSse of [false, true]) {
    test(`cancellation before recovery prevents dispatch and memo (SSE=${rawSse})`, async () => {
      const abort = new AbortController();
      const { bodies } = transport(index => {
        if (index === 1) { abort.abort(); return rawSse ? streamRejection() : rejection(); }
        return success();
      });
      await send({ abortSignal: abort.signal });
      expect(bodies).toHaveLength(1);
      await send();
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain(SIGNATURE);
    });
  }
  test("cancellation after recovery dispatch does not memoize an unread success", async () => {
    const abort = new AbortController();
    const { bodies } = transport(index => {
      if (index === 1) return streamRejection();
      if (index === 2) abort.abort();
      return success();
    });
    try { await send({ abortSignal: abort.signal }); } catch { /* cancelled client read */ }
    expect(bodies).toHaveLength(2);
    expectStripped(bodies[1]);
    await send();
    expect(bodies[2]).toContain(SIGNATURE);
  });
  test("success memo is isolated by thread, credential, destination, and model", async () => {
    const { bodies } = transport(index => index === 1 ? rejection() : success());
    await send();
    expect(bodies).toHaveLength(2);
    await send();
    expectStripped(bodies[2]);
    await send({}, config(), request(true, "separate-search-thread"));
    expect(bodies[3]).toContain(SIGNATURE);
    const credential = config(); credential.providers["anthropic-test"]!.apiKey = "separate-synthetic-key";
    await send({}, credential);
    // A serving-route transition independently strips once; the next stable turn proves no rejection memo crossed identities.
    await send({}, credential); expect(bodies[5]).toContain(SIGNATURE);
    const destination = config(); destination.providers["anthropic-test"]!.baseUrl = "https://other-anthropic.example.test";
    await send({}, destination);
    await send({}, destination); expect(bodies[7]).toContain(SIGNATURE);
    const model = config(); model.providers["anthropic-test"]!.models = ["claude-opus-4-5"];
    const previous = request(); const body = await previous.json(); body.model = "anthropic-test/claude-opus-4-5";
    await send({}, model, new Request(previous.url, { method: "POST", headers: previous.headers, body: JSON.stringify(body) }));
    await send({}, model, new Request(previous.url, { method: "POST", headers: previous.headers, body: JSON.stringify(body) }));
    expect(bodies[9]).toContain(SIGNATURE);
  });

  test("a completed intermediate search cannot memoize an empty final answer", async () => {
    const { bodies, queries } = transport(index => index === 1 ? rejection() : index === 2 ? search()
      : index === 3 ? success("") : success());
    const result = await send();
    expect(result.text).toContain("response.completed");
    expect(queries).toHaveLength(1);
    expect(bodies).toHaveLength(3);
    await send();
    expect(bodies[3]).toContain(SIGNATURE);
  });
  for (const combo of [false, true]) for (const rawSse of [false, true]) {
    test(`successful recovery charges each physical send once (Combo=${combo}, SSE=${rawSse})`, async () => {
      let charges = 0, refunds = 0;
      const budget = createRequestExecutionBudget({ maxTotalModelSends: 2, baseSendAllowance: 2,
        finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, "search-recovery-charged",
      { charge: () => { charges++; return true; }, refund: () => { refunds++; } });
      const options: Parameters<typeof handleResponses>[3] = { sendBudget: budget };
      if (combo) {
        const booking = budget.reserveDispatch({ sendClass: "initial", targetKey: "anthropic-test|https://anthropic.example.test/v1/messages|claude-sonnet-4-5", countedExternally: true });
        if (!booking.allowed) throw new Error("Synthetic initial booking refused");
        options.comboAttempt = true; options.comboInitialSend = { permit: booking.permit };
      }
      const { bodies } = transport(index => index === 1 ? rawSse ? streamRejection() : rejection() : success());
      const result = await send(options);
      expect(result.text).toContain("Recovered search answer");
      expect(bodies).toHaveLength(2);
      expect(budget.used).toBe(2);
      expect(charges).toBe(2);
      expect(refunds).toBe(0);
    });
  }
  for (const rawSse of [false, true]) {
    test(`enforced spend owner refuses unproven recovery even with numeric headroom (SSE=${rawSse})`, async () => {
      const lines: string[] = [];
      const journal: SpendJournal = { read: () => [...lines], append: line => { lines.push(line); },
        rewrite: next => { lines.splice(0, lines.length, ...next); } };
      const ledger = createSpendReservationLedger({ journal, salt: "search-recovery-enforced", policy: {
        ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 1_000_000 },
      } });
      const tracker = createRequestSpendTracker({ provider: "anthropic-test", model: "claude-sonnet-4-5",
        spendPoolId: "anthropic-test", usageLogInputTokens: 10, spendOutputCeilingTokens: 0 }, undefined, ledger);
      const budget = createRequestExecutionBudget(undefined, "search-recovery-enforced", tracker);
      const { bodies } = transport(index => index === 1 ? rawSse ? streamRejection() : rejection() : success());
      const result = await send({ sendBudget: budget });
      expect(budget.spendEnforced).toBe(true);
      expect(bodies).toHaveLength(1);
      expect(result.text).toContain(REJECTION);
      expect(budget.remainingBaseSends(4)).toBeGreaterThan(0);
      await send();
      expect(bodies[1]).toContain(SIGNATURE);
    });
  }
  test("a local retry-budget exception preserves terminal 429 identity", async () => {
    const { bodies } = transport(index => {
      if (index === 1) return streamRejection();
      if (index === 2) throw new SendBudgetExhaustedError("synthetic-search-recovery");
      return success();
    });
    const result = await send();
    expect(bodies).toHaveLength(2);
    expectStripped(bodies[1]);
    const failure = result.text.split("\n").filter(line => line.startsWith("data: {") && line.includes('"type":"response.failed"'))
      .map(line => JSON.parse(line.slice(6)))[0]?.response;
    expect(failure?.error.type).toBe("rate_limit_error");
    expect(failure?.error.code).toBe("request_send_budget_exhausted");
    expect(result.text).not.toContain("Provider unreachable");
    await send();
    expect(bodies[2]).toContain(SIGNATURE);
  });
  test("a non-replayable replacement withholds diagnostics and retains terminal error identity", async () => {
    const diagnostic = "synthetic-private-search-diagnostic";
    const { bodies } = transport(index => {
      if (index === 1) return streamRejection();
      if (index !== 2) return success();
      const response = Response.json({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: diagnostic } }, { status: 400 });
      markResponseNonReplayable(response); return response;
    });
    const result = await send();
    expect(bodies).toHaveLength(2);
    const failure = result.text.split("\n").filter(line => line.startsWith("data: {") && line.includes('"type":"response.failed"'))
      .map(line => JSON.parse(line.slice(6)))[0]?.response;
    expect(result.text).not.toContain(diagnostic);
    expect(failure?.error.code).toBe("context_length_exceeded");
    expect(failure?.retryable).toBe(false);
    await send();
    expect(bodies[2]).toContain(SIGNATURE);
  });

  test("three ordinary search rounds still reach their final answer without recovery", async () => {
    const cfg = config(); delete cfg.webSearchSidecar!.maxSearchesPerTurn;
    const { bodies, queries } = transport(index => index <= 3 ? search(`ws_${index}`, `fixture ${index}`) : success());
    const result = await send({}, cfg);
    expect(result.text).toContain("Recovered search answer");
    expect(bodies).toHaveLength(4);
    expect(queries).toHaveLength(3);
    expect(bodies.every(body => body.includes(SIGNATURE))).toBe(true);
    expect(result.log.activeAttempt?.recoveryKinds ?? []).not.toContain("opaque-blob-rejection");
  });
  test("an HTTP replacement budget exception retains HTTP 429 and its stable code", async () => {
    const { bodies } = transport(index => {
      if (index === 1) return rejection();
      throw new SendBudgetExhaustedError("synthetic-http-search-recovery");
    });
    const result = await send();
    expect(bodies).toHaveLength(2);
    expect(result.response.status).toBe(429);
    expect(JSON.parse(result.text).error).toMatchObject({ type: "rate_limit_error", code: "request_send_budget_exhausted" });
    expect(result.text).not.toContain("Provider unreachable");
  });
  test("an SSE recovery owns a fresh header deadline after the original headers cleared it", async () => {
    const abort = new AbortController();
    const fallback = setTimeout(() => abort.abort(), 1500);
    const cfg = config(); cfg.connectTimeoutMs = 60;
    const { bodies } = transport((index, init) => {
      if (index === 1) return streamRejection();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    try {
      const result = await send({ abortSignal: abort.signal }, cfg);
      expect(bodies).toHaveLength(2);
      expect(abort.signal.aborted).toBe(false);
      expect(result.text).toContain("response-header timeout");
      expect(result.text).toContain("response.failed");
    } finally { clearTimeout(fallback); abort.abort(); }
  }, 3000);
  test("a rejected stream whose cancel never settles cannot hold the replacement hostage", async () => {
    let cancelled = false;
    const abort = new AbortController();
    const fallback = setTimeout(() => abort.abort(), 1500);
    const { bodies } = transport(index => index === 1 ? new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame("error", {
        error: { type: "invalid_request_error", message: REJECTION },
      }))); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }), { headers: { "content-type": "text/event-stream" } }) : success());
    try {
      const result = await send({ abortSignal: abort.signal });
      expect(abort.signal.aborted).toBe(false);
      expect(cancelled).toBe(true);
      expect(bodies).toHaveLength(2);
      expect(result.text).toContain("Recovered search answer");
    } finally { clearTimeout(fallback); abort.abort(); }
  }, 3000);

  test("same-key 429 replay can discover and recover the later signature refusal", async () => {
    const cfg = config(); cfg.providers["anthropic-test"]!.retryOn429 = { attempts: 1, intervalMs: 1, respectRetryAfter: false };
    const { bodies } = transport(index => index === 1
      ? Response.json({ error: { type: "rate_limit_error", message: "Synthetic busy upstream" } }, { status: 429 })
      : index === 2 ? rejection() : success());
    const result = await send({}, cfg);
    expect(result.text).toContain("Recovered search answer");
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toBe(bodies[1]);
    expectStripped(bodies[2]);
    expect(result.log.activeAttempt?.recoveryKinds).toEqual(["rate-limit-429", "opaque-blob-rejection"]);
  });
  test("an HTTP non-replayable replacement keeps its status, stable code, and no-retry header", async () => {
    const { bodies } = transport(index => {
      if (index === 1) return rejection();
      const response = Response.json({ error: { type: "invalid_request_error", code: "context_length_exceeded",
        message: "synthetic-private-http-diagnostic" } }, { status: 400 });
      markResponseNonReplayable(response); return response;
    });
    const result = await send();
    expect(bodies).toHaveLength(2);
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("x-should-retry")).toBe("false");
    expect(JSON.parse(result.text).error).toMatchObject({ type: "invalid_request_error", code: "context_length_exceeded" });
    expect(result.text).not.toContain("synthetic-private-http-diagnostic");
  });

  test("a marked HTTP 200 raw SSE refusal neither replays nor exposes its diagnostic", async () => {
    const diagnostic = "synthetic-private-first-stream-diagnostic";
    const { bodies } = transport(() => {
      const response = sse(frame("error", { error: { type: "invalid_request_error", message: `${REJECTION} ${diagnostic}` } }));
      markResponseNonReplayable(response); return response;
    });
    const result = await send();
    expect(bodies).toHaveLength(1);
    expect(result.text).not.toContain(diagnostic);
    expect(result.text).not.toContain(REJECTION);
    const failure = result.text.split("\n").filter(line => line.startsWith("data: {") && line.includes('"type":"response.failed"'))
      .map(line => JSON.parse(line.slice(6)))[0]?.response;
    expect(failure?.retryable).toBe(false);
    expect(failure?.error.message).toContain("diagnostic withheld");
  });
});

// Signature deltas are replacement snapshots (Anthropic MessageStream), not new blocks.
for (const separateEmptyBlock of [false, true]) test(`search replay keeps latest signature without merging real blocks (empty next block=${separateEmptyBlock})`, async () => {
  const replacementSignature = "SyntheticUpdatedSearchSignature123456==";
  const secondSignature = "SyntheticSecondSearchSignature123456==";
  const initial = (await search().text()).replaceAll('"index":1', separateEmptyBlock ? '"index":2' : '"index":1');
  const marker = frame("content_block_stop", { index: 0 });
  const extra = frame("ping")
    + frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: replacementSignature } })
    + marker
    + (separateEmptyBlock
      ? frame("content_block_start", { index: 1, content_block: { type: "thinking", thinking: "" } })
        + frame("content_block_delta", { index: 1, delta: { type: "signature_delta", signature: secondSignature } })
        + frame("content_block_stop", { index: 1 }) : "");
  const { bodies, queries } = transport(index => index === 1 ? sse(initial.replace(marker, extra)) : success());
  const result = await send();
  expect(result.text).toContain("response.completed");
  expect(bodies).toHaveLength(2);
  expect(queries).toHaveLength(1);
  const replayed = JSON.parse(bodies[1]).messages.find((message: { role: string; content: unknown }) =>
    message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((part: { type: string; id: string }) => part.type === "tool_use" && part.id === "ws_fixture"));
  const blocks = replayed.content.filter((part: { type: string }) => part.type === "thinking");
  expect(blocks).toEqual([
    { type: "thinking", thinking: "search reasoning", signature: replacementSignature },
    ...(separateEmptyBlock ? [{ type: "thinking", thinking: "", signature: secondSignature }] : []),
  ]);
});

function originalBlockStream(blocks: Record<string, unknown>[], corrupt = ""): Response {
  return sse(frame("message_start", { message: { usage: { input_tokens: 2 } } }),
    ...blocks.flatMap((block, index) => [frame("content_block_start", { index, content_block: block }),
      frame("content_block_stop", { index })]), corrupt,
    frame("message_delta", { delta: { stop_reason: "tool_use" } }), frame("message_stop"));
}

test("search continuation preserves raw text boundaries, citations, opaque blocks and parallel original inputs", async () => {
  const original = [
    { type: "text", text: "first", citations: [{ type: "char_location", cited_text: "first", document_index: 0, start_char_index: 0, end_char_index: 5 }] },
    { type: "text", text: "second" },
    { type: "thinking", thinking: "", signature: SIGNATURE },
    { type: "redacted_thinking", data: REDACTED },
    { type: "tool_use", id: "raw_one", name: "web_search", input: { query: "first query", extra_context: { preserve: true } } },
    { type: "tool_use", id: "raw_two", name: "web_search", input: { queries: ["second query"], original: 2 } },
  ];
  const { bodies, queries } = transport(index => index === 1 ? originalBlockStream(original) : success());
  const result = await send();
  expect(result.text).toContain("response.completed");
  expect(queries).toHaveLength(2);
  expect(bodies).toHaveLength(2);
  const messages = JSON.parse(bodies[1]).messages;
  const assistant = messages.findIndex((m: { content: unknown[] }) => Array.isArray(m.content)
    && m.content.some((b: any) => b.id === "raw_one"));
  expect(messages[assistant].content).toEqual(original);
  expect(messages[assistant + 1].content.map((b: any) => b.tool_use_id)).toEqual(["raw_one", "raw_two"]);
});

for (const malformed of ["unknown block", "unknown delta", "missing stop", "duplicate index", "malformed JSON", "missing message stop", "unexpected initial content"]) {
  test(`invalid raw search history fails before search execution: ${malformed}`, async () => {
    let initial = await search().text();
    if (malformed === "unknown block") initial = initial.replace('"type":"thinking","thinking":""', '"type":"server_tool_use","id":"server_side_effect","name":"web_search","input":{}');
    if (malformed === "unknown delta") initial = initial.replace('"type":"thinking_delta"', '"type":"unknown_delta"');
    if (malformed === "missing message stop") initial = initial.replace(frame("message_stop"), "");
    if (malformed === "unexpected initial content") initial = initial.replace('"message":{"usage":{"input_tokens":2}}', '"message":{"content":[{"type":"text","text":"unobserved"}]}');
    if (malformed === "missing stop") initial = initial.replace(frame("content_block_stop", { index: 0 }), "");
    if (malformed === "duplicate index") initial = initial.replaceAll('"index":1', '"index":0');
    if (malformed === "malformed JSON") initial = initial.replace(frame("content_block_stop", { index: 0 }), 'event: content_block_delta\ndata: {broken\n\n' + frame("content_block_stop", { index: 0 }));
    const { bodies, queries } = transport(() => sse(initial));
    const result = await send();
    expect(result.text).toContain("response.failed");
    expect(result.text).toContain("cannot be replayed losslessly");
    expect(bodies).toHaveLength(1);
    expect(queries).toHaveLength(0);
  });
}

test("server tool start fences thinking repair before message completion", async () => {
  const { bodies, queries } = transport(index => index === 1 ? streamRejection(
    frame("message_start", { message: {} }),
    frame("content_block_start", { index: 0, content_block: { type: "server_tool_use", id: "opaque", name: "web_search", input: {} } }),
    frame("content_block_stop", { index: 0 }),
  ) : success());
  const result = await send();
  expect(result.text).toContain("response.failed");
  expect(bodies).toHaveLength(1);
  expect(queries).toHaveLength(0);
});

for (const failedSearch of [false, true]) test(`parallel repeated queries retain original tool turns and existing execution counts (failed=${failedSearch})`, async () => {
  const original = [{ type: "thinking", thinking: "parallel", signature: SIGNATURE },
    ...["repeat_one", "repeat_two"].map(id => ({ type: "tool_use", id, name: "web_search", input: { query: "identical query", extra: id } }))];
  const { bodies, queries } = transport(index => index === 1 ? originalBlockStream(original) : success());
  const installedFetch = globalThis.fetch;
  let failedCount = 0;
  if (failedSearch) globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://api.exa.ai/search") { failedCount++; return Response.json({ error: "synthetic failure" }, { status: 400 }); }
    return installedFetch(input, init);
  }) as typeof fetch;
  const result = await send();
  expect(result.text).toContain("response.completed");
  expect(failedSearch ? failedCount : queries.length).toBe(failedSearch ? 1 : 2);
  expect(bodies).toHaveLength(2);
  const messages = JSON.parse(bodies[1]).messages;
  const index = messages.findIndex((m: any) => m.role === "assistant" && m.content.some((b: any) => b.id === "repeat_one"));
  expect(messages[index].content).toEqual(original);
  expect(messages[index + 1].content.map((b: any) => b.tool_use_id)).toEqual(["repeat_one", "repeat_two"]);
});

test("forced-answer tool calls and empty retry retain bound catalog and nudge positions", async () => {
  const { bodies, queries } = transport(index => index <= 3 ? search(`forced_${index}`, `query ${index}`)
    : index === 4 ? success("") : success());
  const result = await send();
  expect(result.text).toContain("response.completed");
  expect(bodies).toHaveLength(5);
  expect(queries).toHaveLength(2);
  const requests = bodies.map(body => JSON.parse(body));
  for (const current of requests) {
    expect(current.tools).toEqual(requests[0].tools);
    expect(current.system).toEqual(requests[0].system);
  }
  expect(requests[4].tool_choice).toEqual({ type: "none" });
  const withoutCache = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item));
  const prefix = withoutCache(requests[2].messages);
  expect(withoutCache(requests[3].messages).slice(0, prefix.length)).toEqual(prefix);
  expect(withoutCache(requests[4].messages).slice(0, prefix.length)).toEqual(prefix);
  for (const current of requests.slice(2)) {
    expect(JSON.stringify(current.messages).match(/Answer the user's question now using/g)).toHaveLength(1);
  }
});

for (const choice of ["auto", "none", { type: "function", name: "web_search" },
  { type: "allowed_tools", mode: "auto", tools: [{ type: "web_search" }] }]) {
  test(`Opus search wire catalog remains authorized and stable: ${JSON.stringify(choice)}`, async () => {
    const cfg = config(); cfg.providers["anthropic-test"].models = ["claude-opus-5-5"];
    const data = await request().json();
    data.model = "anthropic-test/claude-opus-5-5";
    data.reasoning = { effort: "high" };
    data.tool_choice = choice;
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const { bodies, queries } = transport(index => choice === "none" ? success() : index <= 2 ? search(`choice_${index}`, `query ${index}`)
      : index === 3 ? success("") : success());
    const result = await send({}, cfg, req);
    expect(result.text).toContain("response.completed");
    expect(bodies).toHaveLength(choice === "none" ? 1 : 4);
    expect(queries).toHaveLength(choice === "none" ? 0 : 2);
    const requests = bodies.map(body => JSON.parse(body));
    const names = requests[0].tools.map((tool: any) => tool.name);
    if (choice === "none") expect(names).not.toContain("web_search");
    else expect(names).toContain("web_search");
    if (typeof choice === "object") expect(names).not.toContain("lookup");
    else expect(names).toContain("lookup");
    for (const current of requests) {
      expect(current.tools).toEqual(requests[0].tools);
      expect(current.system).toEqual(requests[0].system);
      expect(current.thinking).toEqual({ type: "adaptive", display: "summarized" });
    }
    expect(requests.at(-1).tool_choice).toEqual({ type: "none" });
  });
}

for (const identity of ["unsafe id", "duplicate", "prior collision"]) test(`search refuses non-replayable tool IDs before execution: ${identity}`, async () => {
  const id = identity === "unsafe id" ? identity : "collision";
  const { bodies, queries } = transport(index => identity === "duplicate" ? originalBlockStream([
    { type: "tool_use", id, name: "web_search", input: { query: "one" } },
    { type: "tool_use", id, name: "web_search", input: { query: "two" } },
  ]) : search(id, `query ${index}`));
  const result = await send();
  expect(result.text).toContain("response.failed");
  expect(bodies).toHaveLength(identity === "prior collision" ? 2 : 1);
  expect(queries).toHaveLength(identity === "prior collision" ? 1 : 0);
});

// All gateway request identifiers in this fixture are synthetic.
const GENERIC_BEDROCK_SIGNATURE_ERROR = "aws_invoke_error: InvokeModelWithResponseStream: operation error Bedrock Runtime: InvokeModelWithResponseStream, https response error StatusCode: 400, RequestID: 11111111-2222-4333-8444-555555555555, ValidationException: ***.***.content.0: Invalid `signature` in `thinking` block (request id: 20260101000000000000000000syntheticABC)";
for (const stream of [true, false]) test(`generic Bedrock HTTP signature refusal stays terminal without stripping (stream=${stream})`, async () => {
  const { bodies, queries } = transport(() => rejection(GENERIC_BEDROCK_SIGNATURE_ERROR));
  const result = await send({}, config(), request(stream));
  expect(bodies).toHaveLength(1);
  expect(queries).toHaveLength(0);
  expect(bodies[0]).toContain(SIGNATURE);
  expect(bodies[0]).toContain(REDACTED);
  expect(result.text).toContain("Invalid `signature` in `thinking` block");
  expect(result.log.activeAttempt?.recoveryKinds ?? []).toEqual([]);
});

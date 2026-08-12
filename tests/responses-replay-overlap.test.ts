/**
 * Regression coverage for previous_response_id expansion overlapping a request
 * that already carries the full conversation (stateless upstreams such as
 * DeepSeek force the client to resend full history every turn). The old
 * unconditional prepend compounded the stored history each turn: 1x -> 2x ->
 * 3x -> ... (observed 1,333,682 input tokens, ~10x the real ~127k conversation,
 * on 2026-08-10). Full-body chained turns must stay 1x, while genuine delta
 * turns must still expand to the stored history plus their delta.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  expandPreviousResponseInput,
  rememberResponseState,
} from "../src/responses/state";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import type { RequestLogContext } from "../src/server/request-log";

setDefaultTimeout(30_000);

const originalFetch = globalThis.fetch;
let testDir: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-replay-overlap-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  clearResponseStateForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearResponseStateForTests();
  rmSync(testDir, { recursive: true, force: true });
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

const userItem = (text: string): Record<string, unknown> => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

const assistantInputItem = (text: string): Record<string, unknown> => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

const assistantOutputItem = (text: string): Record<string, unknown> => ({
  type: "message",
  role: "assistant",
  id: `msg_${text}`,
  status: "completed",
  content: [{ type: "output_text", text }],
});

const MODEL = "deepseek/deepseek-v4-flash";

describe("previous_response_id replay overlap", () => {
  test("full-history chained turns stay 1x across four turns", () => {
    const base = Array.from({ length: 20 }, (_, i) => userItem(`base ${i}`));
    const conversation = [...base, userItem("turn 1")];
    let respId = "resp_0";
    rememberResponseState(
      { model: MODEL, input: conversation },
      { id: respId, status: "completed", output: [assistantOutputItem("a1")] },
      undefined,
      { force: true },
    );
    conversation.push(assistantInputItem("a1"));

    for (let i = 2; i <= 5; i++) {
      conversation.push(userItem(`turn ${i}`));
      const next = { model: MODEL, previous_response_id: respId, input: [...conversation] };
      const expanded = expandPreviousResponseInput(next);
      expect((expanded.input as unknown[]).length).toBe(conversation.length);
      expect(expanded.input).toEqual(conversation);
      respId = `resp_${i}`;
      rememberResponseState(
        expanded,
        { id: respId, status: "completed", output: [assistantOutputItem(`a${i}`)] },
        undefined,
        { force: true },
      );
      conversation.push(assistantInputItem(`a${i}`));
    }
  });

  test("a genuine delta turn still expands to stored history plus its delta", () => {
    const base = Array.from({ length: 20 }, (_, i) => userItem(`base ${i}`));
    rememberResponseState(
      { model: MODEL, input: base },
      { id: "resp_delta", status: "completed", output: [assistantOutputItem("a1")] },
      undefined,
      { force: true },
    );
    const expanded = expandPreviousResponseInput({
      model: MODEL,
      previous_response_id: "resp_delta",
      input: [userItem("delta")],
    });
    expect((expanded.input as unknown[]).length).toBe(base.length + 2);
    expect((expanded.input as unknown[]).slice(0, base.length)).toEqual(base);
    expect((expanded.input as unknown[]).at(-1)).toEqual(userItem("delta"));
  });

  test("stored output-shaped items canonical-match the client input resend", () => {
    rememberResponseState(
      { model: MODEL, input: [userItem("hello")] },
      { id: "resp_shape", status: "completed", output: [assistantOutputItem("hi")] },
      undefined,
      { force: true },
    );
    // The client resend carries the assistant reply as an input item without id/status.
    const full = [userItem("hello"), assistantInputItem("hi"), userItem("next")];
    const expanded = expandPreviousResponseInput({
      model: MODEL,
      previous_response_id: "resp_shape",
      input: full,
    });
    expect(expanded.input).toEqual(full);
  });

  test("canonical keys ignore retained property order", () => {
    const storedItem = {
      type: "message",
      role: "assistant",
      id: "msg_x",
      status: "completed",
      content: [{ type: "output_text", text: "hi" }],
    };
    const resendItem = {
      role: "assistant",
      content: [{ text: "hi", type: "output_text" }],
      type: "message",
    };
    rememberResponseState(
      { model: MODEL, input: [userItem("hello")] },
      { id: "resp_order", status: "completed", output: [storedItem] },
      undefined,
      { force: true },
    );
    const full = [userItem("hello"), resendItem, userItem("next")];
    const expanded = expandPreviousResponseInput({
      model: MODEL,
      previous_response_id: "resp_order",
      input: full,
    });
    expect(expanded.input).toEqual(full);
  });

  test("web_search_call query/queries backfill skew still canonical-matches", () => {
    // #930: history recorded before the bridge emitted both keys carries only
    // `action.query`; the replay-boundary repair (backfillWebSearchQueries) adds
    // `action.queries` on the outbound body. A stored item and the client resend
    // therefore differ by exactly that derived field and must still count as the
    // same history item — otherwise the overlap breaks and the stored history is
    // prepended again, doubling the request on web-search turns.
    const storedSearch: Record<string, unknown> = {
      type: "web_search_call",
      id: "ws_stored",
      status: "completed",
      action: { type: "search", query: "opencodex context bug" },
    };
    const resendSearch: Record<string, unknown> = {
      type: "web_search_call",
      action: {
        type: "search",
        query: "opencodex context bug",
        queries: ["opencodex context bug"],
      },
    };
    rememberResponseState(
      { model: MODEL, input: [userItem("hello")] },
      { id: "resp_websearch", status: "completed", output: [storedSearch] },
      undefined,
      { force: true },
    );
    const full = [userItem("hello"), resendSearch, userItem("next")];
    const expanded = expandPreviousResponseInput({
      model: MODEL,
      previous_response_id: "resp_websearch",
      input: full,
    });
    expect(expanded.input).toEqual(full);
  });

  test("partial prefix keeps stored history and never drops request items", () => {
    const stored = [userItem("u1"), assistantInputItem("a1"), userItem("u2"), assistantInputItem("a2")];
    rememberResponseState(
      { model: MODEL, input: stored },
      { id: "resp_partial", status: "completed", output: [] },
      undefined,
      { force: true },
    );
    const request = [userItem("u1"), userItem("X"), userItem("D")];
    const expanded = expandPreviousResponseInput({
      model: MODEL,
      previous_response_id: "resp_partial",
      input: request,
    });
    const input = expanded.input as unknown[];
    expect(input.slice(0, stored.length)).toEqual(stored);
    // The request's own leading item is a NEW occurrence (it can be a repeated marker or an
    // identical message), so it must survive even though it also matches the stored prefix.
    expect(input.slice(stored.length)).toEqual([userItem("u1"), userItem("X"), userItem("D")]);
  });

  test("a delta as long as the stored history still expands to stored plus every delta item", () => {
    const stored = [userItem("u1"), assistantInputItem("a1"), userItem("u2")];
    rememberResponseState(
      { model: MODEL, input: stored },
      { id: "resp_long_delta", status: "completed", output: [] },
      undefined,
      { force: true },
    );
    // Four new items >= stored's three: request length must NOT be treated as a full resend.
    const request = [userItem("n1"), userItem("n2"), userItem("n3"), userItem("n4")];
    const expanded = expandPreviousResponseInput({
      model: MODEL,
      previous_response_id: "resp_long_delta",
      input: request,
    });
    const input = expanded.input as unknown[];
    expect(input.slice(0, stored.length)).toEqual(stored);
    expect(input.slice(stored.length)).toEqual(request);
  });
});

function statelessDeepseekConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "deepseek",
    providers: {
      deepseek: {
        adapter: "openai-responses",
        baseUrl: "https://api.deepseek.com",
        responsesPath: "/responses",
        authMode: "key",
        apiKey: "sk-test",
        models: ["deepseek-v4-flash"],
        statelessResponses: true,
        modelContextWindows: { "deepseek-v4-flash": 1_000_000 },
      },
    },
  } as OcxConfig;
}

async function postResponses(config: OcxConfig, body: Record<string, unknown>): Promise<Response> {
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    config,
    { model: "", provider: "" } as RequestLogContext,
  );
}

describe("stateless DeepSeek end-to-end replay", () => {
  test("four full-history chained turns reach upstream at 1x every time", async () => {
    const upstreamBodies: unknown[][] = [];
    let nextId = 1;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown[] };
      upstreamBodies.push(body.input ?? []);
      const n = nextId++;
      return Response.json({
        id: `resp_${n}`,
        object: "response",
        status: "completed",
        model: "deepseek-v4-flash",
        output: [assistantOutputItem(`a${n}`)],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const config = statelessDeepseekConfig();
    const conversation = [...Array.from({ length: 20 }, (_, i) => userItem(`base ${i}`)), userItem("turn 1")];
    let respId = "";
    for (let i = 1; i <= 4; i++) {
      if (i > 1) conversation.push(userItem(`turn ${i}`));
      const res = await postResponses(config, {
        model: MODEL,
        ...(respId ? { previous_response_id: respId } : {}),
        input: [...conversation],
      });
      expect(res.status).toBe(200);
      expect(upstreamBodies.at(-1)?.length).toBe(conversation.length);
      conversation.push(assistantInputItem(`a${i}`));
      respId = `resp_${i}`;
    }
    expect(upstreamBodies).toHaveLength(4);
  });

  test("a delta continuation still expands to the full conversation upstream", async () => {
    const upstreamBodies: unknown[][] = [];
    let nextId = 1;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown[] };
      upstreamBodies.push(body.input ?? []);
      const n = nextId++;
      return Response.json({
        id: `resp_${n}`,
        object: "response",
        status: "completed",
        model: "deepseek-v4-flash",
        output: [assistantOutputItem(`a${n}`)],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const config = statelessDeepseekConfig();
    const conversation = Array.from({ length: 20 }, (_, i) => userItem(`base ${i}`));
    await postResponses(config, { model: MODEL, input: [...conversation] });
    expect(upstreamBodies[0]!.length).toBe(conversation.length);
    conversation.push(assistantInputItem("a1"));

    const res = await postResponses(config, {
      model: MODEL,
      previous_response_id: "resp_1",
      input: [userItem("delta")],
    });
    expect(res.status).toBe(200);
    expect(upstreamBodies[1]!.length).toBe(conversation.length + 1);
  });
});

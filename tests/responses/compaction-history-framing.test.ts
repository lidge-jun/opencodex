/** Offline prompt/wire contracts only; these tests do not establish live model behavior. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";
import { CHECKPOINT_CONTINUATION_NOTE, COMPACT_PROMPT, SUMMARY_PREFIX, encodeCompactionSummary } from "../../src/responses/compaction";
import { frameCompactionHistory, HISTORICAL_REQUEST_START, HISTORICAL_REQUEST_END } from "../../src/responses/compaction-history-framing";
import { parseRequest } from "../../src/responses/parser";
import { clearResponseStateForTests, expandPreviousResponseInput, previousResponseReplayPrefixLength, rememberResponseState } from "../../src/responses/state";
import { handleOwnedResponses as handleResponses } from "../helpers/response-replay-owner";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const completed = "Inspect example.txt and report its readability.";
const unfinished = "Continue the authorized review using the edge-case key zebra_42; do not deploy.";
const checkpoint = user(`${SUMMARY_PREFIX}\nThe inspection is complete. The authorized review is unfinished.`);
const later = user("Pause the review. Only explain the remaining steps.");
const history = () => [user(completed), user(unfinished), checkpoint, later];
const gateway: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://gw.example.invalid/v1", authMode: "key", apiKey: "synthetic-key" };

function wire(provider: OcxProviderConfig, body: Record<string, unknown>) {
  const request = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider)).buildRequest(parseRequest(body),
    { headers: new Headers({ authorization: "Bearer synthetic-token" }) });
  return JSON.parse(request.body) as Record<string, unknown>;
}

function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) frozen(child);
  }
  return value;
}

describe("plaintext checkpoint historical framing", () => {
  test("A/B: imperative retained input becomes explicit history without losing unfinished details", () => {
    const body = frozen({ model: "m", instructions: "Existing instruction.", input: history() });
    const before = JSON.stringify(body);
    const after = frameCompactionHistory(body);
    expect(JSON.stringify(body)).toBe(before);
    expect(JSON.stringify(body)).not.toContain(HISTORICAL_REQUEST_START);
    expect(after.input).toHaveLength(body.input.length);
    for (const index of [0, 1]) {
      expect(after.input[index]!.content).toEqual([
        { type: "input_text", text: HISTORICAL_REQUEST_START },
        ...body.input[index]!.content,
        { type: "input_text", text: HISTORICAL_REQUEST_END },
      ]);
    }
    expect(JSON.stringify(after)).toContain("zebra_42"); // Deliberately omitted from the summary.
    expect(after.input[2]).toBe(checkpoint);
    expect(after.input[3]).toBe(later);
    expect(after.instructions).toBe(`Existing instruction.\n\n${CHECKPOINT_CONTINUATION_NOTE}`);
    expect(frameCompactionHistory(after)).toBe(after);
  });

  test("latest checkpoint controls framing; preserves block metadata and every original byte", () => {
    const blocks = [{ type: "text", text: "  first\n", extra: 1 }, { type: "input_text", text: "second\r\n🦓" }];
    const earlier = user(`${SUMMARY_PREFIX}\nEarlier checkpoint.`);
    const input = [user(completed), earlier, { role: "user", content: blocks }, checkpoint, later];
    const after = frameCompactionHistory({ input });
    expect(after.input[1]).toBe(earlier);
    const framedBlocks = after.input[2]!.content as typeof blocks;
    expect(framedBlocks.slice(1, -1)).toEqual(blocks);
    expect(framedBlocks[1]).toBe(blocks[0]);
    expect(after.input[4]).toBe(later);
    const stringInput = { input: [{ role: "user", content: " exact\r\n🦓 " }, checkpoint] };
    expect(frameCompactionHistory(stringInput).input[0]!.content).toBe(`${HISTORICAL_REQUEST_START}\n exact\r\n🦓 \n${HISTORICAL_REQUEST_END}`);
  });

  test("context wrappers, images, files, tools, assistant turns and checkpoints remain unchanged", () => {
    const kept = [user("<environment_context>test</environment_context>"), user("# AGENTS.md instructions"),
      user("# Context from my IDE\ncontext"), user(" "),
      { role: "user", content: [{ type: "input_image", image_url: "data:x" }] },
      { role: "user", content: [{ type: "input_file", file_id: "file_x" }] },
      { role: "assistant", content: "done" },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "done" }];
    const body = { input: [...kept, user(completed), checkpoint] };
    const after = frameCompactionHistory(body);
    expect(after.input.slice(0, kept.length)).toEqual(kept);
    kept.forEach((item, index) => expect(after.input[index]).toBe(item));
  });

  test("no-op controls: no readable checkpoint, opaque state, summarizer, empty candidates", () => {
    for (const input of [
      "direct input", [user(completed)], [checkpoint, later],
      [user(completed), { type: "compaction", encrypted_content: "gAAAA-native" }],
      [user(completed), checkpoint, { type: "compaction_trigger" }],
      [user("<environment_context/>"), checkpoint],
      [user(completed), { role: "assistant", content: `${SUMMARY_PREFIX}\nnot a checkpoint` }],
    ]) {
      const body = { input };
      expect(frameCompactionHistory(body)).toBe(body);
    }
  });

  test("translated parser changes only context; raw body and continuation positions stay canonical", () => {
    const body = frozen({ model: "m", input: history() });
    const parsed = parseRequest(body);
    expect(parsed._rawBody).toBe(body);
    expect(parsed.context.messages).toHaveLength(body.input.length);
    const old = JSON.stringify(parsed.context.messages[0]);
    expect(old).toContain(HISTORICAL_REQUEST_START);
    expect(old).toContain(completed);
    expect(JSON.stringify(parsed.context.messages[1])).toContain("zebra_42");
    expect(JSON.stringify(parsed.context.messages.at(-1))).not.toContain(HISTORICAL_REQUEST_START);
    expect(parsed.context.systemPrompt).toContain(CHECKPOINT_CONTINUATION_NOTE);
  });

  test("client-side compaction after a prior checkpoint stays a summarizer turn", () => {
    // codex-rs local compaction appends its prompt as a user message, with no trigger item.
    for (const content of [COMPACT_PROMPT, [{ type: "input_text", text: COMPACT_PROMPT }]]) {
      const body = frozen({ model: "m", instructions: "Existing instruction.",
        input: [...history(), { role: "user", content }] });
      expect(frameCompactionHistory(body)).toBe(body);
      const parsed = parseRequest(body);
      expect(JSON.stringify(parsed.context.messages)).not.toContain(HISTORICAL_REQUEST_START);
      expect(parsed.context.systemPrompt?.join("\n")).not.toContain(CHECKPOINT_CONTINUATION_NOTE);
      const outbound = wire(gateway, body);
      expect(outbound.input).toEqual(body.input);
      expect(outbound.instructions).toBe(body.instructions);
    }
    const quoted = { input: [...history(), user(`Explain this prompt:\n${COMPACT_PROMPT}`)] };
    expect(JSON.stringify(frameCompactionHistory(quoted).input)).toContain(HISTORICAL_REQUEST_START);
  });

  test("routed Responses frames a projection; both native OpenAI passthrough destinations preserve input", () => {
    const body = frozen({ model: "m", instructions: "Existing instruction.", input: history(), store: true });
    const routed = wire(gateway, body);
    expect(JSON.stringify(routed.input)).toContain(HISTORICAL_REQUEST_START);
    expect(JSON.stringify(routed.input)).toContain("zebra_42");
    expect(routed.instructions).toContain(CHECKPOINT_CONTINUATION_NOTE);
    for (const native of [
      { ...gateway, baseUrl: "https://api.openai.com/v1" },
      { ...gateway, baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const },
    ]) {
      const outbound = wire(native, body);
      expect(outbound.input).toEqual(body.input);
      expect(outbound.instructions).not.toContain(CHECKPOINT_CONTINUATION_NOTE);
    }
    expect(JSON.stringify(body)).not.toContain(HISTORICAL_REQUEST_START);
  });
});

describe("canonical replay and request-path integration", () => {
  let home: string;
  let priorHome: string | undefined;
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;
  beforeEach(() => {
    priorHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-history-framing-"));
    process.env.OPENCODEX_HOME = home;
    clearResponseStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorHome;
  });

  test("previous_response_id deduplicates the original client replay across multiple continuations", () => {
    let input: unknown[] = history();
    for (let turn = 0; turn < 3; turn++) {
      const canonical = { model: "m", input, store: true };
      parseRequest(canonical);
      wire(gateway, canonical);
      const answer = { type: "message", id: `msg_${turn}`, role: "assistant", content: `answer ${turn}` };
      const response = { id: `resp_framing_${turn}`, status: "completed", output: [answer] };
      rememberResponseState(canonical, response);
      const replay = [...input, answer, user(`follow-up ${turn}`)];
      const expanded = expandPreviousResponseInput({ model: "m", previous_response_id: response.id, input: replay }) as { input: unknown[] };
      expect(expanded.input).toEqual(replay);
      expect(previousResponseReplayPrefixLength(expanded)).toBe(input.length + 1);
      const parsed = parseRequest(expanded);
      expect(parsed._continuationConversationMessageIndex).toBe(input.length + 1);
      expect(JSON.stringify(expanded.input)).not.toContain(HISTORICAL_REQUEST_START);
      expect(expanded.input.filter(item => (item as { id?: string }).id === answer.id)).toHaveLength(1);
      input = expanded.input;
    }
  });

  for (const adapter of ["openai-chat", "openai-responses"] as const) {
    test(`${adapter}: real handler frames prompt by default and preserves canonical replay`, async () => {
      releaseSpendHome = acquireOwnedSpendHome();
      const sent: Record<string, unknown>[] = [];
      let turn = 0;
      globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
        sent.push(JSON.parse(request instanceof Request ? await request.clone().text() : String(init?.body)));
        const text = `provider answer ${turn++}`;
        return Response.json(adapter === "openai-chat"
          ? { id: `chat_${turn}`, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
          : { id: `resp_provider_${turn}`, object: "response", status: "completed", output: [{ type: "message", id: `msg_provider_${turn}`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } });
      }) as typeof fetch;
      const config = { defaultProvider: "gw", providers: { gw: { ...gateway, adapter } } } as OcxConfig;
      const send = async (body: Record<string, unknown>) => {
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gw/m", stream: false, store: true, ...body }),
        }), config, { model: "", provider: "" });
        expect(response.status).toBe(200);
        return await response.json() as { id: string; output: unknown[] };
      };
      const first = await send({ input: history() });
      expect(JSON.stringify(sent[0])).toContain(HISTORICAL_REQUEST_START);
      expect(JSON.stringify(sent[0])).toContain("zebra_42");
      const clientReplay = [...history(), ...first.output, user("Explain only.")];
      await send({ previous_response_id: first.id, input: clientReplay });
      const payload = JSON.stringify(sent[1]);
      expect(payload.match(/provider answer 0/g)).toHaveLength(1);
      expect(payload).toContain(HISTORICAL_REQUEST_START);
      expect(payload).toContain("zebra_42");
      expect(payload.indexOf("is unfinished.")).toBeLessThan(payload.lastIndexOf("Explain only."));
    });
  }
});

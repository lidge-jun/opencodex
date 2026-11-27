/** A summary after a checkpoint keeps the ordinary request's cached Anthropic prefix (#7307). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT_CONTINUATION_NOTE, decodeCompactionSummary, encodeCompactionSummary } from "../../src/responses/compaction";
import { HISTORICAL_REQUEST_START } from "../../src/responses/compaction-history-framing";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainCompactionResponseState, installCompactionRoutingAclFixture, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";

type Wire = { tools: unknown[]; system: Array<{ text: string }>; tool_choice?: unknown; messages: unknown[] };

const config = (): OcxConfig => ({ defaultProvider: "custom", cacheRetention: "short", providers: {
  custom: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "synthetic-test-key" },
} } as OcxConfig);

const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
// What Codex replays after one routed compaction: the retained request, the proxy-minted
// checkpoint, then the work that followed it.
const history = [
  user("Inspect sample.txt and report whether it is readable."),
  { type: "compaction", encrypted_content: encodeCompactionSummary("sample.txt was inspected and is readable. Next: review notes.md.") },
  user("Now review notes.md."),
  { type: "function_call", call_id: "read_notes", name: "read", arguments: "{}" },
  { type: "function_call_output", call_id: "read_notes", output: "notes.md: three open items." },
  assistant("notes.md has three open items."),
];

function body(input: unknown[], stream: boolean) {
  return { model: "custom/claude-sonnet-4-6", stream, store: false, instructions: "stable system",
    tools: [{ type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
    tool_choice: "auto", parallel_tool_calls: false, input };
}

function upstream(stream: boolean): Response {
  if (!stream) return Response.json({ id: "msg-summary", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "handoff summary" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
  const events = [
    { type: "message_start", message: { id: "msg-summary", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "handoff summary" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

// Breakpoints move with the new tail, and a breakpoint turns string content into its single text
// block; Anthropic reads both forms as the same prompt, as consecutive ordinary turns already do.
const content = (messages: unknown[]) => JSON.parse(JSON.stringify(messages, (key, value) =>
  key === "cache_control" ? undefined
    : key === "content" && typeof value === "string" ? [{ type: "text", text: value }] : value));

describe("Anthropic compaction after a portable checkpoint", () => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  let home: string;
  let releaseSpendHome: () => void;
  installCompactionRoutingAclFixture();
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-compaction-checkpoint-prefix-"));
    process.env.OPENCODEX_HOME = home;
    releaseSpendHome = acquireOwnedSpendHome();
  });
  afterEach(async () => {
    await drainCompactionResponseState();
    releaseSpendHome();
    await removeCompactionFixture(home);
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
  });

  const send = (input: unknown[], stream: boolean) => handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(input, stream)),
  }), config(), { model: "", provider: "" });

  for (const stream of [false, true]) {
    test(`the summary request repeats the ordinary request's system and framed history (stream=${stream})`, async () => {
      const seen: Wire[] = [];
      globalThis.fetch = (async (_input, init) => {
        const wire = JSON.parse(String(init?.body));
        seen.push(wire);
        return upstream(wire.stream === true);
      }) as typeof fetch;
      // The ordinary request ends on the tool output; the summary extends it with the reply and the trigger.
      await (await send(history.slice(0, -1), stream)).text();
      const text = await (await send([...history, { type: "compaction_trigger" }], stream)).text();
      expect(text).toContain('"type":"compaction"');
      expect(seen).toHaveLength(2);
      const [ordinary, summary] = seen as [Wire, Wire];
      // The ordinary turn is framed: the note in system and the retained request wrapped as history.
      expect(ordinary.system.map(block => block.text).join("\n")).toContain(CHECKPOINT_CONTINUATION_NOTE);
      expect(JSON.stringify(ordinary.messages[0])).toContain(HISTORICAL_REQUEST_START);
      expect(summary.tools).toEqual(ordinary.tools);
      expect(summary.system).toEqual(ordinary.system);
      expect(summary.tool_choice).toEqual(ordinary.tool_choice);
      expect(content(summary.messages).slice(0, ordinary.messages.length)).toEqual(content(ordinary.messages));
      // The appended tail still tells the summarizer to summarize and not to continue.
      expect(JSON.stringify(summary.messages.at(-1))).toContain("Do not call tools or continue the task.");
      const json = stream
        ? JSON.parse(text.split("\n").find(line => line.startsWith("data: ") && line.includes('"type":"response.completed"'))!.slice(6)).response
        : JSON.parse(text);
      expect(decodeCompactionSummary(json.output.at(-1).encrypted_content)).toBe("handoff summary");
    });
  }

  test("a route that does not preserve the prefix keeps the summary free of the continuation note", async () => {
    const cfg = config();
    cfg.providers.custom!.modelAdapters = { "claude-sonnet-4-6": "openai-chat" };
    const seen: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    globalThis.fetch = (async (_input, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { role: "assistant", content: "handoff summary" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body([...history, { type: "compaction_trigger" }], false)),
    }), cfg, { model: "", provider: "" });
    expect((await response.json()).output.at(-1).type).toBe("compaction");
    expect(seen).toHaveLength(1);
    const system = seen[0]!.messages.filter(message => message.role === "system" || message.role === "developer");
    expect(JSON.stringify(system)).not.toContain(CHECKPOINT_CONTINUATION_NOTE);
    // Historical framing is part of the history projection and applies to every remote summary.
    expect(JSON.stringify(seen[0]!.messages)).toContain(HISTORICAL_REQUEST_START);
  });
});

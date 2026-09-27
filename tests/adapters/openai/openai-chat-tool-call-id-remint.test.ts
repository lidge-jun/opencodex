import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { createToolCallIdReminter, reservedToolCallIdsFromHistory } from "../../../src/adapters/openai-chat/tool-call-id-remint";
import { MAX_TOOL_CALL_ID_LENGTH } from "../../../src/adapters/tool-call-id";
import { withUniqueToolCallIds } from "../../../src/adapters/unique-tool-call-ids";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";
import type { OcxMessage } from "../../../src/types";

/**
 * Some upstreams derive a tool-call id from the call's position in the response and therefore mint
 * the same `call-0-0` on every turn. A client that already paired that id with an earlier call drops
 * the duplicate, the turn collapses to an assistant message with no content, and the model re-issues
 * the call forever. The reminter makes the second and later occurrences unique.
 */
describe("createToolCallIdReminter", () => {
  test("keeps the first occurrence byte-identical", () => {
    const remint = createToolCallIdReminter(["call_already_stored"]);

    expect(remint("call_fresh")).toBe("call_fresh");
    expect(remint("call_already_stored")).not.toBe("call_already_stored");
  });

  test("deduplicates the positional id an upstream repeats every turn", () => {
    const emitted: string[] = [];
    const history: string[] = [];
    for (let turn = 0; turn < 4; turn++) {
      const remint = createToolCallIdReminter(history);
      const wire = remint("call-0-0");
      emitted.push(wire);
      history.push(wire);
    }

    expect(emitted).toEqual(["call-0-0", "call-0-0-2", "call-0-0-3", "call-0-0-4"]);
    expect(new Set(emitted).size).toBe(4);
  });

  test("avoids a suffix that would read as a batch sub-call of an earlier id", () => {
    const remint = createToolCallIdReminter(["call-0-0"]);

    // `<id>_<digits>` is parsed by at least one client as sub-call N of `<id>`, which pairs the
    // result to the wrong call. The rewrite must not land in that family.
    expect(remint("call-0-0")).toBe("call-0-0-2");
  });

  test("repeated occurrences within one response stay distinct", () => {
    const remint = createToolCallIdReminter([]);
    const ids = [remint("call-0-0"), remint("call-0-0"), remint("call-0-0")];

    expect(new Set(ids).size).toBe(3);
  });

  test("keeps repeated-id collision searches linear", () => {
    const remint = createToolCallIdReminter([]);
    const originalHas = Set.prototype.has;
    let probes = 0;
    Set.prototype.has = function (value) {
      probes++;
      return originalHas.call(this, value);
    };

    try {
      for (let index = 0; index < 10_000; index++) remint("call-0-0");
    } finally {
      Set.prototype.has = originalHas;
    }

    expect(probes).toBeLessThan(20_001);
  });

  test("distinct ids sharing a truncated prefix share one collision domain", () => {
    // A candidate keeps at most MAX-2 characters of the base, so ids agreeing on those characters
    // truncate to the same candidate sequence. A per-base cursor restarts each of them at -2:
    // M such ids emitted twice cost ~M²/2 probes. The cursor has to live on the shared domain.
    const remint = createToolCallIdReminter([]);
    const originalHas = Set.prototype.has;
    let probes = 0;
    Set.prototype.has = function (value) {
      probes++;
      return originalHas.call(this, value);
    };

    // Conforming 64-char ids and overlength non-conforming ones, all agreeing on `prefix`.
    const prefix = "p".repeat(MAX_TOOL_CALL_ID_LENGTH - 2);
    const rawIds = [
      ...Array.from({ length: 1_000 }, (_, i) => prefix + i.toString(36).padStart(2, "0")),
      ...Array.from({ length: 500 }, (_, i) => `${prefix}:${i}`),
    ];
    const emitted: string[] = [];
    try {
      for (let round = 0; round < 2; round++) {
        for (const rawId of rawIds) emitted.push(remint(rawId));
      }
    } finally {
      Set.prototype.has = originalHas;
    }

    // First occurrences pass through byte-identical; each repeat draws the domain's next suffix.
    expect(emitted.slice(0, rawIds.length)).toEqual(rawIds);
    for (const [index, id] of emitted.slice(rawIds.length).entries()) {
      const suffix = `-${index + 2}`;
      expect(id).toBe(prefix.slice(0, MAX_TOOL_CALL_ID_LENGTH - suffix.length) + suffix);
      expect(id.length).toBeLessThanOrEqual(MAX_TOOL_CALL_ID_LENGTH);
    }
    expect(new Set(emitted).size).toBe(emitted.length);
    expect(probes).toBeLessThan(10_000);
  });

  test("suffix widening merges collision domains at the shorter shared prefix", () => {
    // At suffix -<n> with three digits the candidate keeps only MAX-4=60 characters of the base.
    // Distinct 62-char prefixes agreeing on those 60 characters emit identical candidates, so a
    // cursor keyed on the base prefix restarts each of them at -100 — quadratic probes again.
    const remint = createToolCallIdReminter([]);
    const originalHas = Set.prototype.has;
    let probes = 0;
    Set.prototype.has = function (value) {
      probes++;
      return originalHas.call(this, value);
    };

    const shared = "q".repeat(MAX_TOOL_CALL_ID_LENGTH - 4);
    const rawIds = Array.from({ length: 300 }, (_, i) => shared + i.toString(36).padStart(2, "0"));
    const emitted: string[] = [];
    try {
      // Two passes put every id into the -10..-99 suffix band; 33 more rounds reach -<3 digits>.
      for (let round = 0; round < 35; round++) {
        for (const rawId of rawIds) emitted.push(remint(rawId));
      }
    } finally {
      Set.prototype.has = originalHas;
    }

    // First occurrences pass through; every repeat must still mint a distinct, conforming id.
    expect(emitted.slice(0, rawIds.length)).toEqual(rawIds);
    expect(new Set(emitted).size).toBe(emitted.length);
    // One pass-through probe per first occurrence plus one probe per minted candidate, not one
    // per already-occupied slot under the shared domain.
    expect(probes).toBeLessThan(150_000);
  });

  test("skips a suffix the reserved set already occupies", () => {
    const remint = createToolCallIdReminter(["call-0-0", "call-0-0-2"]);

    expect(remint("call-0-0")).toBe("call-0-0-3");
  });

  test("every rewritten id is conforming and within the Anthropic length bound", () => {
    const long = "c".repeat(MAX_TOOL_CALL_ID_LENGTH);
    const remint = createToolCallIdReminter([long]);

    const rewritten = remint(long);
    expect(rewritten).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(rewritten.length).toBeLessThanOrEqual(MAX_TOOL_CALL_ID_LENGTH);
  });

  test("sanitizes a non-conforming id rather than dropping it", () => {
    const remint = createToolCallIdReminter(["call:0:0"]);

    const rewritten = remint("call:0:0");
    expect(rewritten).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(rewritten).not.toBe("call:0:0");
  });
});

describe("withUniqueToolCallIds", () => {
  const baseProvider = { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", apiKey: "key" } as const;

  /** An upstream that mints the id from the call's position, so every response repeats `call-0-0`. */
  const positionalUpstream = () => Response.json({
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id: "call-0-0", type: "function", function: { name: "Bash", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    }],
  });

  const buildParsed = (history: OcxMessage[]) => ({
    modelId: "mock-model",
    stream: false,
    options: {},
    context: {
      messages: [
        { role: "user", content: "go", timestamp: 0 },
        ...history,
      ],
      tools: [{ name: "Bash", description: "run", parameters: { type: "object", properties: {} } }],
    },
  }) as never;

  test("a repeated upstream id is rewritten so the client never sees the same id twice", async () => {
    const adapter = withTestTranslatorBudget(withUniqueToolCallIds(createOpenAIChatAdapter(baseProvider)));
    const emitted: string[] = [];
    const history: OcxMessage[] = [];

    // Each turn: build (sees the history), parse (emits the call), then the client stores it.
    for (let turn = 0; turn < 3; turn++) {
      adapter.buildRequest(buildParsed(history));
      const events = await adapter.parseResponse!(positionalUpstream(), createTestTranslatorBudget());
      const started = events.find(event => event.type === "tool_call_start");
      if (started?.type !== "tool_call_start") throw new Error("no tool call emitted");
      emitted.push(started.id);
      history.push({ role: "assistant", content: [{ type: "toolCall", id: started.id, name: "Bash", arguments: "{}" }], timestamp: turn });
    }

    expect(emitted).toEqual(["call-0-0", "call-0-0-2", "call-0-0-3"]);
    expect(new Set(emitted).size).toBe(3);
  });

  test("a first turn with no history emits the upstream id byte-identical", async () => {
    const adapter = withTestTranslatorBudget(withUniqueToolCallIds(createOpenAIChatAdapter(baseProvider)));
    adapter.buildRequest(buildParsed([]));

    const events = await adapter.parseResponse!(positionalUpstream(), createTestTranslatorBudget());
    const started = events.find(event => event.type === "tool_call_start");

    expect(started?.type === "tool_call_start" && started.id).toBe("call-0-0");
  });

  /** The same positional upstream, but framed as an SSE stream: the stream path remints separately. */
  const positionalUpstreamStream = (id: string) => new Response(
    `data: ${JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id, function: { name: "Bash", arguments: '{"command":' } }] },
      }],
    })}\n\n`
    + `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }],
    })}\n\n`
    + `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    })}\n\ndata: [DONE]\n\n`,
  );

  test("the stream path remints a repeated id and keeps each call's event sequence intact", async () => {
    const adapter = withTestTranslatorBudget(withUniqueToolCallIds(createOpenAIChatAdapter(baseProvider)));
    const emitted: string[] = [];
    const history: OcxMessage[] = [];

    // Each turn: build (sees the history), stream (emits the call), then the client stores it.
    for (let turn = 0; turn < 2; turn++) {
      adapter.buildRequest(buildParsed(history));
      const events = [];
      for await (const event of adapter.parseStream(positionalUpstreamStream("call-0-0"), createTestTranslatorBudget())) {
        events.push(event);
      }

      const started = events.find(event => event.type === "tool_call_start");
      if (started?.type !== "tool_call_start") throw new Error("no tool call emitted");
      emitted.push(started.id);

      // The remint must not disturb the deltas or the terminator around it.
      const startIndex = events.indexOf(started);
      const endIndex = events.findIndex(event => event.type === "tool_call_end");
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(endIndex).toBeGreaterThan(startIndex);
      const argumentsParts: string[] = [];
      for (const event of events) {
        if (event.type === "tool_call_delta") argumentsParts.push(event.arguments);
      }
      const arguments_ = argumentsParts.join("");
      expect(arguments_).toBe('{"command":"ls"}');

      history.push({ role: "assistant", content: [{ type: "toolCall", id: started.id, name: "Bash", arguments: arguments_ }], timestamp: turn });
    }

    expect(emitted).toEqual(["call-0-0", "call-0-0-2"]);
    expect(new Set(emitted).size).toBe(2);
  });

  test("a first streamed turn with no history emits the upstream id byte-identical", async () => {
    const adapter = withTestTranslatorBudget(withUniqueToolCallIds(createOpenAIChatAdapter(baseProvider)));
    adapter.buildRequest(buildParsed([]));

    let id: string | undefined;
    for await (const event of adapter.parseStream(positionalUpstreamStream("call-0-0"), createTestTranslatorBudget())) {
      if (event.type === "tool_call_start") id = event.id;
    }

    expect(id).toBe("call-0-0");
  });
});

describe("reservedToolCallIdsFromHistory", () => {
  test("collects both sides of every prior call", () => {
    const history = [
      { role: "assistant", content: [{ type: "toolCall", id: "call-0-0", name: "Bash", arguments: "{}" }], timestamp: 1 },
      { role: "toolResult", toolCallId: "call-0-0", content: "ok", timestamp: 2 },
    ] as unknown as OcxMessage[];

    const reserved = reservedToolCallIdsFromHistory(history);
    expect(reserved.has("call-0-0")).toBe(true);
    expect([...reserved]).toEqual(["call-0-0"]);
  });

  test("ignores a call the client never stored a result for", () => {
    const history = [
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
    ] as unknown as OcxMessage[];

    expect(reservedToolCallIdsFromHistory(history).size).toBe(0);
  });
});

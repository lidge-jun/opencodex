import { describe, expect, test } from "bun:test";
import {
  createResponsesSnapshotBlockRewrite,
  hasResponsesSnapshotRepair,
  repairResponsesSnapshotJson,
} from "../../src/server/responses-snapshot-repair";
import { createGrokResponsesSparseTerminalBlockRewrite } from "../../src/server/grok-responses-snapshot-repair";
import {
  composeSseBlockRewrites,
  payloadRewriteAsBlockRewrite,
  relaySseWithBlockRewrite,
} from "../../src/server/sse-payload-rewrite";
import {
  MAX_COMPLETED_OUTPUT_ITEMS,
  MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES,
} from "../../src/server/relay";
import { createTestTranslatorBudget } from "../helpers/translator-budget";


function dataBlock(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`;
}

function eventsOf(blocks: readonly string[]): Record<string, unknown>[] {
  return blocks.map((block) => JSON.parse(block.replace(/^data: /, "")) as Record<string, unknown>);
}

function typesOf(blocks: readonly string[]): string[] {
  return eventsOf(blocks).map(event => String(event.type));
}

const ISSUE_FIXTURE = {
  created: { type: "response.created", response: { id: "resp_1" } },
  itemAdded: { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  delta: { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "hello" },
  completed: { type: "response.completed", response: { id: "resp_1" } },
};

describe("createGrokResponsesSparseTerminalBlockRewrite", () => {
  test("Grok compatibility backfills explicit empty output from completed items", () => {
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
    const item = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    };
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item }));
    const out = rewrite(dataBlock({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [] },
    }));
    const terminal = eventsOf(out).find(event => event.type === "response.completed")!;
    expect((terminal.response as Record<string, unknown>).output).toEqual([item]);
  });

  test("Grok compatibility preserves explicit empty output when completed items are gapped", () => {
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
    rewrite(dataBlock({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "message",
        id: "msg_2",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "partial", annotations: [] }],
      },
    }));
    const out = rewrite(dataBlock({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [] },
    }));
    const terminal = eventsOf(out).find(event => event.type === "response.completed")!;
    expect((terminal.response as Record<string, unknown>).output).toEqual([]);
  });

  test("Grok compatibility also backfills a missing terminal output", () => {
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
    const item = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    };
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item }));
    const out = rewrite(dataBlock({ type: "response.completed", response: { id: "resp_1" } }));
    const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(terminal.output).toEqual([item]);
  });

  test("Grok compatibility trusts missing ids/status only when semantic content is already valid", () => {
    // The always-on field backfill that follows this rewrite supplies the id,
    // message status, and annotations. The official Codex SSE parser also
    // accepts done items that omit id/status, so absence alone is not a
    // contradiction; malformed values still are.
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
    const item = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hello" }],
    };
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item }));
    const out = rewrite(dataBlock({
      type: "response.completed",
      response: { id: "resp_1", output: [] },
    }));
    const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(terminal.output).toEqual([item]);
  });

  test("Grok compatibility never promotes repaired or contradictory done items", () => {
    const invalidItems = [
      {
        type: "message",
        id: "msg_user",
        role: "user",
        status: "completed",
        content: [{ type: "output_text", text: "bad", annotations: [] }],
      },
      {
        type: "message",
        id: "msg_failed",
        role: "assistant",
        status: "failed",
        content: [{ type: "output_text", text: "bad", annotations: [] }],
      },
      {
        type: "message",
        id: "msg_content",
        role: "assistant",
        status: "completed",
        content: "bad",
      },
      {
        type: "message",
        id: "",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "bad", annotations: [] }],
      },
      {
        type: "message",
        id: 42,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "bad", annotations: [] }],
      },
    ];
    for (const item of invalidItems) {
      const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
      rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item }));
      const out = rewrite(dataBlock({
        type: "response.completed",
        response: { id: "resp_1", output: [] },
      }));
      const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
      expect(terminal.output).toEqual([]);
    }
  });

  test("Grok compatibility treats every duplicate done index as contradictory", () => {
    for (const conflicting of [false, true]) {
      const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
      const first = {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "first", annotations: [] }],
      };
      const second = conflicting
        ? { ...first, id: "msg_2", content: [{ type: "output_text", text: "second", annotations: [] }] }
        : first;
      rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item: first }));
      rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item: second }));
      const out = rewrite(dataBlock({
        type: "response.completed",
        response: { id: "resp_1", output: [] },
      }));
      const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
      expect(terminal.output).toEqual([]);
    }
  });

  test("Grok compatibility requires a real done item, not deltas or an open item", () => {
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
    rewrite(dataBlock({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
    }));
    rewrite(dataBlock({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg_1",
      delta: "visible but not durable",
    }));
    const out = rewrite(dataBlock({
      type: "response.completed",
      response: { id: "resp_1", output: [] },
    }));
    const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(terminal.output).toEqual([]);
  });

  test("Grok compatibility reconstructs a contiguous reasoning-plus-message snapshot", () => {
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      summary: [{ type: "summary_text", text: "summary" }],
      content: [{ type: "reasoning_text", text: "reasoning" }],
      encrypted_content: null,
    };
    const message = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    };
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item: reasoning }));
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 1, item: message }));
    const out = rewrite(dataBlock({
      type: "response.completed",
      response: { id: "resp_1", output: [] },
    }));
    const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(terminal.output).toEqual([reasoning, message]);
  });

  test("Grok compatibility reconstructs a valid function call", () => {
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
    const call = {
      type: "function_call",
      id: "fc_1",
      status: "completed",
      call_id: "call_1",
      name: "search",
      arguments: "{}",
    };
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item: call }));
    const out = rewrite(dataBlock({
      type: "response.completed",
      response: { id: "resp_1", output: [] },
    }));
    const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(terminal.output).toEqual([call]);
  });

  test("Grok compatibility rejects missing, empty, or whitespace function_call call_id", () => {
    const callIds = [undefined, "", "   "] as const;
    for (const callId of callIds) {
      const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
      const call = {
        type: "function_call",
        id: "fc_1",
        status: "completed",
        name: "search",
        arguments: "{}",
        ...(callId === undefined ? {} : { call_id: callId }),
      };
      rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item: call }));
      const out = rewrite(dataBlock({
        type: "response.completed",
        response: { id: "resp_1", output: [] },
      }));
      const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
      expect(terminal.output).toEqual([]);
    }
  });

  test("Grok compatibility rejects missing, empty, or whitespace custom_tool_call call_id even with a visible message", () => {
    const message = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    };
    const callIds = [undefined, "", "   "] as const;
    for (const callId of callIds) {
      const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
      const custom = {
        type: "custom_tool_call",
        id: "ctc_1",
        status: "completed",
        name: "browser",
        input: "{}",
        ...(callId === undefined ? {} : { call_id: callId }),
      };
      rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item: custom }));
      rewrite(dataBlock({ type: "response.output_item.done", output_index: 1, item: message }));
      const out = rewrite(dataBlock({
        type: "response.completed",
        response: { id: "resp_1", output: [] },
      }));
      const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
      expect(terminal.output).toEqual([]);
    }
  });

  test("Grok compatibility reconstructs a valid custom_tool_call with a visible message", () => {
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
    const custom = {
      type: "custom_tool_call",
      id: "ctc_1",
      status: "completed",
      call_id: "call_1",
      name: "browser",
      input: "{}",
    };
    const message = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    };
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item: custom }));
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 1, item: message }));
    const out = rewrite(dataBlock({
      type: "response.completed",
      response: { id: "resp_1", output: [] },
    }));
    const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(terminal.output).toEqual([custom, message]);
  });

  test("Grok compatibility preserves a non-empty terminal snapshot as authoritative", () => {
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
    rewrite(dataBlock({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message", id: "msg_done", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [] }],
      },
    }));
    const canonical = [{
      type: "message", id: "msg_canonical", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "canonical", annotations: [] }],
    }];
    const terminalBlock = dataBlock({
      type: "response.completed",
      response: { id: "resp_1", output: canonical },
    });
    const out = rewrite(terminalBlock);
    expect(out).toEqual([terminalBlock]);
  });

  test("Grok compatibility leaves explicit malformed terminal output fail-closed", () => {
    for (const malformed of [null, "bad", 42, { bad: true }]) {
      const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
      rewrite(dataBlock({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message", id: "msg_1", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
      }));
      const terminalBlock = dataBlock({
        type: "response.completed",
        response: { id: "resp_1", output: malformed },
      });
      expect(rewrite(terminalBlock)).toEqual([terminalBlock]);
    }
  });

  test("Grok compatibility bounds and releases open-item identity state", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(budget);
    for (let outputIndex = 0; outputIndex <= MAX_COMPLETED_OUTPUT_ITEMS; outputIndex++) {
      rewrite(dataBlock({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { type: "message", id: `msg_${outputIndex}` },
      }));
    }
    // The first item beyond the count bound taints and immediately refunds all
    // retained identities; an empty terminal remains authoritative.
    expect(budget.snapshot().currentBytes).toBe(0);
    const terminalBlock = dataBlock({
      type: "response.completed",
      response: { id: "resp_1", output: [] },
    });
    expect(rewrite(terminalBlock)).toEqual([terminalBlock]);
  });

  test("Grok compatibility rejects an oversized retained open identity", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(budget);
    rewrite(dataBlock({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "x".repeat(MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES + 1) },
    }));
    expect(budget.snapshot().currentBytes).toBe(0);
    const terminalBlock = dataBlock({
      type: "response.completed",
      response: { id: "resp_1", output: [] },
    });
    expect(rewrite(terminalBlock)).toEqual([terminalBlock]);
  });

  test("Grok compatibility dispose releases an unfinished open identity", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(budget);
    rewrite(dataBlock({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1" },
    }));
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("Grok compatibility never rewrites failed, incomplete, or contradictory completed terminals", () => {
    for (const terminal of [
      { type: "response.failed", response: { id: "resp_1", output: [] } },
      { type: "response.incomplete", response: { id: "resp_1", output: [] } },
      { type: "response.completed", response: { id: "resp_1", status: "failed", output: [] } },
    ]) {
      const rewrite = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget());
      rewrite(dataBlock({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message", id: "msg_1", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
      }));
      const terminalBlock = dataBlock(terminal);
      expect(rewrite(terminalBlock)).toEqual([terminalBlock]);
    }
  });

  test("Grok sparse repair still fills an empty terminal when composed ahead of provider snapshot repair", () => {
    const done = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    };
    const chain = composeSseBlockRewrites(
      createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget()),
      createResponsesSnapshotBlockRewrite(undefined, createTestTranslatorBudget()),
    );
    chain(dataBlock({ type: "response.output_item.done", output_index: 0, item: done }));
    const out = chain(dataBlock({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [] },
    }));
    const completed = eventsOf(out).find(event => event.type === "response.completed");
    expect(completed).toBeDefined();
    expect((completed!.response as Record<string, unknown>).output).toEqual([done]);
  });
});

describe("createResponsesSnapshotBlockRewrite", () => {
  test("the exact #893 issue fixture yields the full canonical lifecycle and a committed message", () => {
    const rewrite = createResponsesSnapshotBlockRewrite(undefined, createTestTranslatorBudget());
    const out: string[] = [];
    for (const event of [ISSUE_FIXTURE.created, ISSUE_FIXTURE.itemAdded, ISSUE_FIXTURE.delta, ISSUE_FIXTURE.completed]) {
      out.push(...rewrite(dataBlock(event)));
    }
    expect(typesOf(out)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    // Snapshot field backfills.
    const created = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(created.status).toBe("in_progress");
    expect(created.parallel_tool_calls).toBe(true);
    expect(created.tool_choice).toBe("auto");
    expect(created.tools).toEqual([]);
    // The repaired item-added has role/status/content.
    const added = eventsOf(out)[1]!.item as Record<string, unknown>;
    expect(added.role).toBe("assistant");
    expect(added.status).toBe("in_progress");
    expect(Array.isArray(added.content)).toBe(true);
    // The injected done carries the accumulated text.
    const textDone = eventsOf(out)[4]!;
    expect(textDone.text).toBe("hello");
    // The committed done item and terminal output contain the message.
    const doneItem = eventsOf(out)[6]!.item as Record<string, unknown>;
    expect(doneItem.status).toBe("completed");
    const terminal = eventsOf(out)[7]!.response as Record<string, unknown>;
    expect(terminal.status).toBe("completed");
    const output = terminal.output as Record<string, unknown>[];
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ type: "message", id: "msg_1", status: "completed" });
    expect((output[0]!.content as Record<string, unknown>[])[0]).toMatchObject({ text: "hello" });
  });

  test("an explicit output: [] in the terminal snapshot is authoritative (never reconstructed)", () => {
    const rewrite = createResponsesSnapshotBlockRewrite();
    rewrite(dataBlock(ISSUE_FIXTURE.created));
    rewrite(dataBlock(ISSUE_FIXTURE.itemAdded));
    rewrite(dataBlock(ISSUE_FIXTURE.delta));
    const out = rewrite(dataBlock({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [] },
    }));
    const terminal = eventsOf(out).find(event => event.type === "response.completed")!;
    expect((terminal.response as Record<string, unknown>).output).toEqual([]);
  });

  test("already-canonical streams pass through byte-identical", () => {
    const rewrite = createResponsesSnapshotBlockRewrite();
    const canonical = [
      { type: "response.created", response: { id: "r", status: "in_progress", output: [], parallel_tool_calls: true, tool_choice: "auto", tools: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: "m", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "m", output_index: 0, logprobs: [], delta: "hi" },
      { type: "response.output_text.done", item_id: "m", output_index: 0, logprobs: [], text: "hi" },
      { type: "response.content_part.done", item_id: "m", output_index: 0, content_index: 0, part: { type: "output_text", text: "hi", annotations: [] } },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] } },
      { type: "response.completed", response: { id: "r", status: "completed", output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] }], parallel_tool_calls: true, tool_choice: "auto", tools: [] } },
    ];
    const out: string[] = [];
    for (const event of canonical) out.push(...rewrite(dataBlock(event)));
    expect(out).toHaveLength(canonical.length);
    // No injections: exactly the same event type sequence.
    expect(typesOf(out)).toEqual(canonical.map(event => event.type));
  });

  test("malformed JSON and non-data blocks pass through untouched", () => {
    const rewrite = createResponsesSnapshotBlockRewrite();
    expect(rewrite("data: {not json")).toEqual(["data: {not json"]);
    expect(rewrite(": comment-only")).toEqual([": comment-only"]);
  });

  test("a contradictory duplicate open index taints the stream: fail closed, no injection", () => {
    const rewrite = createResponsesSnapshotBlockRewrite();
    rewrite(dataBlock(ISSUE_FIXTURE.itemAdded));
    rewrite(dataBlock(ISSUE_FIXTURE.itemAdded)); // same open output_index reused
    rewrite(dataBlock(ISSUE_FIXTURE.delta));
    const out = rewrite(dataBlock(ISSUE_FIXTURE.completed));
    // Fail closed: the terminal arrives with no injected closing events and no reconstruction.
    expect(typesOf(out)).toEqual(["response.completed"]);
    const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(Object.hasOwn(terminal, "output")).toBe(false);
  });

  test("an oversized completed item taints reconstruction but field repairs continue", () => {
    const rewrite = createResponsesSnapshotBlockRewrite(undefined, createTestTranslatorBudget());
    rewrite(dataBlock({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "big" } }));
    rewrite(dataBlock({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message", id: "big", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "x".repeat(9 * 1024 * 1024), annotations: [] }],
      },
    }));
    const out = rewrite(dataBlock({ type: "response.completed", response: { id: "r" } }));
    expect(typesOf(out)).toEqual(["response.completed"]);
    const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
    // Field backfills still applied, but no output reconstruction.
    expect(terminal.status).toBe("completed");
    expect(Object.hasOwn(terminal, "output")).toBe(false);
  });

  test("gateway-closed items get no injected duplicates", () => {
    const rewrite = createResponsesSnapshotBlockRewrite();
    rewrite(dataBlock(ISSUE_FIXTURE.itemAdded));
    rewrite(dataBlock({ type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    rewrite(dataBlock(ISSUE_FIXTURE.delta));
    rewrite(dataBlock({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: "hello" }));
    rewrite(dataBlock({ type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "hello", annotations: [] } }));
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] } }));
    const out = rewrite(dataBlock(ISSUE_FIXTURE.completed));
    expect(typesOf(out)).toEqual(["response.completed"]);
  });

  test("request defaults fill snapshot fields from the request", () => {
    const rewrite = createResponsesSnapshotBlockRewrite({
      parallel_tool_calls: false,
      tool_choice: { type: "function", name: "search" },
      tools: [{ type: "function", name: "search" }],
    });
    const out = rewrite(dataBlock(ISSUE_FIXTURE.created));
    const response = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(response.parallel_tool_calls).toBe(false);
    expect(response.tool_choice).toEqual({ type: "function", name: "search" });
    expect(response.tools).toEqual([{ type: "function", name: "search" }]);
  });

  test("failed and incomplete terminals never fabricate completed output", () => {
    for (const terminalType of ["response.failed", "response.incomplete"]) {
      const rewrite = createResponsesSnapshotBlockRewrite();
      rewrite(dataBlock(ISSUE_FIXTURE.itemAdded));
      rewrite(dataBlock(ISSUE_FIXTURE.delta));
      const out = rewrite(dataBlock({ type: terminalType, response: { id: "r" } }));
      expect(typesOf(out)).toEqual([terminalType]);
      const response = eventsOf(out)[0]!.response as Record<string, unknown>;
      expect(Object.hasOwn(response, "output")).toBe(false);
      expect(JSON.stringify(out)).not.toContain("output_item.done");
    }
  });

  test("dispose releases retained collectors on EOF without a terminal", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createResponsesSnapshotBlockRewrite(undefined, budget);
    rewrite(dataBlock(ISSUE_FIXTURE.itemAdded));
    rewrite(dataBlock({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] },
    }));
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("function_call items do not taint later sparse messages", () => {
    const rewrite = createResponsesSnapshotBlockRewrite();
    rewrite(dataBlock({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "c1", name: "search" } }));
    rewrite(dataBlock({ ...ISSUE_FIXTURE.itemAdded, output_index: 1 }));
    const fromDelta = rewrite(dataBlock({ ...ISSUE_FIXTURE.delta, output_index: 1, item_id: "msg_1" }));
    const out = [...fromDelta, ...rewrite(dataBlock(ISSUE_FIXTURE.completed))];
    // Message lifecycle completed; the open function_call blocks only reconstruction.
    expect(typesOf(out)).toContain("response.content_part.added");
    expect(typesOf(out)).toContain("response.output_item.done");
    const terminal = eventsOf(out).find(event => event.type === "response.completed")!;
    expect(Object.hasOwn(terminal.response as Record<string, unknown>, "output")).toBe(false);
  });

  test("a mismatched item_id on output_text.done goes fail-closed instead of double-closing", () => {
    // #1025 review blocker 2: this used to ignore the foreign done, leave the
    // item open, and let the terminal synthesize a SECOND output_text.done +
    // output_item.done — a double close on a stream whose identity model we
    // just proved wrong. A contradictory item_id now taints, exactly like a
    // mismatched output_item.done.
    const rewrite = createResponsesSnapshotBlockRewrite();
    rewrite(dataBlock(ISSUE_FIXTURE.itemAdded));
    const foreign = rewrite(dataBlock({ type: "response.output_text.done", item_id: "msg_OTHER", output_index: 0, text: "foreign" }));
    // The contradictory block itself is forwarded untouched, not swallowed.
    expect(eventsOf(foreign).some(event => event.item_id === "msg_OTHER")).toBe(true);
    rewrite(dataBlock(ISSUE_FIXTURE.delta));
    const out = rewrite(dataBlock(ISSUE_FIXTURE.completed));
    // No synthetic closure and no reconstruction after the taint.
    expect(typesOf(out)).not.toContain("response.output_text.done");
    expect(typesOf(out)).not.toContain("response.output_item.done");
    const terminal = eventsOf(out).find(event => event.type === "response.completed")!;
    expect(Object.hasOwn(terminal.response as Record<string, unknown>, "output")).toBe(false);
  });

  test("a mismatched item_id on content_part.done also goes fail-closed", () => {
    // Re-review: fixing output_text.done alone left the sibling terminal open.
    // A foreign content_part.done was ignored, the item stayed open, and the
    // completed terminal fabricated the whole closure sequence
    // (content_part.added → output_text.done → content_part.done →
    // output_item.done) on a stream whose identity model was already wrong.
    const rewrite = createResponsesSnapshotBlockRewrite();
    rewrite(dataBlock(ISSUE_FIXTURE.itemAdded));
    rewrite(dataBlock({
      type: "response.content_part.done",
      item_id: "msg_OTHER",
      output_index: 0,
      part: { type: "output_text", text: "foreign" },
    }));
    rewrite(dataBlock(ISSUE_FIXTURE.delta));
    const out = rewrite(dataBlock(ISSUE_FIXTURE.completed));
    expect(typesOf(out)).not.toContain("response.content_part.added");
    expect(typesOf(out)).not.toContain("response.content_part.done");
    expect(typesOf(out)).not.toContain("response.output_text.done");
    expect(typesOf(out)).not.toContain("response.output_item.done");
    const terminal = eventsOf(out).find(event => event.type === "response.completed")!;
    expect(Object.hasOwn(terminal.response as Record<string, unknown>, "output")).toBe(false);
  });

  test("a mismatched item_id on a text delta goes fail-closed instead of being dropped", () => {
    // Reconstructing from only the deltas we accepted would ship a message the
    // upstream never assembled that way.
    const rewrite = createResponsesSnapshotBlockRewrite();
    rewrite(dataBlock(ISSUE_FIXTURE.itemAdded));
    rewrite(dataBlock({
      type: "response.output_text.delta",
      item_id: "msg_OTHER",
      output_index: 0,
      delta: "foreign",
    }));
    const out = rewrite(dataBlock(ISSUE_FIXTURE.completed));
    expect(typesOf(out)).not.toContain("response.output_item.done");
    const terminal = eventsOf(out).find(event => event.type === "response.completed")!;
    expect(Object.hasOwn(terminal.response as Record<string, unknown>, "output")).toBe(false);
  });

  test("an omitted item_id stays legitimate on every correlated event", () => {
    // The taint must fire on a PRESENT-but-wrong id only. A gateway that omits
    // item_id is common and correlates by output_index alone; breaking that
    // would fail closed on healthy streams.
    const rewrite = createResponsesSnapshotBlockRewrite();
    rewrite(dataBlock(ISSUE_FIXTURE.itemAdded));
    rewrite(dataBlock({ type: "response.content_part.added", output_index: 0, part: { type: "output_text", text: "" } }));
    rewrite(dataBlock({ type: "response.output_text.delta", output_index: 0, delta: "hello" }));
    const out = rewrite(dataBlock(ISSUE_FIXTURE.completed));
    expect(typesOf(out)).toContain("response.output_item.done");
    const injected = eventsOf(out).filter(event => event.type === "response.output_text.done");
    expect(injected.some(event => event.text === "hello")).toBe(true);
  });

  test("a completed terminal with absent output and zero items gets the canonical empty list", () => {
    const rewrite = createResponsesSnapshotBlockRewrite();
    const out = rewrite(dataBlock({ type: "response.completed", response: { id: "r" } }));
    const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(terminal.output).toEqual([]);
  });

  test("a completed terminal with malformed output is replaced canonically", () => {
    for (const malformed of [null, { bogus: true }, "not-an-array"]) {
      const rewrite = createResponsesSnapshotBlockRewrite();
      const out = rewrite(dataBlock({ type: "response.completed", response: { id: "r", output: malformed } }));
      const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
      expect(terminal.output).toEqual([]);
    }
  });

  test("an unterminated final block with injections stays separately framed", async () => {
    // EOF immediately after a complete-but-undelimited block: the injected
    // closing events must not fuse into one invalid data record.
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`${dataBlock(ISSUE_FIXTURE.itemAdded)}\n\n${dataBlock(ISSUE_FIXTURE.delta)}`));
        controller.close();
      },
    });
    const rewrite = createResponsesSnapshotBlockRewrite(undefined, createTestTranslatorBudget());
    const body = relaySseWithBlockRewrite(upstream, rewrite, createTestTranslatorBudget());
    const text = await new Response(body).text();
    const frames = text.split(/\r?\n\r?\n/).filter(frame => frame.trim().length > 0);
    for (const frame of frames) {
      expect(frame.startsWith("data:")).toBe(true);
      expect(frame.indexOf("\ndata:")).toBe(-1);
    }
  });

  test("a done event with a mismatched identity closes nothing and fails closed", () => {
    const rewrite = createResponsesSnapshotBlockRewrite();
    rewrite(dataBlock(ISSUE_FIXTURE.itemAdded)); // tracks msg_1
    rewrite(dataBlock({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_WRONG", status: "completed", content: [{ type: "output_text", text: "wrong", annotations: [] }] },
    }));
    const out = rewrite(dataBlock(ISSUE_FIXTURE.completed));
    // Fail closed: no injection, and the wrong item is never reconstructed.
    expect(typesOf(out)).toEqual(["response.completed"]);
    expect(JSON.stringify(out)).not.toContain("msg_WRONG");
    const terminal = eventsOf(out)[0]!.response as Record<string, unknown>;
    expect(Object.hasOwn(terminal, "output")).toBe(false);
  });

  test("composed chains dispose every child exactly once", () => {
    let disposed = 0;
    const childA = Object.assign((block: string) => [block], { dispose: () => { disposed++; } });
    const childB = Object.assign((block: string) => [block], { dispose: () => { disposed++; } });
    const chain = composeSseBlockRewrites(childA, childB);
    chain.dispose?.();
    chain.dispose?.();
    expect(disposed).toBe(2);
  });
});

describe("repairResponsesSnapshotJson", () => {
  test("backfills missing fields on a non-streaming response", () => {
    const repaired = repairResponsesSnapshotJson(JSON.stringify({ id: "r", output: [] }));
    const parsed = JSON.parse(repaired) as Record<string, unknown>;
    expect(parsed.status).toBe("completed");
    expect(parsed.parallel_tool_calls).toBe(true);
    expect(parsed.output).toEqual([]);
  });

  test("invalid JSON passes through", () => {
    expect(repairResponsesSnapshotJson("{nope")).toBe("{nope");
  });
});

describe("hasResponsesSnapshotRepair", () => {
  test("only explicit true enables", () => {
    expect(hasResponsesSnapshotRepair(true)).toBe(true);
    expect(hasResponsesSnapshotRepair(false)).toBe(false);
    expect(hasResponsesSnapshotRepair(undefined)).toBe(false);
  });
});

describe("relaySseWithBlockRewrite (stream level)", () => {
  test("the issue fixture flows through the relay as the full canonical sequence", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of [ISSUE_FIXTURE.created, ISSUE_FIXTURE.itemAdded, ISSUE_FIXTURE.delta, ISSUE_FIXTURE.completed]) {
          controller.enqueue(encoder.encode(`${dataBlock(event)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const rewrite = createResponsesSnapshotBlockRewrite(undefined, createTestTranslatorBudget());
    const body = relaySseWithBlockRewrite(upstream, rewrite, createTestTranslatorBudget());
    const text = await new Response(body).text();
    const sequence = [...text.matchAll(/"type":"([^"]+)"/g)].map(match => match[1]);
    for (const expected of [
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]) {
      expect(sequence).toContain(expected);
    }
    expect(text).toContain("data: [DONE]");
  });

  test("composition: payload rewrite then lifecycle repair", async () => {
    const chain = composeSseBlockRewrites(
      payloadRewriteAsBlockRewrite(payload => payload.replace("hello", "hola")),
      createResponsesSnapshotBlockRewrite(),
    );
    chain(dataBlock(ISSUE_FIXTURE.itemAdded));
    const out = chain(dataBlock(ISSUE_FIXTURE.delta));
    // content_part.added injected first; the delta's payload got the payload rewrite.
    expect(typesOf(out)).toEqual(["response.content_part.added", "response.output_text.delta"]);
    expect(JSON.stringify(out[1])).toContain("hola");
  });
});

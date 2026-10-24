import { describe, expect, test } from "bun:test";
import type { AdapterEvent } from "../../src/types";
import { guardQoderScaffolding } from "../../src/adapters/qoder/adapter";
import {
  QoderScaffoldFilter,
  QODER_SCAFFOLD_ERROR_CODE,
} from "../../src/adapters/qoder/scaffold-guard";

/**
 * #4190: the qoder route is documented as a text and reasoning surface with the vendor CLI's
 * own tools and MCP servers disabled, yet an MCP lazy-loading reminder listing the operator's
 * configured servers, and vendor tool-call markup with a mismatched closer, reached the
 * client as assistant text.
 */

const REMINDER = "<system-reminder>MCP lazy-loading is active.\n## Connected MCP servers\n"
  + "- internal-notes\n- deploy-keys\nUse mcp_list / mcp_get / mcp_call.</system-reminder>";

const TOOL_MARKUP = "<functions.exec>\n<parameter name=\"cmd\">cd /srv/private && git status</parameter>\n</invoke>";

function collect(): { events: AdapterEvent[]; emit: (event: AdapterEvent) => void } {
  const events: AdapterEvent[] = [];
  return { events, emit: event => { events.push(event); } };
}

function textOf(events: AdapterEvent[]): string {
  return events.map(event => (event.type === "text_delta" ? event.text : "")).join("");
}

describe("QoderScaffoldFilter", () => {
  test("removes a complete reminder block and keeps the answer around it", () => {
    const filter = new QoderScaffoldFilter();
    const first = filter.push(`Before.${REMINDER}After.`);
    expect(first.fail).toBeNull();
    expect(first.text + filter.flush().text).toBe("Before.After.");
  });

  test("uses original-string offsets when Unicode lowercasing would expand", () => {
    const expandingPrefix = "İ".repeat(64);
    const filter = new QoderScaffoldFilter();
    const result = filter.push(`${expandingPrefix}${REMINDER}After.`);
    expect(result.fail).toBeNull();
    expect(result.text + filter.flush().text).toBe(`${expandingPrefix}After.`);
    expect(result.text).not.toContain("internal-notes");
  });

  test("uses original-string offsets to find a closer after expanding Unicode", () => {
    const filter = new QoderScaffoldFilter();
    const result = filter.push(`<system-reminder>${"İ".repeat(64)}</SYSTEM-REMINDER>After.`);
    expect(result.fail).toBeNull();
    expect(result.text + filter.flush().text).toBe("After.");
  });

  test("catches a marker split across deltas", () => {
    const filter = new QoderScaffoldFilter();
    // The opening tag arrives in three pieces; a per-delta scan would miss it entirely.
    const parts = ["Answer. <system", "-remin", "der>secret server list</system-reminder> Done."];
    const out = parts.map(part => filter.push(part));
    expect(out.every(result => result.fail === null)).toBe(true);
    expect(out.map(result => result.text).join("") + filter.flush().text).toBe("Answer.  Done.");
    expect(out.map(result => result.text).join("")).not.toContain("secret server list");
  });

  test("releases a held tail that never became a marker", () => {
    const filter = new QoderScaffoldFilter();
    // "<" is a live marker prefix, so it cannot be forwarded until the stream ends.
    const pushed = filter.push("compare a < b and a <s");
    expect(pushed.text).toBe("compare a < b and a ");
    expect(filter.flush().text).toBe("<s");
  });

  test("fails closed on vendor tool-call markup, keeping the text that preceded it", () => {
    const filter = new QoderScaffoldFilter();
    const result = filter.push(`Checking the repositories.\n${TOOL_MARKUP}`);
    expect(result.text).toBe("Checking the repositories.\n");
    expect(result.fail).toContain("<functions.");
    // The refusal names the marker class only; the command never travels with it.
    expect(result.fail).not.toContain("git status");
  });

  test("fails closed on a closer with no opener", () => {
    // The block it belonged to was already partly forwarded, or never existed.
    expect(new QoderScaffoldFilter().push("tail</system-reminder>").fail).toContain("</system-reminder>");
  });

  test("does not forward the region between a suppressed block and a refusal", () => {
    // The text before the FIRST marker is the model's answer and is kept. The text after a
    // block this filter already swallowed is the vendor's own narration, and in the reported
    // leak that region is the MCP server list itself.
    const filter = new QoderScaffoldFilter();
    const result = filter.push(
      `<system-reminder>a</system-reminder>\n## Connected MCP servers\n- deploy-keys</system-reminder>`,
    );
    expect(result.text).toBe("");
    expect(result.text).not.toContain("deploy-keys");
    expect(result.fail).toContain("</system-reminder>");
  });

  test("does not forward vendor narration that sits between a reminder and tool markup", () => {
    const filter = new QoderScaffoldFilter();
    const result = filter.push(`Status.${REMINDER}\n- deploy-keys\n${TOOL_MARKUP}`);
    expect(result.text).toBe("Status.");
    expect(result.text).not.toContain("deploy-keys");
    expect(result.fail).toContain("<functions.");
  });

  test("unwinds a nested reminder instead of ending at the inner closer", () => {
    // Ending at the first closer handed the outer block's remaining body to the client as
    // the model's answer, with a successful terminal and no signal that anything was wrong.
    const filter = new QoderScaffoldFilter();
    const result = filter.push(
      "<system-reminder>outer<system-reminder>inner</system-reminder>\n## Connected MCP servers\n- deploy-keys",
    );
    expect(result.text).toBe("");
    const flushed = filter.flush();
    expect(flushed.text).not.toContain("deploy-keys");
    expect(flushed.fail).toContain("unterminated");
  });

  test("keeps the answer after a nested reminder that does close", () => {
    const filter = new QoderScaffoldFilter();
    const result = filter.push(
      "<system-reminder>o<system-reminder>i</system-reminder>- deploy-keys</system-reminder> Done.",
    );
    expect(result.text).toBe(" Done.");
    expect(result.fail).toBeNull();
  });

  test("counts nesting even when the tags are split across deltas", () => {
    const filter = new QoderScaffoldFilter();
    const parts = ["<system-reminder>o<system-remin", "der>i</system-reminder>- deploy-keys</system-rem", "inder> Done."];
    const out = parts.map(part => filter.push(part));
    expect(out.map(result => result.text).join("")).toBe(" Done.");
    expect(out.every(result => result.fail === null)).toBe(true);
  });

  test("a closer with no opener forwards nothing ahead of it", () => {
    // The prefix of a stray closer is the lost block's body, not an answer that preceded it.
    const filter = new QoderScaffoldFilter();
    const result = filter.push("## Connected MCP servers\n- deploy-keys</system-reminder>");
    expect(result.text).toBe("");
    expect(result.fail).toContain("</system-reminder>");
    expect(new QoderScaffoldFilter().push("cd /srv/private && git status</invoke>").text).toBe("");
  });

  test("catches an invoke block that carries no attributes", () => {
    // "<invoke name=" alone missed "<invoke>", so the command shipped ahead of the refusal.
    const filter = new QoderScaffoldFilter();
    const result = filter.push("Checking.\n<invoke>\ncd /srv/private && git status\n</invoke>");
    expect(result.text).toBe("Checking.\n");
    expect(result.text).not.toContain("git status");
    expect(result.fail).toContain("<invoke>");
  });

  test("folds a Kelvin-sign spelling of invoke the way lowercasing did", () => {
    // U+212A lowercases to an ASCII k in one code unit, so the old lowercased scan caught it.
    const kelvin = "\u212A";
    const filter = new QoderScaffoldFilter();
    const result = filter.push(`Checking.\n<invo${kelvin}e>\ncd /srv/private && git status\n</invo${kelvin}e>`);
    expect(result.text).toBe("Checking.\n");
    expect(result.text).not.toContain("git status");
    expect(result.fail).not.toBeNull();
  });

  test("holds a Kelvin-sign invoke prefix split across deltas", () => {
    const kelvin = "\u212A";
    const filter = new QoderScaffoldFilter();
    const first = filter.push("Checking.\n<invo");
    const second = filter.push(`${kelvin}e>\ncd /srv/private && git status`);
    expect(first.text + second.text).toBe("Checking.\n");
    expect(second.fail).not.toBeNull();
  });

  test("does not open a block on a word that merely starts with the tag name", () => {
    // The opener is matched without its ">", so it needs a token boundary of its own.
    const filter = new QoderScaffoldFilter();
    const result = filter.push("the <system-reminders> are documented");
    expect(result.text + filter.flush().text).toBe("the <system-reminders> are documented");
    expect(result.fail).toBeNull();
  });

  test("fails closed when a reminder is never terminated", () => {
    const filter = new QoderScaffoldFilter();
    expect(filter.push("ok <system-reminder>listing servers").fail).toBeNull();
    expect(filter.flush().fail).toContain("unterminated");
  });

  test("latches: nothing more escapes after the guard trips", () => {
    const filter = new QoderScaffoldFilter();
    expect(filter.push(TOOL_MARKUP).fail).not.toBeNull();
    expect(filter.push("more vendor narration")).toEqual({ text: "", fail: null });
    expect(filter.flush()).toEqual({ text: "", fail: null });
  });
});

describe("guardQoderScaffolding", () => {
  test("never emits a reminder after a Unicode case-folding expansion", () => {
    const { events, emit } = collect();
    const guarded = guardQoderScaffolding(emit);
    const prefix = "İ".repeat(64);
    guarded({ type: "text_delta", text: `${prefix}${REMINDER}` });
    guarded({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe(prefix);
    expect(textOf(events)).not.toContain("internal-notes");
    expect(events[events.length - 1]!.type).toBe("done");
  });

  test("strips the reminder and still completes the turn", () => {
    const { events, emit } = collect();
    const guarded = guardQoderScaffolding(emit);
    guarded({ type: "text_delta", text: `Here is the status.${REMINDER}` });
    guarded({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe("Here is the status.");
    expect(textOf(events)).not.toContain("mcp_call");
    expect(events[events.length - 1]!.type).toBe("done");
  });

  test("flushes the held tail before the terminal event", () => {
    const { events, emit } = collect();
    const guarded = guardQoderScaffolding(emit);
    // Without the flush this answer would arrive truncated, and an answer that is entirely
    // held back would reach the empty-completion guard as a successful but empty turn.
    guarded({ type: "text_delta", text: "1 < 2" });
    guarded({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe("1 < 2");
    expect(events[events.length - 1]!.type).toBe("done");
  });

  test("refuses the turn when tool-call markup leaks, and swallows the vendor's success", () => {
    const { events, emit } = collect();
    const guarded = guardQoderScaffolding(emit);
    guarded({ type: "text_delta", text: `Checking.\n${TOOL_MARKUP}` });
    guarded({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe("Checking.\n");
    const terminal = events[events.length - 1]!;
    expect(terminal.type).toBe("error");
    if (terminal.type !== "error") throw new Error("expected an error terminal");
    expect(terminal.code).toBe(QODER_SCAFFOLD_ERROR_CODE);
    expect(terminal.status).toBe(502);
    expect(terminal.retryable).toBe(false);
    expect(terminal.message).not.toContain("git status");
    expect(terminal.message).not.toContain("mcp_call");
    expect(events.filter(event => event.type === "done")).toHaveLength(0);
  });

  test("guards the reasoning channel independently of the text channel", () => {
    const { events, emit } = collect();
    const guarded = guardQoderScaffolding(emit);
    guarded({ type: "thinking_delta", thinking: `Planning.${REMINDER}Continue.` });
    guarded({ type: "text_delta", text: "Answer." });
    guarded({ type: "done", stopReason: "stop" });
    const thinking = events.filter(event => event.type === "thinking_delta")
      .map(event => event.type === "thinking_delta" ? event.thinking : "").join("");
    expect(thinking).toBe("Planning.Continue.");
    expect(textOf(events)).toBe("Answer.");
  });

  test("forwards the vendor's own error rather than replacing it", () => {
    const { events, emit } = collect();
    const guarded = guardQoderScaffolding(emit);
    guarded({ type: "text_delta", text: "partial <system-reminder>never closed" });
    guarded({ type: "error", message: "Qoder CLI exited with code 118", status: 429 });
    const terminal = events[events.length - 1]!;
    expect(terminal.type).toBe("error");
    if (terminal.type !== "error") throw new Error("expected an error terminal");
    // The vendor said why the turn ended; the guard's job here was only to drop the block.
    expect(terminal.message).toBe("Qoder CLI exited with code 118");
    expect(textOf(events)).toBe("partial ");
  });

  test("passes unrelated events through untouched", () => {
    const { events, emit } = collect();
    const guarded = guardQoderScaffolding(emit);
    guarded({ type: "tool_call_start", id: "call_1", name: "exec" });
    guarded({ type: "done", stopReason: "stop" });
    expect(events.map(event => event.type)).toEqual(["tool_call_start", "done"]);
  });
});


describe("Qoder replay envelope refusal (#7517)", () => {
  for (const marker of ["[Tool call: probe (call_id: call_fixture) with args: ", "[Tool Result]\n", "[Tool Error]\n", "[tool_result]\n", "[Tool Call]\n"]) {
    for (const size of [1, 2, 7, 64]) test(`refuses ${marker.trim()} split in ${size}-character deltas`, () => {
      const { events, emit } = collect();
      const guard = guardQoderScaffolding(emit);
      const text = "Safe answer.\n" + marker + JSON.stringify({ input: "private-fixture\n".repeat(6000) });
      for (let at = 0; at < text.length; at += size) guard({ type: "text_delta", text: text.slice(at, at + size) });
      guard({ type: "done", stopReason: "stop" });
      expect(textOf(events)).toBe("Safe answer.\n");
      expect(events.filter(event => event.type === "error")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "error", code: QODER_SCAFFOLD_ERROR_CODE, status: 502, retryable: false });
      expect(JSON.stringify(events)).not.toContain("private-fixture");
      expect(events.some(event => event.type === "done")).toBe(false);
    });
  }

  for (const marker of ["[Tool Result", "[Tool Call"]) for (const terminal of ["done", "incomplete", "error"] as const) test(`settles trailing ${marker} before ${terminal}`, () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "Safe.\n" + marker });
    const end: AdapterEvent = terminal === "done" ? { type: "done", stopReason: "stop" }
      : terminal === "incomplete" ? { type: "incomplete", reason: "max_output_tokens" }
      : { type: "error", message: "original vendor error", status: 429 };
    guard(end);
    expect(textOf(events)).toBe("Safe.\n");
    expect(events.at(-1)).toMatchObject(terminal === "error" ? end : { type: "error", status: 502, retryable: false });
  });

  test("keeps ordinary marker prose, closed fenced examples and partial nonmarkers", () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    const answer = "[Tool Result] means a returned value.\n```text\n[Tool call: example]\nquoted payload\n```\nFinal [Tool Res";
    for (const text of answer) guard({ type: "text_delta", text });
    guard({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe(answer);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("refuses an unclosed fenced envelope without releasing an overflowing hold", () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "```text\n[Tool call: probe]\n" + "private-fixture".repeat(6000) });
    guard({ type: "done", stopReason: "stop" });
    expect(textOf(events)).not.toContain("[Tool call:");
    expect(textOf(events)).not.toContain("private-fixture");
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, retryable: false });
  });

  test("a tool event settles held text first, so it neither overtakes prose nor leaks after an envelope", () => {
    const tool = (guard: (event: AdapterEvent) => void) => {
      guard({ type: "tool_call_start", id: "call_1", name: "exec" });
      guard({ type: "tool_call_delta", arguments: "{}" });
      guard({ type: "tool_call_end" });
      guard({ type: "done", stopReason: "stop" });
    };
    const prose = collect();
    const guarded = guardQoderScaffolding(prose.emit);
    guarded({ type: "text_delta", text: "Checking:\n[" });
    tool(guarded);
    expect(prose.events.map(event => event.type)).toEqual(["text_delta", "text_delta", "tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
    expect(textOf(prose.events)).toBe("Checking:\n[");
    for (const echo of ["[Tool Result]", "Safe.\n[Tool Error]", "```text\n[Tool call: probe]\nprivate-fixture"]) {
      const refused = collect();
      const guard = guardQoderScaffolding(refused.emit);
      guard({ type: "text_delta", text: echo });
      tool(guard);
      expect(refused.events.some(event => event.type.startsWith("tool_call"))).toBe(false);
      expect(JSON.stringify(refused.events)).not.toContain("private-fixture");
      expect(refused.events.at(-1)).toMatchObject({ type: "error", code: QODER_SCAFFOLD_ERROR_CODE, status: 502, retryable: false });
    }
  });

  test("text after a tool event starts a new line for envelope detection", () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "Working" });
    guard({ type: "tool_call_start", id: "call_1", name: "exec" });
    guard({ type: "tool_call_end" });
    guard({ type: "text_delta", text: "[Tool Result]\nprivate-fixture" });
    guard({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe("Working");
    expect(JSON.stringify(events)).not.toContain("private-fixture");
    expect(events.at(-1)).toMatchObject({ type: "error", code: QODER_SCAFFOLD_ERROR_CODE, status: 502 });
  });

  test("thinking cannot overtake replay-held prose", () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "[" });
    guard({ type: "thinking_delta", thinking: "Reasoning." });
    guard({ type: "done", stopReason: "stop" });
    expect(events).toEqual([
      { type: "text_delta", text: "[" },
      { type: "thinking_delta", thinking: "Reasoning." },
      { type: "done", stopReason: "stop" },
    ]);
  });

  for (const echo of ["[Tool Result]", "```text\n[Tool call: probe]\nprivate-fixture"]) {
    test(`settles ${JSON.stringify(echo)} before thinking`, () => {
      const { events, emit } = collect();
      const guard = guardQoderScaffolding(emit);
      guard({ type: "text_delta", text: echo });
      guard({ type: "thinking_delta", thinking: "Reasoning." });
      guard({ type: "done", stopReason: "stop" });
      expect(events.some(event => event.type === "thinking_delta")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("private-fixture");
      expect(events.at(-1)).toMatchObject({ type: "error", code: QODER_SCAFFOLD_ERROR_CODE, status: 502, retryable: false });
    });
  }

  for (const before of ["Working", "```text\n"]) {
    test(`thinking resets replay line and fence state after ${JSON.stringify(before)}`, () => {
      const { events, emit } = collect();
      const guard = guardQoderScaffolding(emit);
      guard({ type: "text_delta", text: before });
      guard({ type: "thinking_delta", thinking: "Reasoning." });
      guard({ type: "thinking_delta", thinking: "More reasoning." });
      guard({ type: "text_delta", text: "[Tool Result]\nprivate-fixture\n```\n" });
      guard({ type: "done", stopReason: "stop" });
      expect(textOf(events)).toBe(before);
      expect(JSON.stringify(events)).not.toContain("private-fixture");
      expect(events.at(-1)).toMatchObject({ type: "error", code: QODER_SCAFFOLD_ERROR_CODE, status: 502 });
    });
  }

  for (const terminal of ["done", "error"] as const) {
    test(`keeps marker prose with a held vendor prefix across thinking before ${terminal}`, () => {
      const { events, emit } = collect();
      const guard = guardQoderScaffolding(emit);
      guard({ type: "text_delta", text: "[Tool Result]<s" });
      guard({ type: "thinking_delta", thinking: "Reasoning." });
      const end: AdapterEvent = terminal === "done" ? { type: "done", stopReason: "stop" }
        : { type: "error", message: "original vendor error", status: 429 };
      guard(end);
      expect(textOf(events)).toBe("[Tool Result]<s");
      expect(events.at(-1)).toEqual(end);
    });
  }

  test("a thinking boundary does not release a split vendor reminder", () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "Safe.<system" });
    guard({ type: "thinking_delta", thinking: "Reasoning." });
    guard({ type: "text_delta", text: "-reminder>private-fixture</system-reminder>Answer." });
    guard({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe("Safe.Answer.");
    expect(JSON.stringify(events)).not.toContain("private-fixture");
    expect(events.at(-1)?.type).toBe("done");
  });

  test("heartbeats keep a split replay marker in the same text block", () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "[Tool " });
    guard({ type: "heartbeat" });
    guard({ type: "text_delta", text: "Result]\nprivate-fixture" });
    guard({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe("");
    expect(JSON.stringify(events)).not.toContain("private-fixture");
    expect(events.at(-1)).toMatchObject({ type: "error", code: QODER_SCAFFOLD_ERROR_CODE });
  });

  test("preserves multiple thinking cuts within one pending vendor prefix", () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "<" });
    guard({ type: "thinking_delta", thinking: "A" });
    guard({ type: "text_delta", text: "s" });
    guard({ type: "thinking_delta", thinking: "B" });
    guard({ type: "text_delta", text: "x" });
    guard({ type: "done", stopReason: "stop" });
    expect(events).toEqual([
      { type: "text_delta", text: "<" }, { type: "thinking_delta", thinking: "A" },
      { type: "text_delta", text: "s" }, { type: "thinking_delta", thinking: "B" },
      { type: "text_delta", text: "x" }, { type: "done", stopReason: "stop" },
    ]);
  });

  for (const character of ["😀", "𠀀"]) test(`preserves astral character ${character} after a pending vendor boundary`, () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "a <" });
    guard({ type: "thinking_delta", thinking: "Reasoning." });
    guard({ type: "text_delta", text: character });
    guard({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe(`a <${character}`);
    for (const event of events) if (event.type === "text_delta") expect(event.text.isWellFormed()).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  for (const prefix of ["", "a <"]) for (const character of ["😀", "𠀀"]) test(`joins split input ${character} after ${JSON.stringify(prefix)}`, () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: prefix });
    guard({ type: "thinking_delta", thinking: "Before." });
    guard({ type: "text_delta", text: character[0]! });
    guard({ type: "thinking_delta", thinking: "Between." });
    guard({ type: "heartbeat" });
    guard({ type: "text_delta", text: "" });
    guard({ type: "text_delta", text: character[1]! + " suffix" });
    guard({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe(prefix + character + " suffix");
    for (const event of events) if (event.type === "text_delta") expect(event.text.isWellFormed()).toBe(true);
    const scalar = events.findIndex(event => event.type === "text_delta" && event.text.includes(character));
    expect(scalar).toBeGreaterThan(events.findIndex(event => event.type === "thinking_delta" && event.thinking === "Before."));
    expect(scalar).toBeLessThan(events.findIndex(event => event.type === "thinking_delta" && event.thinking === "Between."));
    expect(events.at(-1)?.type).toBe("done");
  });

  test("deferred events stay after a joined scalar and before a fresh replay block", () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "\uD83D" });
    guard({ type: "thinking_delta", thinking: "A" });
    guard({ type: "tool_call_start", id: "call_1", name: "exec" });
    guard({ type: "thinking_delta", thinking: "B" });
    guard({ type: "text_delta", text: "\uDE00[Tool Result]\nprivate-fixture" });
    guard({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe("😀");
    expect(events.map(event => event.type)).toEqual(["text_delta", "thinking_delta", "tool_call_start", "thinking_delta", "error"]);
    expect(JSON.stringify(events)).not.toContain("private-fixture");
    expect(events.at(-1)).toMatchObject({ type: "error", code: QODER_SCAFFOLD_ERROR_CODE });
  });

  for (const terminal of ["done", "incomplete", "error"] as const) test(`settles an unpaired high before ${terminal}`, () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "a <\uD83D" });
    guard({ type: "thinking_delta", thinking: "Reasoning." });
    const end: AdapterEvent = terminal === "done" ? { type: "done", stopReason: "stop" }
      : terminal === "incomplete" ? { type: "incomplete", reason: "max_output_tokens" }
      : { type: "error", message: "original vendor error", status: 429 };
    guard(end);
    expect(textOf(events)).toBe("a <�");
    for (const event of events) if (event.type === "text_delta") expect(event.text.isWellFormed()).toBe(true);
    expect(events.at(-1)).toEqual(end);
    expect(events.at(-2)).toEqual({ type: "thinking_delta", thinking: "Reasoning." });
  });

  for (const [chunks, expected] of [
    [["\uDE00"], "�"], [["\uD83D", "x"], "�x"], [["\uD83D", "\uD83D", "\uDE00"], "�😀"],
  ] as const) test(`replaces unpaired input ${JSON.stringify(chunks)}`, () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    for (const text of chunks) guard({ type: "text_delta", text });
    guard({ type: "done", stopReason: "stop" });
    expect(textOf(events)).toBe(expected);
    for (const event of events) if (event.type === "text_delta") expect(event.text.isWellFormed()).toBe(true);
  });

  test("pending boundaries never release split vendor tool markup", () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "<fun" });
    guard({ type: "thinking_delta", thinking: "Reasoning." });
    guard({ type: "text_delta", text: "ctions.exec>private-fixture" });
    guard({ type: "done", stopReason: "stop" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: QODER_SCAFFOLD_ERROR_CODE, retryable: false });
    expect(JSON.stringify(events)).not.toContain("private-fixture");
  });

  for (const suffix of ["<", "\uD83D"]) for (const terminal of ["done", "incomplete", "error"] as const) test(`withholds held reasoning when draining an envelope with ${JSON.stringify(suffix)} before ${terminal}`, () => {
    const { events, emit } = collect();
    const guard = guardQoderScaffolding(emit);
    guard({ type: "text_delta", text: "```text\n[Tool Result]\npayload" + suffix });
    guard({ type: "thinking_delta", thinking: "<s" });
    const end: AdapterEvent = terminal === "done" ? { type: "done", stopReason: "stop" }
      : terminal === "incomplete" ? { type: "incomplete", reason: "max_output_tokens" }
      : { type: "error", message: "original vendor error", status: 429 };
    guard(end);
    expect(textOf(events)).toBe("```text\n");
    expect(events.some(event => event.type === "thinking_delta")).toBe(false);
    expect(events.at(-1)).toMatchObject(terminal === "error" ? end : { type: "error", code: QODER_SCAFFOLD_ERROR_CODE, retryable: false });
  });

  for (const prefix of ["<s", "\uD83D"]) for (const overflow of ["characters", "events"] as const) {
    test(`bounds deferred boundary ${overflow} after ${JSON.stringify(prefix)} without releasing held content`, () => {
      const { events, emit } = collect();
      const guard = guardQoderScaffolding(emit);
      guard({ type: "text_delta", text: prefix });
      if (overflow === "characters") guard({ type: "thinking_delta", thinking: "private-fixture".repeat(10_000) });
      else for (let index = 0; index < 2_000; index++) guard({ type: "tool_call_end" });
      guard({ type: "done", stopReason: "stop" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", code: QODER_SCAFFOLD_ERROR_CODE, retryable: false });
      expect(JSON.stringify(events)).not.toContain("private-fixture");
    });
  }
});

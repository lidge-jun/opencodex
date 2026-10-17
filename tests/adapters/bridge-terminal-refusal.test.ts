import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import { isTerminalRefusalCode } from "../../src/lib/errors";
import type { AdapterEvent, OcxUsage } from "../../src/types";

/**
 * #4312: codex-rs maps every `response.incomplete` to a retryable stream error and never reads
 * `incomplete_details.retryable`, so an upstream refusal delivered that way is re-sent through the
 * whole stream retry budget. Only `response.failed` with a terminal-refusal `error.code` ends the
 * turn, and only the Responses inbound wire opts into that delivery.
 */
type BridgeOptions = NonNullable<Parameters<typeof bridgeToResponsesSSE>[7]>;
type Frame = { name: string; data: Record<string, any> };

const TERMINALS = new Set(["response.completed", "response.incomplete", "response.failed"]);
const USAGE: OcxUsage = { inputTokens: 120, outputTokens: 7, totalTokens: 127 };
const REFUSAL: AdapterEvent = {
  type: "incomplete",
  reason: "content_filter",
  retryable: false,
  message: 'upstream ended the turn with stop_reason "refusal"',
  usage: USAGE,
};

async function frames(events: AdapterEvent[], options?: BridgeOptions): Promise<Frame[]> {
  async function* source(): AsyncGenerator<AdapterEvent> {
    for (const event of events) yield event;
  }
  const text = await new Response(
    bridgeToResponsesSSE(source(), "routed/model", undefined, undefined, undefined, undefined, 2_000, options),
  ).text();
  return text.split("\n\n").flatMap(frame => {
    const lines = frame.trim().split("\n");
    const name = lines.find(line => line.startsWith("event: "))?.slice(7);
    const data = lines.find(line => line.startsWith("data: "))?.slice(6);
    return name && data ? [{ name, data: JSON.parse(data) as Record<string, any> }] : [];
  });
}

async function terminal(events: AdapterEvent[], options?: BridgeOptions): Promise<Frame> {
  const terminals = (await frames(events, options)).filter(frame => TERMINALS.has(frame.name));
  expect(terminals).toHaveLength(1);
  return terminals[0]!;
}

describe("Responses bridge: terminal upstream refusal", () => {
  test("a non-retryable content filter becomes response.failed with a terminal-refusal code", async () => {
    const statuses: string[] = [];
    const usages: Array<OcxUsage | undefined> = [];
    const frame = await terminal([REFUSAL], {
      terminalRefusalAsFailed: true,
      onTerminal: status => { statuses.push(status); },
      onUsage: usage => { usages.push(usage); },
    });

    expect(frame.name).toBe("response.failed");
    const response = frame.data.response;
    expect(response.status).toBe("failed");
    expect(response.error).toEqual(response.last_error);
    expect(response.error.type).toBe("invalid_request_error");
    expect(response.error.code).toBe("invalid_prompt");
    // The code is what ends the Codex turn, so it must stay inside the set Codex treats as final.
    expect(isTerminalRefusalCode(response.error.code)).toBe(true);
    expect(response.error.message).toContain("refused");
    expect(response.error.message).toContain("will not succeed");
    expect(response.error.message).toContain('stop_reason "refusal"');
    expect(response.error.message).toContain("start a new conversation");
    expect(response.retryable).toBe(false);
    expect(response.incomplete_details).toBeUndefined();
    // A refused turn still consumed tokens.
    expect(response.usage.input_tokens).toBe(120);
    expect(response.usage.output_tokens).toBe(7);
    expect(usages).toEqual([USAGE]);
    expect(statuses).toEqual(["failed"]);
  });

  test("output opened before the refusal is closed the same way as on the incomplete path", async () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "I can" },
      { type: "tool_call_start", id: "call_1", name: "lookup" },
      { type: "tool_call_delta", arguments: '{"q":"par' },
      REFUSAL,
    ];
    const done = (all: Frame[]) => all
      .filter(frame => frame.name === "response.output_item.done")
      .map(frame => [frame.data.item.type, frame.data.item.status]);

    const failed = await frames(events, { terminalRefusalAsFailed: true });
    const incomplete = await frames(events);

    expect(failed.at(-1)?.name).toBe("response.failed");
    expect(incomplete.at(-1)?.name).toBe("response.incomplete");
    expect(done(failed)).toEqual(done(incomplete));
    expect(done(failed)).toEqual([["message", "completed"], ["function_call", "incomplete"]]);
    expect(failed.at(-1)!.data.response.output.map((item: { type: string }) => item.type))
      .toEqual(incomplete.at(-1)!.data.response.output.map((item: { type: string }) => item.type));
  });

  test("a Kiro-shaped refusal is promoted and keeps its end_turn verdict", async () => {
    // src/adapters/kiro/stream.ts: CONTENT_FILTERED / GUARDRAIL_INTERVENED, endTurn false, with
    // continuation state. A failed turn is never remembered, so the state is not handed out.
    const completed: unknown[] = [];
    const frame = await terminal([{
      type: "incomplete",
      reason: "content_filter",
      retryable: false,
      message: "Kiro stopped with CONTENT_FILTERED before an explicit final answer",
      usage: USAGE,
      endTurn: false,
      providerState: { kiro: { conversationId: "conv_1" } },
    }], { terminalRefusalAsFailed: true, onCompletedResponse: response => { completed.push(response); } });

    expect(frame.name).toBe("response.failed");
    expect(frame.data.response.error.code).toBe("invalid_prompt");
    expect(frame.data.response.error.message).toContain("CONTENT_FILTERED");
    expect(frame.data.response.retryable).toBe(false);
    expect(frame.data.response.end_turn).toBe(false);
    expect(completed).toEqual([]);
  });

  test("end_turn is carried only when the adapter set it", async () => {
    const options = { terminalRefusalAsFailed: true };

    expect((await terminal([{ ...REFUSAL, endTurn: true }], options)).data.response.end_turn).toBe(true);
    expect((await terminal([{ ...REFUSAL, endTurn: false }], options)).data.response.end_turn).toBe(false);
    expect("end_turn" in (await terminal([REFUSAL], options)).data.response).toBe(false);
  });

  test("a refusal without an adapter message still says what happened", async () => {
    for (const message of [undefined, "", "   "]) {
      const frame = await terminal(
        [{ type: "incomplete", reason: "content_filter", retryable: false, ...(message !== undefined ? { message } : {}) }],
        { terminalRefusalAsFailed: true },
      );

      expect(frame.name).toBe("response.failed");
      expect(frame.data.response.error.message).toBe(
        "The upstream model refused this request. Retrying with the same conversation context will not succeed; "
        + "change the request or start a new conversation.",
      );
    }
  });

  test("a credential echoed in the adapter message is masked before it reaches the client", async () => {
    // Assembled at runtime so the fixture is not itself a credential-shaped literal.
    const bearer = ["tok", "en", "0123456789", "abcdef"].join("");
    const apiKey = ["sk", "refusal0123456789"].join("-");
    const frame = await terminal([{
      type: "incomplete", reason: "content_filter", retryable: false,
      message: `upstream refused; request carried Authorization: Bearer ${bearer} and api_key=${apiKey}`,
    }], { terminalRefusalAsFailed: true });

    const message: string = frame.data.response.error.message;
    expect(frame.name).toBe("response.failed");
    expect(message).toContain("upstream refused; request carried");
    expect(message).not.toContain(bearer);
    expect(message).not.toContain(apiKey);
    expect(frame.data.response.last_error.message).toBe(message);
  });

  test("without the option the refusal stays response.incomplete", async () => {
    for (const options of [undefined, {}, { terminalRefusalAsFailed: false }] as const) {
      const statuses: string[] = [];
      const frame = await terminal([REFUSAL], { ...options, onTerminal: status => { statuses.push(status); } });

      expect(frame.name).toBe("response.incomplete");
      expect(frame.data.response.status).toBe("incomplete");
      expect(frame.data.response.error).toBeUndefined();
      expect(frame.data.response.incomplete_details).toEqual({
        reason: "content_filter",
        message: 'upstream ended the turn with stop_reason "refusal"',
        retryable: false,
      });
      expect(frame.data.response.usage.input_tokens).toBe(120);
      expect(statuses).toEqual(["incomplete"]);
    }
  });

  test("only an explicit non-retryable content filter is promoted", async () => {
    const stillIncomplete: AdapterEvent[] = [
      { type: "incomplete", reason: "content_filter", usage: USAGE },
      { type: "incomplete", reason: "content_filter", retryable: true, usage: USAGE },
      { type: "incomplete", reason: "max_output_tokens", usage: USAGE },
      // A cap is a legitimate truncation the client may continue, whatever the verdict says.
      { type: "incomplete", reason: "max_output_tokens", retryable: false, usage: USAGE },
      { type: "incomplete", reason: "upstream_stall_timeout", retryable: false },
    ];
    for (const event of stillIncomplete) {
      const frame = await terminal([event], { terminalRefusalAsFailed: true });

      expect(frame.name).toBe("response.incomplete");
      expect(frame.data.response.incomplete_details.reason).toBe((event as { reason: string }).reason);
      expect(frame.data.response.error).toBeUndefined();
    }
  });

  test("a done carrying a filter stop reason is not promoted", async () => {
    const frame = await terminal(
      [{ type: "done", stopReason: "content_filter", usage: USAGE }],
      { terminalRefusalAsFailed: true },
    );

    expect(frame.name).toBe("response.incomplete");
    expect(frame.data.response.incomplete_details.reason).toBe("content_filter");
  });

  test("an adapter error with a terminal-refusal code is marked non-retryable", async () => {
    for (const code of ["invalid_prompt", "misalignment_policy_violation", "bio_policy", "cyber_policy"]) {
      // The verdict belongs to the code: an adapter that claims the refusal is retryable is wrong.
      for (const retryable of [undefined, true]) {
        const frame = await terminal([{
          type: "error", message: "upstream refused the request", status: 400,
          errorType: "invalid_request_error", code,
          ...(retryable !== undefined ? { retryable } : {}),
        }]);

        expect(frame.name).toBe("response.failed");
        expect(frame.data.response.error.code).toBe(code);
        expect(frame.data.response.retryable).toBe(false);
      }
    }
  });

  test("an adapter error with an ordinary code keeps the adapter's own verdict", async () => {
    const base = { type: "error", message: "upstream overloaded", status: 503, errorType: "server_error", code: "server_is_overloaded" } as const;

    expect((await terminal([base])).data.response.retryable).toBeUndefined();
    expect((await terminal([{ ...base, retryable: true }])).data.response.retryable).toBe(true);
    expect((await terminal([{ ...base, retryable: false }])).data.response.retryable).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { encodeChatCompletionSse } from "../../src/protocols/encoders/chat";
import type { AdapterEvent } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// An explicit stallTimeoutSec of 0 disables the stall guard (#5876). The direct client encoders
// run their own beat, so they must honour that too instead of stalling on the first silent tick.
describe("direct client encoder with a disabled stall budget", () => {
  test("silent ticks never end the stream", async () => {
    const ticks: (() => void)[] = [];
    const timers = {
      setInterval: (handler: () => void) => { ticks.push(handler); return ticks.length - 1; },
      clearInterval: () => {},
    };
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    async function* quiet(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "thinking" };
      await gate;
      yield { type: "text_delta", text: " done" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 2 } } as AdapterEvent;
    }
    const stream = encodeChatCompletionSse(quiet(), {
      model: "client-model", translatorBudget: createTestTranslatorBudget(),
      heartbeatMs: 1_000, stallTimeoutSec: 0, timers,
    });
    const text = new Response(stream).text();
    await Bun.sleep(5);
    for (let i = 0; i < 5; i++) for (const tick of ticks) tick();
    release?.();
    const body = await text;
    expect(body).not.toContain("upstream_stall_timeout");
    expect(body).toContain(" done");
    expect(body).toContain("[DONE]");
  });
});

import { describe, expect, test } from "bun:test";
import { encodeChatCompletionSse } from "../../src/protocols/encoders/chat";
import type { AdapterEvent } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// A local upstream resolves an unset stall budget to disabled (#5876): the bridge already
// passed localUpstream through, but the direct client encoders built their encode options
// without it and still applied the 300 s default. These tests pin the encoder-side resolution.
describe("direct client encoder with a local upstream", () => {
  test("an unset budget stays disabled past the 300 s default horizon", async () => {
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
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } as AdapterEvent;
    }
    const stream = encodeChatCompletionSse(quiet(), {
      model: "client-model", translatorBudget: createTestTranslatorBudget(),
      heartbeatMs: 1_000, localUpstream: true, timers,
    });
    const text = new Response(stream).text();
    await Bun.sleep(5);
    // 400 beats at 1 s each is well past the 300 s default the flag must suppress.
    for (let i = 0; i < 400; i++) for (const tick of ticks) tick();
    release?.();
    const body = await text;
    expect(body).not.toContain("upstream_stall_timeout");
    expect(body).toContain(" done");
    expect(body).toContain("[DONE]");
  });

  test("a public upstream with an explicit budget still stalls on silent ticks", async () => {
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
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } as AdapterEvent;
    }
    const stream = encodeChatCompletionSse(quiet(), {
      model: "client-model", translatorBudget: createTestTranslatorBudget(),
      heartbeatMs: 1_000, stallTimeoutSec: 2, timers,
    });
    const text = new Response(stream).text();
    await Bun.sleep(5);
    // 2 s budget at 1 s beats: a few silent ticks must trip the stall watchdog.
    for (let i = 0; i < 5; i++) for (const tick of ticks) tick();
    release?.();
    const body = await text;
    expect(body).toContain("upstream_stall_timeout");
  });
});

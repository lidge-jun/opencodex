import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import { encodeConnectFrame } from "../../../src/adapters/cursor/framing";
import { createLiveCursorTransport } from "../../../src/adapters/cursor/live-transport";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";
import { watchdogMs } from "../../helpers/ci-watchdog";
import type { CursorRunRequest, CursorServerMessage } from "../../../src/adapters/cursor/types";

/**
 * T04 (devlog 260822_senpi_cursor_transfer/110): inbound stream-health watchdog.
 * A turn that received its first frame but then goes silent (or heartbeat-only)
 * must fail at the transport with a typed stall error instead of waiting for the
 * 300s bridge stall watchdog (issue #2210 class).
 */

function agentFrame(message: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]): Uint8Array {
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message)));
}

function textDeltaFrame(textValue: string): Uint8Array {
  return agentFrame({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: textValue }) },
      }),
    },
  });
}

function heartbeatFrame(): Uint8Array {
  return agentFrame({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
      }),
    },
  });
}

function checkpointFrame(): Uint8Array {
  return agentFrame({
    message: {
      case: "conversationCheckpointUpdate",
      value: create(ConversationStateStructureSchema, {}),
    },
  });
}

function turnEndedFrame(): Uint8Array {
  return agentFrame({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
      }),
    },
  });
}

async function withH2Server<T>(
  handler: (stream: http2.ServerHttp2Stream) => void,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http2.createServer();
  server.on("stream", handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP/2 fixture did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function runRequest(): CursorRunRequest {
  return {
    modelId: "composer-2",
    conversationId: "cursor_stream_health_test",
    system: [],
    messages: [{ role: "user", content: "hello" }],
  } as CursorRunRequest;
}

/**
 * A clock the test advances by hand, for the T04 watchdog only.
 *
 * The watchdog's re-arming contract cannot be stated against real timers without also
 * asserting that the machine keeps up: the only way to show a deadline did NOT expire is to
 * keep a synthetic server delivering frames faster than the silence budget for several
 * multiples of it, and a loaded runner that pauses longer than one budget fails the assertion
 * while the watchdog is behaving correctly. Virtual time removes that term. Timers fire only
 * from `advanceTo`, so contention can delay a frame's arrival — which the test waits for —
 * without any deadline passing.
 */
function manualStreamHealthClock() {
  type Pending = { at: number; callback: () => void };
  const pending = new Map<number, Pending>();
  let now = 0;
  let nextHandle = 1;
  return {
    clock: {
      now: () => now,
      setTimeout: (callback: () => void, ms: number) => {
        const handle = nextHandle++;
        pending.set(handle, { at: now + Math.max(0, ms), callback });
        return handle as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        pending.delete(timer as unknown as number);
      },
    },
    /** Move virtual time to `target`, running every timer due at or before it in deadline order. */
    advanceTo(target: number): void {
      // The bound is deliberate. A watchdog that re-armed an ALREADY expired deadline would keep
      // scheduling a zero-delay timer, and this loop is synchronous, so Bun's per-test timeout could
      // never interrupt it: one mutation would wedge the whole lane instead of reddening one case.
      for (let fired = 0; ; fired += 1) {
        if (fired > 1_000) {
          throw new Error("stream-health clock fired 1000 timers without draining: an expired deadline is being re-armed");
        }
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = Math.max(now, target);
    },
    now: () => now,
    armed: () => pending.size,
  };
}

async function drain(
  baseUrl: string,
  knobs: { streamSilenceFailMs?: number; streamHeartbeatOnlyFailMs?: number },
  onFirstText?: () => void,
): Promise<{
  messages: CursorServerMessage[];
  failure?: Error;
}> {
  const transport = createLiveCursorTransport({
    provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
    translatorBudget: createTestTranslatorBudget(),
    firstFrameTimeoutMs: 2_000,
    ...knobs,
  });
  const messages: CursorServerMessage[] = [];
  let failure: Error | undefined;
  try {
    for await (const message of transport.run(runRequest())) {
      messages.push(message);
      if (message.type === "text" && onFirstText) {
        const notify = onFirstText;
        onFirstText = undefined;
        notify();
      }
    }
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  } finally {
    await transport.close?.();
  }
  return { messages, failure };
}

describe("Cursor inbound stream-health watchdog (T04)", () => {
  // Bounds a hung case; no assertion here is stated against elapsed real time, so this
  // never has to cover a synthetic server outrunning a deadline.
  const caseTimeoutMs = watchdogMs(15_000);

  test("silence after the first frame fails the turn with the stall error", async () => {
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(textDeltaFrame("hi")));
      // then: silence — never end the stream
    }, async baseUrl => {
      const { failure } = await drain(baseUrl, { streamSilenceFailMs: 300, streamHeartbeatOnlyFailMs: 10_000 });
      expect(failure).toBeDefined();
      expect(failure!.message).toContain("no inbound frames");
    });
  }, 15_000);

  test("the silence deadline wins when it is the earlier of the two", async () => {
    // The case above proves a genuine stall fails the turn on real timers; it cannot prove WHICH
    // deadline did it, because a longer one arriving later still produces the same message inside
    // the case timeout. That distinction is the `min(silence, progress)` rule, and dropping it
    // would relax production silence detection from 30s to 90s while every real-timer case stayed
    // green. Virtual time pins it: the turn must fail exactly at S, with nothing left armed.
    const virtualSilenceMs = 1_000;
    const virtualHeartbeatOnlyMs = 10 * virtualSilenceMs;
    const timing = manualStreamHealthClock();
    const connected = Promise.withResolvers<http2.ServerHttp2Stream>();
    let armedBeforeDeadline: number | undefined;
    let armedAtDeadline: number | undefined;
    let failure: Error | undefined;
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      connected.resolve(stream);
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: createTestTranslatorBudget(),
        firstFrameTimeoutMs: watchdogMs(15_000),
        streamSilenceFailMs: virtualSilenceMs,
        streamHeartbeatOnlyFailMs: virtualHeartbeatOnlyMs,
        streamHealthClock: timing.clock,
      });
      const iterator = transport.run(runRequest())[Symbol.asyncIterator]();
      try {
        const opened = iterator.next();
        const server = await connected.promise;
        server.write(Buffer.from(textDeltaFrame("hi")));
        let first = await opened;
        while (!first.done && first.value.type !== "text") first = await iterator.next();
        if (first.done) throw new Error("stream ended before the first text arrived");
        // then: silence. One frame stamped both clocks, so S is strictly the earlier deadline.
        timing.advanceTo(virtualSilenceMs - 1);
        armedBeforeDeadline = timing.armed();
        timing.advanceTo(virtualSilenceMs);
        armedAtDeadline = timing.armed();
        // Cross the progress deadline too, so a watchdog that ignored S reports itself instead of
        // leaving this case to hang to its own timeout.
        timing.advanceTo(virtualHeartbeatOnlyMs + 1);
        for (;;) {
          const result = await iterator.next();
          if (result.done) break;
        }
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        await transport.close?.();
      }
    });
    expect(failure).toBeDefined();
    expect(failure!.message).toContain("no inbound frames");
    expect(failure!.message).not.toContain("heartbeat-only");
    // The watchdog identifies itself: the two branches share this prefix.
    expect(failure!.message).toContain("Cursor stream stalled");
    // Armed one tick before S and gone at S: the deadline was S, not the progress budget.
    expect(armedBeforeDeadline).toBe(1);
    expect(armedAtDeadline).toBe(0);
  }, caseTimeoutMs);

  test("liveness-only traffic keeps the silence clock fresh and still fails at the heartbeat-only threshold", async () => {
    // Which clock expires is the contract. Stating it against real timers also states that a real
    // interval outran a real deadline: the case had to keep liveness frames arriving with no gap
    // longer than the silence budget for the whole heartbeat-only window, and a runner that pauses
    // longer than one budget made the SILENCE watchdog win while both watchdogs behaved correctly.
    // Virtual time removes that term — timers fire only from `advanceTo`, so contention can delay a
    // frame's arrival (which this case waits for) without any deadline passing. Same seam #5131 used
    // for the re-arming case below; production budgets and every other timer are untouched.
    const virtualSilenceMs = 1_000;
    const virtualHeartbeatOnlyMs = 2 * virtualSilenceMs;
    const timing = manualStreamHealthClock();
    const connected = Promise.withResolvers<http2.ServerHttp2Stream>();
    const messages: CursorServerMessage[] = [];
    const armedAfterLiveness: number[] = [];
    let armedAfterDeadline: number | undefined;
    let failure: Error | undefined;
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      connected.resolve(stream);
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: createTestTranslatorBudget(),
        // Stays on the real clock: it owns dial and first response, not this contract.
        firstFrameTimeoutMs: watchdogMs(15_000),
        streamSilenceFailMs: virtualSilenceMs,
        streamHeartbeatOnlyFailMs: virtualHeartbeatOnlyMs,
        streamHealthClock: timing.clock,
      });
      const iterator = transport.run(runRequest())[Symbol.asyncIterator]();
      try {
        // The first next() dials and puts the request on the wire.
        const opened = iterator.next();
        const server = await connected.promise;
        const nextOfType = async (
          type: CursorServerMessage["type"],
          pending?: Promise<IteratorResult<CursorServerMessage>>,
        ) => {
          let result = await (pending ?? iterator.next());
          while (!result.done && result.value.type !== type) {
            messages.push(result.value);
            result = await iterator.next();
          }
          if (result.done) throw new Error(`stream ended before a ${type} message arrived`);
          messages.push(result.value);
        };
        // One meaningful frame stamps both clocks and arms the watchdog.
        server.write(Buffer.from(textDeltaFrame("hi")));
        await nextOfType("text", opened);
        // Advance BEFORE writing so each pair lands at that virtual instant, just under the silence
        // deadline the previous frame set. A checkpoint is a progress frame, so it yields a
        // `heartbeat` message; the bare heartbeat frame yields nothing outward. The frame chain is
        // serialized, so awaiting the checkpoint's message proves both were decoded and the
        // watchdog re-armed from the later of them.
        for (const landing of [900, 1_800]) {
          timing.advanceTo(landing);
          server.write(Buffer.from(heartbeatFrame()));
          server.write(Buffer.from(checkpointFrame()));
          await nextOfType("heartbeat");
          armedAfterLiveness.push(timing.armed());
        }
        // Silence was refreshed at 1800 and the progress clock never was, so 2S can only be the
        // heartbeat-only deadline.
        timing.advanceTo(virtualHeartbeatOnlyMs);
        armedAfterDeadline = timing.armed();
        // Had liveness frames wrongly refreshed the progress clock, nothing fires at 2S and the only
        // surviving deadline is silence at 1800 + S. Cross it so this case reports which watchdog won
        // instead of hanging to its own timeout.
        timing.advanceTo(1_800 + virtualSilenceMs + 100);
        for (;;) {
          const result = await iterator.next();
          if (result.done) break;
          messages.push(result.value);
        }
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        await transport.close?.();
      }
    });
    expect(failure).toBeDefined();
    // Say which watchdog won. A bare toContain reported only the expected substring, which reads as
    // "the heartbeat-only watchdog is broken" when the real story was the silence watchdog firing first.
    expect(failure!.message).toContain("heartbeat-only");
    expect(failure!.message).not.toContain("no inbound frames");
    expect(failure!.message).toContain("Cursor stream stalled");
    // The heartbeat-only deadline fired at exactly 2S: nothing was left armed behind it.
    expect(armedAfterDeadline).toBe(0);
    // Liveness frames refreshed the silence clock and left one timer armed, never a stacked pair.
    expect(armedAfterLiveness).toEqual([1, 1]);
    expect(messages.some(message => message.type === "heartbeat")).toBe(true);
  }, caseTimeoutMs);

  test("the progress clock fires on real timers when the silence budget is out of reach", async () => {
    // The firing half needs no seam. With a silence budget two orders of magnitude beyond the
    // progress budget, the only deadline in reach is the progress one, so ordinary load delays this
    // case rather than changing its outcome: a pause long enough to cross 60s of silence as well,
    // and so be reported as silence instead, has already blown the case's own 15s limit. The
    // production default clock (Date.now plus the global timers) stays on the heartbeat-only path.
    // What this pins is that the progress budget alone can fail a turn through that clock, and that
    // the reported branch is selected by which budget was crossed
    // rather than by whether liveness frames were seen. What it cannot state is stated under the
    // injected clock above: that the deadline is the minimum of both clocks, and that liveness
    // frames refresh the silence clock. Both of those are "a deadline did not expire" claims.
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(textDeltaFrame("hi")));
      // then: silence — never end the stream
    }, async baseUrl => {
      const { failure } = await drain(baseUrl, { streamSilenceFailMs: 60_000, streamHeartbeatOnlyFailMs: 600 });
      expect(failure).toBeDefined();
      expect(failure!.message).toContain("heartbeat-only");
      expect(failure!.message).not.toContain("no inbound frames");
    });
  }, 15_000);

  test("meaningful frames keep resetting both clocks; turnEnded finishes cleanly", async () => {
    // Virtual budgets: nothing here is scaled for CI, because no real interval has to beat them.
    const virtualSilenceMs = 1_000;
    const virtualHeartbeatOnlyMs = 2 * virtualSilenceMs;
    const timing = manualStreamHealthClock();
    const connected = Promise.withResolvers<http2.ServerHttp2Stream>();
    const messages: CursorServerMessage[] = [];
    const armedAfterFrame: number[] = [];
    let armedAfterTurnEnded: number | undefined;
    let failure: Error | undefined;
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      connected.resolve(stream);
    }, async baseUrl => {
      const transport = createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
        translatorBudget: createTestTranslatorBudget(),
        // Stays on the real clock: it owns dial and first response, not this contract. Generous
        // so a slow local dial cannot pre-empt the case; a real hang is bounded by the timeout.
        firstFrameTimeoutMs: watchdogMs(15_000),
        streamSilenceFailMs: virtualSilenceMs,
        streamHeartbeatOnlyFailMs: virtualHeartbeatOnlyMs,
        streamHealthClock: timing.clock,
      });
      const iterator = transport.run(runRequest())[Symbol.asyncIterator]();
      try {
        // The first next() dials and puts the request on the wire.
        const opened = iterator.next();
        const server = await connected.promise;
        const textFrame = async (label: string, pending?: Promise<IteratorResult<CursorServerMessage>>) => {
          server.write(Buffer.from(textDeltaFrame(label)));
          let result = await (pending ?? iterator.next());
          while (!result.done && result.value.type !== "text") {
            messages.push(result.value);
            result = await iterator.next();
          }
          if (result.done) throw new Error(`stream ended before the ${label} text arrived`);
          messages.push(result.value);
          // Awaiting the yielded message is the synchronization: noteInboundFrame has run by the
          // time the frame it decoded reaches the consumer, so the re-armed timer is observable.
          armedAfterFrame.push(timing.armed());
        };
        await textFrame("part-0", opened);
        // Every frame lands just under the deadline the previous one set, and the four of them
        // carry virtual time past both non-resetting deadlines (S and 2S). That is the whole
        // claim: each deadline is recomputed from the newest frame, not from the first one.
        const landings = [900, 1_800, 2_700];
        for (let index = 0; index < landings.length; index += 1) {
          timing.advanceTo(landings[index]!);
          await textFrame(`part-${index + 1}`);
        }
        server.write(Buffer.from(turnEndedFrame()));
        server.end();
        for (;;) {
          const result = await iterator.next();
          if (result.done) break;
          messages.push(result.value);
        }
        // Read before close(), which would clear the timer on its own.
        armedAfterTurnEnded = timing.armed();
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      } finally {
        await transport.close?.();
      }
    });
    expect(failure).toBeUndefined();
    // One timer after every frame: the previous one was cleared rather than left stacked.
    expect(armedAfterFrame).toEqual([1, 1, 1, 1]);
    expect(timing.now()).toBeGreaterThan(virtualHeartbeatOnlyMs);
    expect(messages.some(message => message.type === "text")).toBe(true);
    expect(messages.some(message => message.type === "done")).toBe(true);
    // turnEnded disarmed the watchdog, so no deadline survives the turn to fail it later.
    expect(armedAfterTurnEnded).toBe(0);
    timing.advanceTo(timing.now() + 10 * virtualHeartbeatOnlyMs);
    expect(failure).toBeUndefined();
  }, caseTimeoutMs);

  test("turnEnded disarms the watchdog even when the server holds the stream open", async () => {
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(textDeltaFrame("hi")));
      stream.write(Buffer.from(turnEndedFrame()));
      // hold open: the T03 turnEnded close owns this case; the watchdog must not fire first
    }, async baseUrl => {
      const { messages, failure } = await drain(baseUrl, { streamSilenceFailMs: 300, streamHeartbeatOnlyFailMs: 10_000 });
      expect(failure).toBeUndefined();
      expect(messages.some(message => message.type === "done")).toBe(true);
    });
  }, 15_000);

  test("no watchdog before the first frame: the first-frame timeout still owns dial silence", async () => {
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      // no frames at all
    }, async baseUrl => {
      const { failure } = await drain(baseUrl, { streamSilenceFailMs: 60_000, streamHeartbeatOnlyFailMs: 60_000 });
      expect(failure).toBeDefined();
      expect(failure!.message).toContain("before first response");
    });
  }, 15_000);
});

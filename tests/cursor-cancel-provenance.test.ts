import { describe, expect, test } from "bun:test";
import { createLiveCursorTransport } from "../src/adapters/cursor/live-transport";
import {
  classifyCursorError,
  CursorUnexpectedCancelError,
  isCursorBenignCancelError,
} from "../src/adapters/cursor/cursor-errors";
import { resetCursorBlobStateForTests } from "../src/adapters/cursor/native-exec";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { CursorServerMessage } from "../src/adapters/cursor/types";

type OpenFn = (
  encoded: Uint8Array,
  signal: AbortSignal | undefined,
  state: unknown,
  push: (message: CursorServerMessage) => void,
  fail: (error: Error) => void,
  finish: () => void,
) => void;

function cancelError(): Error {
  const err = new Error("stream closed with NGHTTP2_CANCEL");
  (err as { code?: string }).code = "NGHTTP2_CANCEL";
  return err;
}

/**
 * Drive a turn through the transport's fault-injection seam. A literal server-side
 * `stream.close(NGHTTP2_CANCEL)` surfaces as a clean HTTP/2 `end` in a local fixture, so the
 * cancel-shaped FAILURE is injected directly — that is the state the production socket handler
 * reaches when Cursor resets the stream.
 */
async function runCancelTurn(opts: {
  emitTerminalFirst?: boolean;
  suspendFirst?: boolean;
  failWith?: Error;
}): Promise<{ messages: CursorServerMessage[]; failure?: Error }> {
  resetCursorBlobStateForTests();
  const transport = createLiveCursorTransport({
    provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
    translatorBudget: createTestTranslatorBudget(),
    headers: new Headers(),
  });
  let onOpened!: () => void;
  const opened = new Promise<void>(resolve => { onOpened = resolve; });
  let failTurn!: (error: Error) => void;
  let pushEvent!: (message: CursorServerMessage) => void;
  (transport as unknown as { open: OpenFn }).open = (_encoded, _signal, _state, push, fail) => {
    failTurn = fail;
    pushEvent = push;
    onOpened();
  };

  const messages: CursorServerMessage[] = [];
  let failure: Error | undefined;
  const iterator = transport.run({
    modelId: "composer-2.5",
    conversationId: "cursor_cancel_provenance",
    system: ["system"],
    messages: [{ role: "user", content: "hi" }],
  })[Symbol.asyncIterator]();

  const drain = (async () => {
    try {
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        messages.push(next.value);
      }
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
    }
  })();

  await opened;
  if (opts.emitTerminalFirst) pushEvent({ type: "done", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  // The client-tool suspend path cancels our own stream, which sets expectedClose.
  if (opts.suspendFirst) (transport as unknown as { cancelCursorRun(): void }).cancelCursorRun();
  failTurn(opts.failWith ?? cancelError());
  await drain;
  transport.close?.();
  return { messages, failure };
}

describe("Cursor cancel provenance", () => {
  test("a cancel we did not request surfaces as a real transport failure", async () => {
    const { failure } = await runCancelTurn({});

    // Before this change the adapter treated ANY NGHTTP2_CANCEL as benign and returned silently,
    // leaving the turn with zero adapter events — reported as `completed` on the non-streaming path.
    expect(failure).toBeDefined();
    expect(failure).toBeInstanceOf(CursorUnexpectedCancelError);
    // The message must not claim an intentional suspension: that would misdirect diagnosis of a
    // turn that actually failed.
    expect(failure?.message.toLowerCase()).not.toContain("suspend");
    expect(classifyCursorError(failure!.message)).not.toBe("Cursor stream suspended");
  });

  test("a cancel from our own client-tool suspend stays silent", async () => {
    const { failure } = await runCancelTurn({ suspendFirst: true });

    // The regression that matters: every working multi-turn tool cycle ends this way.
    expect(failure).toBeUndefined();
  });

  test("a cancel after a terminal was already emitted does not add a second one", async () => {
    const { messages, failure } = await runCancelTurn({ emitTerminalFirst: true });

    expect(messages.some(m => m.type === "done")).toBe(true);
    // The transport still throws, but as the RAW cancel rather than the typed unexpected-cancel.
    // That distinction is the whole contract: the adapter's benign check (cursor.ts:181) swallows
    // a raw cancel, so no second terminal reaches the bridge and an already-completed buffered
    // response is not flipped to failed.
    expect(failure).toBeDefined();
    expect(failure).not.toBeInstanceOf(CursorUnexpectedCancelError);
    expect(isCursorBenignCancelError(failure)).toBe(true);
  });

  test("an abort after a terminal frame does not re-label a completed turn as failed (#1527)", async () => {
    // Only cancelCursorRun() sets expectedClose, so an ordinary completed turn never
    // qualified for the benign path. The abort listener then failed the turn with
    // "Cursor request was aborted" — which is deliberately NOT a benign cancel — so a turn
    // whose answer had already been delivered still surfaced as turn-failed with
    // expectedClose:false in the request log.
    const { messages, failure } = await runCancelTurn({
      emitTerminalFirst: true,
      failWith: new Error("Cursor request was aborted"),
    });

    expect(messages.some(m => m.type === "done")).toBe(true);
    expect(failure).toBeUndefined();
  });

  test("an abort BEFORE any terminal frame still fails the turn (#1527 guard)", async () => {
    // The narrowing must not swallow a genuine mid-turn abort: nothing was delivered, so
    // the caller has to hear about it.
    const { failure } = await runCancelTurn({ failWith: new Error("Cursor request was aborted") });

    expect(failure).toBeDefined();
    expect(failure?.message).toContain("aborted");
  });
});

describe("isCursorBenignCancelError provenance", () => {
  test("an unexpected-cancel error is never benign, but an untagged one still is", () => {
    expect(isCursorBenignCancelError(new CursorUnexpectedCancelError())).toBe(false);
    // Fallback preserved: nothing that returns silently today starts erroring without evidence.
    expect(isCursorBenignCancelError(cancelError())).toBe(true);
    expect(isCursorBenignCancelError(new Error("Cursor stream suspended"))).toBe(true);
  });

  test("the unexpected-cancel message is not classified as a suspension", () => {
    const classified = classifyCursorError(new CursorUnexpectedCancelError().message);
    expect(classified).not.toBe("Cursor stream suspended");
  });

  test("the wrapper keeps the originating transport code for diagnostics", () => {
    // Wrapping must not blind the per-turn `turn-failed` summary for exactly the failure it
    // exists to explain: without this the one diagnostic that matters has no error code.
    const wrapped = new CursorUnexpectedCancelError(cancelError());
    expect((wrapped as { code?: string }).code).toBe("NGHTTP2_CANCEL");
    // Carrying the code must NOT make it benign again — provenance still wins.
    expect(isCursorBenignCancelError(wrapped)).toBe(false);
  });
});

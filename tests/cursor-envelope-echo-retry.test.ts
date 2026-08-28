import { describe, expect, test } from "bun:test";
import { createCursorAdapter as createCursorAdapterProduction } from "../src/adapters/cursor";
import {
  CURSOR_ECHO_RETRY_CONTINUATION_TEXT,
  CursorEnvelopeEchoSniffer,
  CursorMidstreamEchoObserver,
  CursorRoutingCommentarySniffer,
  MAX_MIDSTREAM_SCAN_LENGTH,
} from "../src/adapters/cursor/envelope-echo";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import type { CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createCursorAdapter = (...args: Parameters<typeof createCursorAdapterProduction>) =>
  withTestTranslatorBudget(createCursorAdapterProduction(...args));

const provider: OcxProviderConfig = { adapter: "cursor", baseUrl: "https://api2.cursor.sh" };

const ECHO_TEXT = "[Tool Result]\n[tool_result]\ncall_id: run_cmd_0_abc\nname: run_cmd\nis_error: false\noutput:\nR1=A17\n";

function toolResultBody(modelId: string): OcxParsedRequest {
  return {
    modelId,
    context: {
      messages: [
        { role: "user", content: "run the probe", timestamp: 1 },
        { role: "assistant", content: "Running it.", timestamp: 2 },
        { role: "toolResult", toolCallId: "call_1", toolName: "run_cmd", content: "R1=A17", isError: false, timestamp: 3 },
      ],
    },
    stream: false,
    options: {},
    _cursorConversationId: "cursor_echo_fixture",
    _cursorIdentityScope: "acct-echo",
  } as OcxParsedRequest;
}

/** First run echoes the envelope; the retry answers normally. Records each run request. */
function echoingThenHealthyTransportFactory() {
  const runRequests: CursorRunRequest[] = [];
  let attempt = 0;
  return {
    factory: (_input: unknown) => ({
      async *run(request: CursorRunRequest) {
        runRequests.push(request);
        attempt += 1;
        if (attempt === 1) {
          // Fragmented echo: marker split across deltas.
          yield { type: "text", text: "[Tool " } satisfies CursorServerMessage;
          yield { type: "text", text: "Result]\n[tool_result]\ncall_id: x" } satisfies CursorServerMessage;
          yield { type: "text", text: ECHO_TEXT } satisfies CursorServerMessage;
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
          return;
        }
        yield { type: "text", text: "STATE A17" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    }),
    runRequests,
    attempts: () => attempt,
  };
}

describe("cursor external output quarantine + corrective retry (devlog 260826 gaps 10-11)", () => {
  describe("mid-stream echo observer (devlog 260828 F1/F2)", () => {
    const RUN03_SPECIMEN =
      "Step 2 produced no stdout, as expected. Next I'll cat the file.\n"
      + "[Tool Result]\n[tool_result]\ncall_id: call-c5b79188-edec-4a92\n"
      + "fc_63367283 mar-2aec-9a25-b7df-9b125bd8d1b5_0\nname: exec\nis_error: false\noutput:\n70\n84\n98\n";

    test("midstream echo after leading text is recorded with marker and offset", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("Legit leading sentence.\n");
      observer.feed("[Tool Result]\ncall_id: fc_1234-abcd_0\nrest of block\n");
      const findings = observer.findings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.marker).toBe("[Tool Result]");
      expect(findings[0]!.offset).toBe("Legit leading sentence.\n".length);
    });

    test("midstream corruption window flags a space-spliced mar call-id", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("Leading text about progress.\n");
      observer.feed(RUN03_SPECIMEN);
      const findings = observer.findings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.callIdCorrupt).toBe(true);
    });

    test("clean call-id lines do not flag corruption", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("Leading text.\n");
      observer.feed("[Tool Result]\n[tool_result]\ncall_id: call-1\nfc_63367283-2aec-9a25_1\noutput:\nok\n");
      const findings = observer.findings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.callIdCorrupt).toBe(false);
    });

    test("a marker fragmented across delta boundaries still fires", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("prose first\n[Tool Res");
      observer.feed("ult]\ncall_id: fc_9 mar-broken_0\n");
      const findings = observer.findings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.marker).toBe("[Tool Result]");
      expect(findings[0]!.callIdCorrupt).toBe(true);
    });

    test("a mid-line marker mention does not fire", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("first line\nThe string [Tool Result] appeared in the transcript I reviewed.\n");
      expect(observer.findings()).toHaveLength(0);
    });

    test("a turn-start marker belongs to the prefix sniffer, not the observer", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("[Tool Result]\ncall_id: fc_1 mar-2_0\n");
      expect(observer.findings()).toHaveLength(0);
    });

    test("indentation beyond the 128-char line cap disarms that line", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("first\n" + " ".repeat(200) + "[Tool Result]\n");
      expect(observer.findings()).toHaveLength(0);
    });

    test("scanning disarms past the cumulative cap but keeps prior findings", () => {
      const observer = new CursorMidstreamEchoObserver();
      observer.feed("lead\n[Tool Result]\ncall_id: clean_0\n");
      const filler = "x".repeat(64 * 1024);
      for (let fed = 0; fed <= MAX_MIDSTREAM_SCAN_LENGTH; fed += filler.length) observer.feed(filler + "\n");
      observer.feed("late\n[Tool Error]\n");
      const findings = observer.findings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.marker).toBe("[Tool Result]");
    });
  });

    test("held-then-released deltas are fed exactly once (adapter diagnostic offset proves single feed)", async () => {
      // The prefix guard holds early deltas then releases them through the same
      // observed emit path. If a delta were fed twice, the mid-stream echo
      // offset would shift by the duplicated length; asserting the exact
      // offset in the diagnostic proves exactly-once feeding.
      const previousDebug = process.env.OCX_DEBUG;
      process.env.OCX_DEBUG = "1";
      const errLines: string[] = [];
      const originalError = console.error;
      console.error = (line: unknown) => { errLines.push(String(line)); };
      try {
        const LEAD = "Progressing through the steps now.\n";
        const factory = () => ({
          async *run() {
            yield { type: "text", text: LEAD } satisfies CursorServerMessage;
            yield { type: "text", text: "[Tool Result]\ncall_id: fc_9 mar-broken_0\n" } satisfies CursorServerMessage;
            yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
          },
          writeClient() {},
        });
        const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
        const events: AdapterEvent[] = [];
        await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
        const diag = errLines.find(line => line.includes("midstream-envelope-echo"));
        expect(diag).toBeDefined();
        const payload = JSON.parse(diag!.slice(diag!.indexOf("{"))) as { offset: number; callIdCorrupt: boolean };
        expect(payload.offset).toBe(LEAD.length);
        expect(payload.callIdCorrupt).toBe(true);
      } finally {
        console.error = originalError;
        if (previousDebug === undefined) delete process.env.OCX_DEBUG;
        else process.env.OCX_DEBUG = previousDebug;
      }
    });

  test("sniffer: marker split across deltas is detected; divergent text flushes", () => {
    const echo = new CursorEnvelopeEchoSniffer();
    expect(echo.feed("[Tool ").kind).toBe("hold");
    expect(echo.feed("Result]").kind).toBe("echo");

    const normal = new CursorEnvelopeEchoSniffer();
    expect(normal.feed("[Tool ").kind).toBe("hold");
    expect(normal.feed("Belt] is a phrase").kind).toBe("flush");

    const plain = new CursorEnvelopeEchoSniffer();
    expect(plain.feed("STATE A17").kind).toBe("flush");

    const whitespace = new CursorEnvelopeEchoSniffer();
    expect(whitespace.feed("\n  [tool_result]").kind).toBe("echo");
  });

  test("routing-commentary sniffer catches fragmented invented fallback but not legitimate Shell prose", () => {
    const hallucination = new CursorRoutingCommentarySniffer();
    expect(hallucination.feed("Shell 경로는 또 같은 문구로 ").kind).toBe("hold");
    expect(hallucination.feed("차단됐으니, 통과가 확인된 ").kind).toBe("hold");
    expect(hallucination.feed("exec_command 경로로 읽겠습니다.").kind).toBe("hallucination");

    const multiToolClaim = new CursorRoutingCommentarySniffer();
    expect(multiToolClaim.feed("Read와 Grep이 모두 blocked 상태입니다.").kind).toBe("hallucination");

    const multiline = new CursorRoutingCommentarySniffer();
    expect(multiline.feed("Shell was blocked.\n").kind).toBe("hold");
    expect(multiline.feed("Switching to exec_command.").kind).toBe("hallucination");

    const legitimate = new CursorRoutingCommentarySniffer();
    expect(legitimate.feed("Shell is unavailable on this operating system.").kind).toBe("hold");
    expect(legitimate.finish().kind).toBe("flush");

    const contextFree = new CursorRoutingCommentarySniffer();
    expect(contextFree.feed("The request was blocked and redirected to exec_command.").kind).toBe("hold");
    expect(contextFree.finish().kind).toBe("flush");
  });

  test("external tool-result echo retries once with the corrective action text and no leaked envelope", async () => {
    const { factory, runRequests, attempts } = echoingThenHealthyTransportFactory();
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
    expect(attempts()).toBe(2);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("STATE A17");
    expect(text).not.toContain("[Tool Result]");
    expect(events.some(e => e.type === "done")).toBe(true);
    // Retry request carries the corrective continuation and a rotated conversation id.
    expect(runRequests).toHaveLength(2);
    expect(runRequests[1]?.echoRetryContinuationText).toBe(CURSOR_ECHO_RETRY_CONTINUATION_TEXT);
    expect(runRequests[1]?.conversationId).not.toBe(runRequests[0]?.conversationId);
  });

  test("double echo fails with an error instead of looping", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "text", text: ECHO_TEXT } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
    expect(attempt).toBe(2);
    const errors = events.filter(e => e.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).not.toContain("[Tool Result]");
  });

  test("normal external continuation is unaffected (single attempt, text intact)", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "text", text: "[note] leading bracket but " } satisfies CursorServerMessage;
        yield { type: "text", text: "not an envelope" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
    expect(attempt).toBe(1);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("[note] leading bracket but not an envelope");
  });

  test("plain user turns (no trailing toolResult) never arm the sniffer", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "text", text: ECHO_TEXT } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    const body = {
      modelId: "cursor/kimi-k3",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_echo_plain",
      _cursorIdentityScope: "acct-echo",
    } as OcxParsedRequest;
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
    expect(attempt).toBe(1);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toContain("[Tool Result]");
  });

  test("user-action round with a replayed toolResult in history arms the sniffer and retries", async () => {
    const { factory, runRequests, attempts } = echoingThenHealthyTransportFactory();
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    const body = {
      modelId: "cursor/kimi-k3",
      context: {
        messages: [
          { role: "user", content: "run the probe", timestamp: 1 },
          { role: "assistant", content: "Running it.", timestamp: 2 },
          { role: "toolResult", toolCallId: "call_1", toolName: "run_cmd", content: "R1=A17", isError: false, timestamp: 3 },
          { role: "assistant", content: "STATE A17", timestamp: 4 },
          { role: "user", content: "Round 2. continue", timestamp: 5 },
        ],
      },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_echo_user_round",
      _cursorIdentityScope: "acct-echo",
    } as OcxParsedRequest;
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
    expect(attempts()).toBe(2);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("STATE A17");
    expect(runRequests[1]?.echoRetryContinuationText).toBeDefined();
  });

  test("code-mode routing commentary that invents a blocked native Shell is quarantined and retried", async () => {
    let attempt = 0;
    const runRequests: CursorRunRequest[] = [];
    const factory = () => ({
      async *run(request: CursorRunRequest) {
        runRequests.push(request);
        attempt += 1;
        if (attempt === 1) {
          yield {
            type: "text",
            text: "`Shell` 경로는 또 같은 문구로 차단됐으니, 통과가 확인된 `exec_command` 경로로 읽겠습니다.",
          } satisfies CursorServerMessage;
        } else {
          yield { type: "text", text: "READ_OK" } satisfies CursorServerMessage;
        }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const body = {
      modelId: "cursor/kimi-k3-1m",
      context: {
        messages: [{ role: "user", content: "Read the file and report its first line.", timestamp: 1 }],
        tools: [{
          name: "exec",
          description: "Run JavaScript code to orchestrate nested tool calls.",
          parameters: {},
          freeform: true,
        }],
      },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_routing_commentary",
      _cursorIdentityScope: "acct-routing-commentary",
    } as OcxParsedRequest;
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(attempt).toBe(2);
    expect(text).toBe("READ_OK");
    expect(text).not.toContain("Shell");
    expect(runRequests[1]?.echoRetryContinuationText).toBeDefined();
  });
});

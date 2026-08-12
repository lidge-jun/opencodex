import { describe, expect, spyOn, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../src/adapters/anthropic";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";
import { parseSidecarSSE } from "../src/web-search/parse";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

// `JSON.parse` returns a value, not necessarily an object: `JSON.parse("null")` is `null` and
// never throws, so a `try/catch` around the parse cannot see it. Every payload below is
// syntactically valid JSON that does NOT deserialize to a record, which is the input class that
// walked past the malformed-frame guard and reached a property access on the parse result.
//
// Only `null` actually crashed — property access on a number, string, boolean or array is legal
// in JS and quietly yields `undefined`, so those frames were silently accepted as empty ones.
// Both are wrong for the same reason, so they are asserted together.
const NON_RECORD_PAYLOADS = ["null", "42", '"text"', "true", "[]"] as const;

// The syntactically-invalid control. It was already handled correctly before this fix; every
// assertion below is written as parity against it so the test states the actual requirement —
// a valid-JSON non-record frame is treated exactly like an unparseable one — rather than
// re-encoding each adapter's terminal message and drifting when those messages change.
const INVALID_JSON_PAYLOAD = "{not json}";

// A token distinctive enough that finding it anywhere in a log line proves the frame's content
// was copied there. Used by the web-search warning-hygiene tests below.
const MARKER = "ocx-marker-4f21b7a9-do-not-log";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));
const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));
const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

function sse(payload: string): Response {
  return new Response(`data: ${payload}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(stream: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function chatText(events: AdapterEvent[]): string {
  return events.flatMap(event => (event.type === "text_delta" ? [event.text] : [])).join("");
}

// The reporter's captured stream from issue #1219, with the middle frame substituted. The point
// of the shape is that the frame under test sits BETWEEN content deltas and the terminal frames,
// so a parser that stops on it throws away an answer that has already fully arrived.
function healthyChatStream(midFrame: string): Response {
  return new Response([
    'data: {"choices":[{"delta":{"content":"P"},"finish_reason":null,"index":0}],"usage":null}\n\n',
    'data: {"choices":[{"delta":{"content":"ONG"},"finish_reason":null,"index":0}],"usage":null}\n\n',
    `data: ${midFrame}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":null}\n\n',
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

// Same idea on the Gemini wire: the terminal signal is the trailing `finishReason`, so the frame
// under test has to be skipped for the turn to reach it.
function healthyGoogleStream(midFrame: string): Response {
  return new Response([
    'data: {"candidates":[{"content":{"parts":[{"text":"P"}]}}]}\n\n',
    `data: ${midFrame}\n\n`,
    'data: {"candidates":[{"content":{"parts":[{"text":"ONG"}]},"finishReason":"STOP"}]}\n\n',
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

const openAIChatProvider = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
} as OcxProviderConfig;

const googleProvider = {
  adapter: "google",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "google-test-key",
  authMode: "key",
} as OcxProviderConfig;

const anthropicProvider = {
  adapter: "anthropic",
  baseUrl: "https://example.test",
  apiKey: "key",
} as OcxProviderConfig;

describe("SSE data frames that parse to a non-record", () => {
  describe("openai-chat adapter", () => {
    // The shape the reporter actually captured (issue #1219): `data: null` is a benign padding
    // frame BETWEEN content deltas, with the finish chunk and [DONE] arriving right after it.
    // Terminating here discarded a completed answer — they measured the full text arriving and
    // the turn failing anyway. Skipping is what makes the reported provider work.
    test.each(NON_RECORD_PAYLOADS)("a mid-stream `data: %s` is skipped and the turn completes", async payload => {
      const events = await collect(createOpenAIChatAdapter(openAIChatProvider).parseStream(healthyChatStream(payload)));

      expect(events.at(-1)?.type).toBe("done");
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(chatText(events)).toBe("PONG");
    });

    // Skipping must not become a silent success. A stream carrying nothing but non-record frames
    // sets neither finishReason nor sawUserFacingOutput, so the EOF terminal-signal guard fires.
    test.each(NON_RECORD_PAYLOADS)("a stream of only `data: %s` frames still fails closed", async payload => {
      const events = await collect(createOpenAIChatAdapter(openAIChatProvider).parseStream(sse(payload)));

      expect(events.at(-1)?.type).toBe("error");
      expect(events.some(event => event.type === "done")).toBe(false);
    });

    // The two classes must stay distinguishable: unparseable JSON is still terminal at the frame,
    // where a valid-JSON non-record is not. Asserted at the same position in the same stream so
    // the only variable is the payload.
    test("an unparseable frame stays terminal where a non-record frame does not", async () => {
      const withInvalid = await collect(
        createOpenAIChatAdapter(openAIChatProvider).parseStream(healthyChatStream(INVALID_JSON_PAYLOAD)));
      expect(withInvalid.at(-1)).toEqual({ type: "error", message: "malformed upstream SSE data frame" });
      expect(withInvalid.some(event => event.type === "done")).toBe(false);

      const withNonRecord = await collect(
        createOpenAIChatAdapter(openAIChatProvider).parseStream(healthyChatStream("null")));
      expect(withNonRecord.at(-1)?.type).toBe("done");
    });
  });

  describe("google adapter", () => {
    test.each(NON_RECORD_PAYLOADS)("a mid-stream `data: %s` is skipped and the turn completes", async payload => {
      const events = await collect(createGoogleAdapter(googleProvider).parseStream(healthyGoogleStream(payload)));

      expect(events.at(-1)?.type).toBe("done");
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(chatText(events)).toBe("PONG");
    });

    // The guard returns before `sawAnyFrame = true`, so an all-non-record stream is still an
    // empty one as far as the terminal-signal check is concerned.
    test.each(NON_RECORD_PAYLOADS)("a stream of only `data: %s` frames still fails closed", async payload => {
      const events = await collect(createGoogleAdapter(googleProvider).parseStream(sse(payload)));

      expect(events.at(-1)?.type).toBe("error");
      expect(events.some(event => event.type === "done")).toBe(false);
    });

    test("an unparseable frame stays terminal where a non-record frame does not", async () => {
      const withInvalid = await collect(
        createGoogleAdapter(googleProvider).parseStream(healthyGoogleStream(INVALID_JSON_PAYLOAD)));
      expect(withInvalid.at(-1)).toEqual({ type: "error", message: "malformed upstream SSE data frame" });
      expect(withInvalid.some(event => event.type === "done")).toBe(false);

      const withNonRecord = await collect(
        createGoogleAdapter(googleProvider).parseStream(healthyGoogleStream("null")));
      expect(withNonRecord.at(-1)?.type).toBe("done");
    });
  });

  describe("anthropic adapter", () => {
    // The anthropic parser drops an unparseable frame and keeps reading rather than terminating,
    // so parity here means "dropped the same way" — the stream still fails closed at EOF because
    // no `message_stop` arrived, which is the pre-existing truncation guard doing its job.
    test.each(NON_RECORD_PAYLOADS)("`data: %s` is dropped, not thrown", async payload => {
      const control = await collect(createAnthropicAdapter(anthropicProvider).parseStream(sse(INVALID_JSON_PAYLOAD)));
      const events = await collect(createAnthropicAdapter(anthropicProvider).parseStream(sse(payload)));

      expect(events).toEqual(control);
      expect(events.some(event => event.type === "done")).toBe(false);
    });

    test("a non-record frame does not stop a later well-formed frame from being read", async () => {
      const response = new Response([
        "data: null\n\n",
        "event: message_start\n",
        'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
        "event: content_block_start\n",
        'data: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
        "event: content_block_delta\n",
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
        "event: message_stop\n",
        'data: {"type":"message_stop"}\n\n',
      ].join(""), { headers: { "content-type": "text/event-stream" } });

      const events = await collect(createAnthropicAdapter(anthropicProvider).parseStream(response));

      expect(events.some(event => event.type === "text_delta")).toBe(true);
      expect(events.at(-1)?.type).toBe("done");
    });
  });

  describe("web-search sidecar parser", () => {
    test.each(NON_RECORD_PAYLOADS)("`data: %s` is ignored, not thrown", async payload => {
      const control = await parseSidecarSSE(sse(INVALID_JSON_PAYLOAD));
      const result = await parseSidecarSSE(sse(payload));

      expect(result).toEqual(control);
    });

    // An upstream SSE payload can carry model output or credential material, and a frame that
    // failed to parse is the least trustworthy content there is. Both warning paths — unparseable
    // and valid-but-not-a-record — must report the frame without reproducing it.
    test.each([
      ["unparseable", `{${MARKER}`],
      ["non-record", `"${MARKER}"`],
    ])("the %s warning reports the frame without copying its content", async (_label, payload) => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await parseSidecarSSE(sse(payload));

        // The warning has to actually fire, or the marker assertion below passes vacuously.
        expect(warn).toHaveBeenCalled();
        const logged = warn.mock.calls.flat().map(String).join("\n");
        expect(logged).not.toContain(MARKER);
        expect(logged).toContain("[web-search-parse]");
      } finally {
        warn.mockRestore();
      }
    });

    test("a non-record frame does not discard the answer that follows it", async () => {
      const response = new Response([
        "data: null\n\n",
        'data: {"type":"response.output_text.done","text":"answer"}\n\n',
      ].join(""), { headers: { "content-type": "text/event-stream" } });

      const result = await parseSidecarSSE(response);

      expect(result.text).toBe("answer");
    });
  });
});

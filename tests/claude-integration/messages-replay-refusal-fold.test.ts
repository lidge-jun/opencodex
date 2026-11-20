import { expect, test } from "bun:test";
import { CLIENT_ERROR_CONTRACTS } from "../../src/lib/client-error-body";
import { isAutomaticReplayBlocked, isNonReplayableResponse, isReplayRefusalResponse } from "../../src/lib/upstream-retry";
import type { MessagesFailureVerdictSink } from "../../src/claude/failure-verdict";
import { collectAnthropicMessageResponse, encodeAnthropicMessageSse, foldAnthropicMessage } from "../../src/protocols/encoders/messages";
import type { AdapterEvent } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const codes = ["upstream_reset_replay_refused", "upstream_response_refused"] as const;
const diagnostic = "prompt is too long private-adapter-diagnostic";
function events(code: string, status: number, retryable?: boolean): AsyncIterable<AdapterEvent> {
  return (async function* () {
    yield { type: "error", code, status, retryable, errorType: "invalid_request_error", message: diagnostic } as const;
  })();
}
function payload(code: string) {
  return { type: "error", error: { type: "rate_limit_error", code, message: CLIENT_ERROR_CONTRACTS.replay_refused } };
}

for (const code of codes) for (const status of [400, 503]) for (const retryable of [undefined, false, true]) {
  test(`direct fold retains ${code} from ${status}, retryable=${retryable}`, async () => {
    const response = await foldAnthropicMessage(events(code, status, retryable), {
      model: "fixture", translatorBudget: createTestTranslatorBudget(),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(isAutomaticReplayBlocked(response)).toBe(true);
    // A wire code chooses the client contract; it does not invent transport provenance.
    expect(isReplayRefusalResponse(response)).toBe(false);
    expect(isNonReplayableResponse(response)).toBe(false);
    const text = await response.text();
    expect(text).not.toContain(diagnostic);
    expect(text).not.toContain("prompt is too long");
    expect(JSON.parse(text)).toEqual(payload(code));
  });
}

for (const code of codes) for (const retryable of [undefined, false, true]) {
  test(`direct stream retains fixed ${code}, retryable=${retryable}`, async () => {
    const text = await new Response(encodeAnthropicMessageSse(events(code, 503, retryable), {
      model: "fixture", translatorBudget: createTestTranslatorBudget(),
    })).text();
    const frames = text.trimEnd().split("\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toStartWith("event: error\ndata: ");
    expect(JSON.parse(frames[0]!.slice("event: error\ndata: ".length))).toEqual(payload(code));
  });
}

test("an unrelated adapter error keeps the ordinary folded 502 policy", async () => {
  const response = await foldAnthropicMessage((async function* () {
    yield { type: "error", code: "unrecognized_adapter_failure", status: 503, message: "private-adapter-diagnostic" } as const;
  })(), { model: "fixture", translatorBudget: createTestTranslatorBudget() });
  expect(response.status).toBe(502);
  expect(response.headers.get("x-should-retry")).toBeNull();
  expect(isAutomaticReplayBlocked(response)).toBe(false);
  expect(await response.json()).toEqual({ type: "error", error: {
    type: "overloaded_error", message: "The provider is temporarily unavailable; retry later.",
  } });
});

test("a collector mismatch cannot borrow the previous delivered refusal verdict", async () => {
  const sink: MessagesFailureVerdictSink = {};
  const code = codes[0];
  await new Response(encodeAnthropicMessageSse(events(code, 400, false), {
    model: "fixture", translatorBudget: createTestTranslatorBudget(), failureVerdictSink: sink,
  })).text();
  expect(sink.delivered).toHaveLength(1);
  expect(sink.delivered![0]!.replayRefusalCode).toBe(code);
  const changed = { ...payload(code), error: { ...payload(code).error, message: "different wire record" } };
  const response = await collectAnthropicMessageResponse(
    new Response(`event: error\ndata: ${JSON.stringify(changed)}\n\n`).body!,
    "fixture", createTestTranslatorBudget(), sink,
  );
  expect(sink.collectedProjection).toBe(false);
  expect(sink.collectedReplayRefusalCode).toBeUndefined();
  expect(response.status).toBe(502);
  expect(response.headers.get("x-should-retry")).toBeNull();
  await response.body?.cancel();
});

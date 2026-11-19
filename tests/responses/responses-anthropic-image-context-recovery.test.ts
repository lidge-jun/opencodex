import { expect, test } from "bun:test";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { registerUpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { markResponseNonReplayable, REPLAY_REFUSAL_MESSAGE, UPSTREAM_RESPONSE_REFUSED_CODE } from "../../src/lib/upstream-retry";
import { sharedSpendLedger } from "../../src/lib/spend-reservation-ledger";
import { createAnthropicImageRecovery, recoverAdapterImageContext } from "../../src/server/responses/image-context-recovery";
import { routeModel } from "../../src/router";
import type { AdapterRequest, ProviderAdapter } from "../../src/adapters/base";
import type { OcxConfig, OcxParsedRequest } from "../../src/types";
import { completion, credential, fixture, image413, imageToolCall, providerName, target } from "../helpers/anthropic-image-413-fixture";

for (const lane of ["direct", "search", "media"] as const) {
  for (const refusalAt of [1, 2]) {
    test(`image-context recovery stops on a coded refusal at send ${refusalAt} on the ${lane} path`, async () => {
      const diagnostic = "Fixture request body too large";
      const result = await fixture({ enabled: true, lane, handle: (_wire, index) => {
        if (index < refusalAt) return image413();
        if (index > refusalAt) return completion("Unexpected recovery", lane !== "direct");
        return Response.json({ error: {
          type: "request_too_large", code: UPSTREAM_RESPONSE_REFUSED_CODE, message: diagnostic,
        } }, { status: index === 1 ? 413 : 429 });
      } });
      expect(result.sent).toHaveLength(refusalAt);
      expect(result.text).toContain(UPSTREAM_RESPONSE_REFUSED_CODE);
      expect(result.text).toContain(REPLAY_REFUSAL_MESSAGE);
      expect(result.text).not.toContain(diagnostic);
    });
  }

  test(`image-context recovery uses the same credential and destination through the ${lane} path`, async () => {
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 3, baseSendAllowance: 3,
      finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
    const result = await fixture({ enabled: true, lane, requestOptions: { sendBudget: budget },
      handle: (_wire, index) => index === 1 ? image413() : index === 2 ? completion("Old image summary")
        : completion("Recovered fixture response", lane !== "direct") });
    expect(result.text).toContain("Recovered fixture response");
    expect(result.sent).toHaveLength(3);
    expect(budget.used).toBe(3);
    for (const entry of result.sent) {
      expect(entry.url).toBe(target);
      expect(entry.key).toBe(credential);
      expect(entry.redirect).toBe("manual");
    }
    const summary = JSON.parse(result.sent[1]!.body);
    expect(summary.tool_choice).toEqual({ type: "none" });
    expect(summary.tools).toBeUndefined();
    expect(result.sent[1]!.body).toContain("Older screenshot");
    expect(result.sent[1]!.body).not.toContain("Keep the newest screenshot");
    const retry = result.sent[2]!.body;
    expect(retry).toContain("Old image summary");
    expect(retry).toContain("Keep the newest screenshot");
    expect(retry).not.toContain("Older screenshot");
    expect(retry.match(/"type":"image"/g)).toHaveLength(1);
  });
}

for (const field of ["apiKey", "baseUrl"] as const) for (const during of ["refusal", "summary"] as const) {
  test(`image-context recovery refuses a changed ${field} during ${during}`, async () => {
    const result = await fixture({ enabled: true, handle: (_wire, index, config) => {
      if (index === (during === "refusal" ? 1 : 2)) {
        config.providers[providerName]![field] = field === "apiKey"
          ? "synthetic-replacement-key" : "https://other-image.example.test/v1/messages";
      }
      return index === 1 ? image413() : completion("Old image summary");
    } });
    expect(result.response.status).toBe(413);
    expect(result.sent).toHaveLength(during === "refusal" ? 1 : 2);
  });
}

test("image-context recovery needs budget for both summary and resend before it starts", async () => {
  const budget = createRequestExecutionBudget({ maxTotalModelSends: 2, baseSendAllowance: 2,
    finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
  const result = await fixture({ enabled: true, requestOptions: { sendBudget: budget }, handle: () => image413() });
  expect(result.response.status).toBe(413);
  expect(result.sent).toHaveLength(1);
  expect(budget.used).toBe(1);
});

test("direct image-context recovery reserves and records each leg before using more pool spend", async () => {
  const reservedAtDispatch: number[] = [];
  const handle: Parameters<typeof fixture>[0]["handle"] = (_wire, index) => {
    reservedAtDispatch.push(sharedSpendLedger().snapshot("pool", providerName)?.reserved ?? 0);
    return index === 1 ? image413() : completion(index === 2 ? "Old image summary" : "Recovered fixture response");
  };
  const ample = await fixture({ enabled: true, maxOutputTokens: 256, spendCeiling: 100_000, handle });
  expect(ample.response.status).toBe(200);
  expect(ample.text).toContain("Recovered fixture response");
  expect(ample.sent).toHaveLength(3);
  expect(ample.spendDispatchCount).toBe(3);

  const [initial, summary, resend] = reservedAtDispatch;
  expect(initial).toBeGreaterThan(0);
  for (const [ceiling, sends] of [[initial!, 1], [summary!, 2]] as const) {
    reservedAtDispatch.length = 0;
    const tight = await fixture({ enabled: true, maxOutputTokens: 256, spendCeiling: ceiling, handle });
    expect(tight.response.status).toBe(413);
    expect(tight.text).toContain("context_length_exceeded");
    expect(tight.sent).toHaveLength(sends);
    expect(tight.spendDispatchCount).toBe(sends);
  }
  expect(summary! - initial!).toBeGreaterThan(256);
  expect(resend! - summary!).toBeGreaterThan(256);
});

test("image-context recovery declines a captured pool ceiling without a spend observer", async () => {
  const budget = createRequestExecutionBudget();
  const result = await fixture({ enabled: true, spendCeiling: 100_000, requestOptions: { sendBudget: budget },
    handle: (_wire, index) => index === 1 ? image413() : completion("Unexpected recovery") });
  expect(result.response.status).toBe(413);
  expect(result.sent).toHaveLength(1);
  expect(budget.used).toBe(1);
});

for (const stream of [false, true]) {
  test(`metered image-context recovery settles each journal receipt (stream=${stream})`, async () => {
    const result = await fixture({ enabled: true, maxOutputTokens: 256, spendCeiling: 100_000, stream,
      handle: (_wire, index) => {
        if (index === 1) return Response.json({
          type: "error", error: { type: "request_too_large" }, usage: { input_tokens: 0, output_tokens: 0 },
        }, { status: 413 });
        if (index === 2) return completion("Metered summary", false, 20, 2);
        return completion("Metered resend", stream, 30, 3);
      } });
    expect(result.response.status).toBe(200);
    expect(result.text).toContain("Metered resend");
    expect(result.spendDispatchCount).toBe(3);
    const records = result.spendRecords!;
    const [initial, summary, resend] = records.filter(record => record?.kind === "dispatch");
    const receipts = records.filter(record => record?.kind === "settle" || record?.kind === "lost");
    expect(receipts).toEqual([
      expect.objectContaining({ kind: "settle", send: initial!.send, tokens: 0 }),
      expect.objectContaining({ kind: "settle", send: summary!.send, tokens: 22 }),
      expect.objectContaining({ kind: "settle", send: resend!.send, tokens: 33 }),
    ]);
  });

  test(`metered image-context recovery settles a fourth continuation receipt (stream=${stream})`, async () => {
    const result = await fixture({ enabled: true, maxOutputTokens: 256, spendCeiling: 100_000,
      terminalContinuation: true, sendAllowance: 4, stream,
      handle: (_wire, index) => {
        if (index === 1) return Response.json({
          type: "error", error: { type: "request_too_large" }, usage: { input_tokens: 0, output_tokens: 0 },
        }, { status: 413 });
        if (index === 2) return completion("Metered summary", false, 20, 2);
        if (index === 3) return completion("I will modify the file now.", stream, 30, 3);
        return completion("Metered continuation", stream, 40, 4);
      } });
    expect(result.response.status).toBe(200);
    expect(result.text).toContain("Metered continuation");
    expect(result.sent).toHaveLength(4);
    expect(result.spendDispatchCount).toBe(4);
    const records = result.spendRecords!;
    const dispatched = records.filter(record => record?.kind === "dispatch");
    const receipts = records.filter(record => record?.kind === "settle" || record?.kind === "lost");
    expect(receipts).toEqual([0, 22, 33, 44].map((tokens, index) =>
      expect.objectContaining({ kind: "settle", send: dispatched[index]!.send, tokens })));
  });

  for (const metered of [false, true]) {
    test(`image-context recovery continuation HTTP 400 settles its own usage (metered=${metered}, stream=${stream})`, async () => {
      const result = await fixture({ enabled: true, maxOutputTokens: 256, spendCeiling: 100_000,
        terminalContinuation: true, sendAllowance: 4, stream,
        handle: (_wire, index) => {
          if (index === 1) return Response.json({
            type: "error", error: { type: "request_too_large" }, usage: { input_tokens: 0, output_tokens: 0 },
          }, { status: 413 });
          if (index === 2) return completion("Metered summary", false, 20, 2);
          if (index === 3) return completion("I will modify the file now.", stream, 30, 3);
          return Response.json({ type: "error", error: { type: "invalid_request_error" },
            ...(metered ? { usage: { input_tokens: 5000, output_tokens: 4 } } : {}),
          }, { status: 400 });
        },
      });
      expect(result.text).toContain("Provider continuation error 400");
      const records = result.spendRecords!;
      const dispatched = records.filter(record => record?.kind === "dispatch");
      const receipts = records.filter(record => record?.kind === "settle" || record?.kind === "lost");
      expect(dispatched).toHaveLength(4);
      const continuation = dispatched[3]!.send;
      const booking = records.find(record => record?.kind === "reserve" && record.send === continuation);
      if (booking?.kind !== "reserve") throw new Error("Missing continuation reservation");
      expect(booking.tokens).toBeGreaterThan(0);
      expect(result.spendSnapshot).toMatchObject({
        settled: metered ? 5059 : 55,
        unresolved: metered ? 0 : booking.tokens,
      });
      expect(receipts).toEqual([
        ...[0, 22, 33].map((tokens, index) =>
          expect.objectContaining({ kind: "settle", send: dispatched[index]!.send, tokens })),
        expect.objectContaining(metered
          ? { kind: "settle", send: continuation, tokens: 5004 }
          : { kind: "lost", send: continuation }),
      ]);
    });
  }
}

test("first-party Opus 5.5 keeps adaptive thinking on the original and resend only", async () => {
  const result = await fixture({ enabled: true, nativeOpus: true, maxOutputTokens: 256,
    handle: (_wire, index) => index === 1 ? image413() : completion(index === 2 ? "Old image summary" : "Recovered fixture response") });
  expect(result.response.status).toBe(200);
  expect(result.sent).toHaveLength(3);
  const [original, summary, resend] = result.sent.map(send => JSON.parse(send.body));
  expect(original.thinking?.type).toBe("adaptive");
  expect(summary.thinking?.type ?? "disabled").toBe("disabled");
  expect(resend.thinking).toEqual(original.thinking);
});

for (const maxOutputTokens of [256, 2048]) {
  test(`image-context summary honors the wire output limit ${maxOutputTokens} with configured default reasoning`, async () => {
    const result = await fixture({ enabled: true, maxOutputTokens, reasoningDefault: true,
      handle: (_wire, index) => index === 1 ? image413() : completion(index === 2 ? "Old image summary" : "Recovered fixture response") });
    expect(result.response.status).toBe(200);
    expect(result.sent).toHaveLength(3);
    const [original, summary, resend] = result.sent.map(send => JSON.parse(send.body));
    expect(original.max_tokens).toBe(maxOutputTokens);
    expect(summary.max_tokens).toBe(Math.min(1024, original.max_tokens));
    expect(summary.thinking?.type ?? "disabled").toBe("disabled");
    expect(resend.max_tokens).toBe(maxOutputTokens);
  });
}

test("image-context recovery declines a cut containing a developer instruction", async () => {
  const result = await fixture({ enabled: true, instructionRole: "developer",
    handle: (_wire, index) => index === 1 ? image413() : completion("Fixture summary omitting the instruction") });
  expect(result.sent[0]!.body).toContain("Retain this instruction verbatim.");
  expect(result.response.status).toBe(413);
  expect(result.sent).toHaveLength(1);
});

test("image-context recovery preserves separate system instructions verbatim", async () => {
  const result = await fixture({ enabled: true, instructionRole: "system",
    handle: (_wire, index) => index === 1 ? image413() : completion("Fixture summary") });
  expect(result.response.status).toBe(200);
  expect(result.sent).toHaveLength(3);
  const system = result.sent.map(send => JSON.parse(send.body).system);
  expect(JSON.stringify(system[0])).toContain("Retain this instruction verbatim.");
  expect(system[1]).toEqual(system[0]);
  expect(system[2]).toEqual(system[0]);
});

for (const cancelAt of [1, 2]) {
  test(`image-context recovery honors cancellation at send ${cancelAt}`, async () => {
    const abort = new AbortController();
    const result = await fixture({ enabled: true, requestOptions: { abortSignal: abort.signal },
      handle: (_wire, index) => {
        if (index === cancelAt) abort.abort();
        return index === 1 ? image413() : completion("Old image summary");
      } });
    expect(result.response.status).toBe(499);
    expect(result.sent).toHaveLength(cancelAt);
  });
}

test("image-context recovery classifies cancellation while retaining the 413 body as client cancellation", async () => {
  const abort = new AbortController();
  const translatorBudget = createTranslatorBudget();
  const modelId = "claude-sonnet-4-5";
  const config = { defaultProvider: providerName, providers: {
    [providerName]: { adapter: "anthropic", baseUrl: target, authMode: "key", apiKey: credential, models: [modelId] },
  } } as OcxConfig;
  const owner = { version: 1 as const, providerName, modelId, adapterName: "anthropic",
    providerDestinationIdentity: target, credentialIdentity: "fixture" };
  const image = { type: "image" as const, imageUrl: "data:image/png;base64,AA==" };
  const parsed: OcxParsedRequest = { modelId, stream: false, options: {}, _providerContinuationOwner: owner,
    context: { messages: [
      { role: "user", timestamp: 0, content: [image] },
      { role: "user", timestamp: 0, content: [image] },
    ] } };
  const never = (): never => { throw new Error("Cancelled recovery must never build or send"); };
  const adapter: ProviderAdapter = { name: "anthropic", buildRequest: never, parseStream: never, parseResponse: never };
  const request: AdapterRequest = { url: target, method: "POST", headers: {}, body: '{"type":"image"}' };
  const recover = createAnthropicImageRecovery({ config, options: {} }, {
    route: routeModel(config, `${providerName}/${modelId}`), translatorBudget,
    selectedForwardHeaders: new Headers(), completedToolBlocks: false,
  }, { pinAnthropicImageRecovery: () => ({ owner, request, isCurrent: () => true, dispatchOverride: never }),
    noteRoutedAttemptSend: never }, { targetSendsUsed: 1, remainingTransientSendBudget: () => 2,
    imageRecoverySendReporter: never }, 1000);
  const response = new Response(new ReadableStream({
    pull() { abort.abort(); },
  }, { highWaterMark: 0 }), { status: 413, headers: { "content-type": "application/json" } });
  try {
    const cancelled = await recoverAdapterImageContext(recover, response, parsed, {
      activeAdapter: adapter, sameTargetRequest: request, sameTargetParsed: parsed, sameTargetToken: 0, transportToken: 0,
    }, abort.signal, never);
    expect(abort.signal.aborted).toBe(true);
    expect(cancelled).toBeUndefined();
  } finally { translatorBudget.dispose(); }
});

test("image-context recovery keeps the live second media iteration from stalling", async () => {
  const sendBudget = createRequestExecutionBudget({ maxTotalModelSends: 4, baseSendAllowance: 4,
    finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
  const result = await fixture({ enabled: true, lane: "media", stallTimeoutSec: 0.5,
    requestOptions: { sendBudget },
    handle: async (_wire, index) => {
      if (index === 1) return imageToolCall();
      if (index === 2) return image413();
      if (index === 3) {
        await Bun.sleep(4500);
        return completion("Old image summary");
      }
      return completion("Recovered live media response", true);
    } });
  expect(result.sent[1]?.body).toContain("tool_result");
  expect(result.sent[2]?.body).toContain("Return only the handoff summary");
  expect(result.text).not.toContain("upstream_stall_timeout");
  expect(result.text).toContain("Recovered live media response");
  expect(result.sent).toHaveLength(4);
}, 10_000);

for (const lane of ["direct", "search", "media"] as const) {
  test(`a second image 413 is terminal on the ${lane} path`, async () => {
    const result = await fixture({ enabled: true, lane,
      handle: (_wire, index) => index === 2 ? completion("Old image summary") : image413() });
    expect(result.response.status).toBe(lane === "direct" ? 413 : 200);
    expect(result.text).toContain("context_length_exceeded");
    expect(result.sent).toHaveLength(3);
  });
}

for (const image of ["none", "newest-only"] as const) {
  test(`image-context recovery leaves ${image} image refusals terminal`, async () => {
    const result = await fixture({ enabled: true, image, handle: () => image413() });
    expect(result.response.status).toBe(413);
    expect(result.sent).toHaveLength(1);
  });
}

test("image-context recovery leaves unrecognized and nonreplayable 413 responses terminal", async () => {
  for (const nonReplayable of [false, true]) {
    const result = await fixture({ enabled: true, handle: () => {
      const response = image413(nonReplayable ? "request_too_large" : "policy_denied");
      if (nonReplayable) markResponseNonReplayable(response);
      return response;
    } });
    expect(result.response.status).toBe(413);
    expect(result.sent).toHaveLength(1);
  }
});

test("image-context recovery discards a summary with a tool call even if it contains text", async () => {
  const result = await fixture({ enabled: true, handle: (_wire, index) => index === 1 ? image413() :
    Response.json({ content: [
      { type: "text", text: "Unsafe fixture summary" },
      { type: "tool_use", id: "toolu_fixture", name: "advisor", input: {} },
    ], stop_reason: "end_turn" }) });
  expect(result.response.status).toBe(413);
  expect(result.sent).toHaveLength(2);
});

for (const rewrite of ["destination", "credential"] as const) {
  test(`image-context recovery checks rewritten ${rewrite} before the physical summary send`, async () => {
    let replacing = false;
    const unregister = registerUpstreamRewriter("image-recovery-fixture", outbound => {
      if (!replacing || outbound.url !== target) return;
      if (rewrite === "destination") outbound.url = "https://other-image.example.test/v1/messages";
      else outbound.headers.set("x-api-key", "synthetic-rewritten-key");
    });
    try {
      const budget = createRequestExecutionBudget();
      const result = await fixture({ enabled: true, requestOptions: { sendBudget: budget },
        handle: () => { replacing = true; return image413(); } });
      expect(result.response.status).toBe(413);
      expect(result.sent).toHaveLength(1);
      expect(budget.used).toBe(1);
    } finally { unregister(); }
  });
}

test("image-context recovery is shared by attempts that inherit the ingress translation budget", async () => {
  const translatorBudget = createTranslatorBudget();
  try {
    for (const expectedSends of [3, 1]) {
      const result = await fixture({ enabled: true, requestOptions: { translatorBudget },
        handle: (_wire, index) => index === 2 ? completion("Old image summary") : image413() });
      expect(result.response.status).toBe(413);
      expect(result.sent).toHaveLength(expectedSends);
    }
  } finally { translatorBudget.dispose(); }
});

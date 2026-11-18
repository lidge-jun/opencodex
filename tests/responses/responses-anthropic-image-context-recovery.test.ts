import { expect, test } from "bun:test";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { registerUpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { markResponseNonReplayable } from "../../src/lib/upstream-retry";
import { completion, credential, fixture, image413, providerName, target } from "../helpers/anthropic-image-413-fixture";

for (const lane of ["direct", "search", "media"] as const) {
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
    const result = await fixture({ enabled: true, handle: () => nonReplayable
      ? markResponseNonReplayable(image413()) : image413("policy_denied") });
    expect(result.response.ok).toBe(false);
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

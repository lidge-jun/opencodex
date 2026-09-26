import { describe, expect, test } from "bun:test";
import {
  rewriteSurfaceFor,
  stripSendBlocks,
  stripSendBlocksFromJson,
  stripSendBlocksFromSseLine,
  unlockRateLimitGate,
  type PreservedSendBlock,
} from "../../src/chatgpt/desktop-unblock/rewrite";

const blockedPayload = {
  banner_info: {
    name: "codex_limit_reached",
    banner_type: "text",
    resets_after: "2026-09-26T19:46:00Z",
  },
  blocked_features: [
    { name: "send", block_reason: "usage_limit", resets_after: "2026-09-26T19:46:00Z" },
    { name: "tpp_send", block_reason: "work_subscription_required", resets_after: null },
    { name: "image_gen", block_reason: "usage_limit", resets_after: "2026-09-26T19:46:00Z" },
  ],
  limits_progress: [
    { feature_name: "send", remaining: 0, reset_after: "2026-09-26T19:46:00Z" },
    { feature_name: "reason", remaining: 3, reset_after: "2026-09-26T19:46:00Z" },
    { feature_name: "send", remaining: 2, reset_after: "2026-09-26T19:46:00Z" },
  ],
  model_limits: [{ model_slug: "gpt-5-codex" }],
};

describe("stripSendBlocks", () => {
  test("removes quota send locks, keeps eligibility blocks and quota display data", () => {
    const preserved: PreservedSendBlock[] = [];
    const result = stripSendBlocks(blockedPayload, preserved);
    expect(result.changed).toBe(true);
    const value = result.value as typeof blockedPayload;
    // The usage-limit send lock goes; a work-subscription requirement is not a quota and stays.
    expect(value.blocked_features).toEqual([
      { name: "tpp_send", block_reason: "work_subscription_required", resets_after: null },
      { name: "image_gen", block_reason: "usage_limit", resets_after: "2026-09-26T19:46:00Z" },
    ]);
    expect(preserved).toEqual([{ name: "tpp_send", reason: "work_subscription_required" }]);
    // An exhausted `send` limit is removed; a non-exhausted one and other features stay.
    expect(value.limits_progress).toEqual([
      { feature_name: "reason", remaining: 3, reset_after: "2026-09-26T19:46:00Z" },
      { feature_name: "send", remaining: 2, reset_after: "2026-09-26T19:46:00Z" },
    ]);
    // Display data is untouched.
    expect(value.banner_info).toEqual(blockedPayload.banner_info);
    expect(value.model_limits).toEqual(blockedPayload.model_limits);
  });

  test("reports unchanged payloads and leaves non-object input alone", () => {
    expect(stripSendBlocks(blockedPayload).changed).toBe(true);
    expect(stripSendBlocks({ blocked_features: [] }).changed).toBe(false);
    expect(stripSendBlocks({ limits_progress: [{ feature_name: "send", remaining: 1 }] }).changed).toBe(false);
    expect(stripSendBlocks("text").changed).toBe(false);
    expect(stripSendBlocks(null).changed).toBe(false);
  });

  test("an open quota with a non-quota send block changes nothing (preserved, not removed)", () => {
    // Reproduction from review: open usage + subscription-required block must pass untouched.
    const payload = {
      rate_limit: { allowed: true, limit_reached: false },
      limits_progress: [{ feature_name: "send", remaining: 2 }],
      blocked_features: [{ name: "tpp_send", block_reason: "work_subscription_required", resets_after: null }],
    };
    const preserved: PreservedSendBlock[] = [];
    expect(stripSendBlocks(payload, preserved).changed).toBe(false);
    expect(preserved).toEqual([{ name: "tpp_send", reason: "work_subscription_required" }]);
  });

  test("unrecognised send-block reasons are preserved; absent or quota reasons are removed", () => {
    const preserved: PreservedSendBlock[] = [];
    const result = stripSendBlocks({
      blocked_features: [
        { name: "send", block_reason: "policy_violation" },
        { name: "send", block_reason: null },
        { name: "send" },
        { name: "send", block_reason: "rate_limit_exceeded" },
        { name: "send", block_reason: "quota_exhausted" },
      ],
    }, preserved);
    expect((result.value as { blocked_features: unknown[] }).blocked_features).toEqual([
      { name: "send", block_reason: "policy_violation" },
    ]);
    expect(preserved).toEqual([{ name: "send", reason: "policy_violation" }]);
  });

  test("keeps malformed entries and recurses into nested payloads", () => {
    const nested = { conversation: { blocked_features: [{ name: "send" }, "junk", 7] } };
    const result = stripSendBlocks(nested);
    expect(result.changed).toBe(true);
    expect((result.value as typeof nested).conversation.blocked_features).toEqual(["junk", 7]);
  });
});

describe("stripSendBlocksFromJson", () => {
  test("rewrites a conversation-init style body", () => {
    const rewritten = stripSendBlocksFromJson(JSON.stringify(blockedPayload), "conversation");
    expect(rewritten).not.toBeNull();
    const parsed = JSON.parse(rewritten!) as typeof blockedPayload;
    expect(parsed.blocked_features.map(entry => entry.name)).toEqual(["tpp_send", "image_gen"]);
    expect(parsed.banner_info).toEqual(blockedPayload.banner_info);
  });

  test("each surface applies only its own rewrite", () => {
    const mixed = JSON.stringify({
      rate_limit: { allowed: false, limit_reached: true },
      blocked_features: [{ name: "send", block_reason: "usage_limit" }],
    });
    const usage = JSON.parse(stripSendBlocksFromJson(mixed, "usage")!);
    expect(usage.rate_limit).toEqual({ allowed: true, limit_reached: false });
    expect(usage.blocked_features).toHaveLength(1);
    const conversation = JSON.parse(stripSendBlocksFromJson(mixed, "conversation")!);
    expect(conversation.rate_limit).toEqual({ allowed: false, limit_reached: true });
    expect(conversation.blocked_features).toEqual([]);
  });

  test("returns null for invalid JSON and clean payloads", () => {
    expect(stripSendBlocksFromJson("not json")).toBeNull();
    expect(stripSendBlocksFromJson(JSON.stringify({ banner_info: null }))).toBeNull();
  });
});

describe("unlockRateLimitGate", () => {
  // Shape captured from a real /backend-api/wham/usage/stream snapshot event.
  const usageSnapshot = {
    version: 1,
    stream_id: "d485cc87-f9f6-431c-9908-8b99a854e252",
    sequence: 1,
    usage: {
      plan_type: "pro",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 205162, reset_at: 1790423160 },
        secondary_window: null,
      },
      model_usage: { "gpt-6-astra": { available: false, available_at: "2026-09-26T11:46:01Z", credits_would_enable: true } },
      spend_control: { reached: false, individual_limit: null },
      rate_limit_upsell: { banner_type: "pro_rate_limit_reached", title: "Codex 和工作使用额度已用完", reset_at: 1790423160 },
      rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 },
    },
    generated_at_ms: 1790217999865,
  };

  test("flips the gate flags and keeps every display field", () => {
    const value = structuredClone(usageSnapshot);
    expect(unlockRateLimitGate(value)).toBe(true);
    const gate = (value.usage as typeof usageSnapshot.usage).rate_limit;
    expect(gate.allowed).toBe(true);
    expect(gate.limit_reached).toBe(false);
    // Display data is untouched.
    expect(gate.primary_window).toEqual(usageSnapshot.usage.rate_limit.primary_window);
    expect((value.usage as typeof usageSnapshot.usage).rate_limit_upsell).toEqual(usageSnapshot.usage.rate_limit_upsell);
    expect((value.usage as typeof usageSnapshot.usage).model_usage).toEqual(usageSnapshot.usage.model_usage);
  });

  test("reports no change for open gates and unrelated payloads", () => {
    const open = structuredClone(usageSnapshot);
    (open.usage.rate_limit as Record<string, unknown>).allowed = true;
    (open.usage.rate_limit as Record<string, unknown>).limit_reached = false;
    expect(unlockRateLimitGate(open)).toBe(false);
    expect(unlockRateLimitGate({ usage: { plan_type: "pro" } })).toBe(false);
    expect(unlockRateLimitGate("text")).toBe(false);
  });

  test("handles snapshot endpoints with a top-level rate_limit", () => {
    const snapshot = { rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 42 } } };
    expect(unlockRateLimitGate(snapshot)).toBe(true);
    expect(snapshot.rate_limit.allowed).toBe(true);
    expect(snapshot.rate_limit.primary_window.used_percent).toBe(42);
  });
});

describe("stripSendBlocksFromSseLine", () => {
  test("rewrites data lines carrying send locks", () => {
    const event = { type: "conversation.limit", blocked_features: [{ name: "send", block_reason: "usage_limit" }] };
    const rewritten = stripSendBlocksFromSseLine(`data: ${JSON.stringify(event)}`);
    expect(rewritten).toBe("data: " + JSON.stringify({ type: "conversation.limit", blocked_features: [] }));
  });

  test("rewrites usage-stream events carrying a closed rate limit gate", () => {
    const event = {
      version: 1,
      sequence: 1,
      usage: { rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } } },
    };
    const rewritten = stripSendBlocksFromSseLine(`data: ${JSON.stringify(event)}`);
    expect(rewritten).not.toBeNull();
    const parsed = JSON.parse(rewritten!.slice("data: ".length)) as typeof event;
    expect(parsed.usage.rate_limit.allowed).toBe(true);
    expect(parsed.usage.rate_limit.limit_reached).toBe(false);
    expect(parsed.usage.rate_limit.primary_window.used_percent).toBe(100);
  });

  test("CRLF-framed data lines are rewritten and keep their carriage return", () => {
    const event = { blocked_features: [{ name: "send", block_reason: "usage_limit" }] };
    expect(stripSendBlocksFromSseLine(`data: ${JSON.stringify(event)}\r`)).toBe('data: {"blocked_features":[]}\r');
  });

  test("a JSON string holding U+2028 still matches the data line", () => {
    const event = { note: "a\u2028b", blocked_features: [{ name: "send" }] };
    const rewritten = stripSendBlocksFromSseLine(`data: ${JSON.stringify(event)}`);
    expect(JSON.parse(rewritten!.slice("data: ".length))).toEqual({ note: "a\u2028b", blocked_features: [] });
  });

  test("passes through non-data lines, clean data and malformed JSON", () => {
    expect(stripSendBlocksFromSseLine("event: conversation.limit")).toBeNull();
    expect(stripSendBlocksFromSseLine('data: {"type":"delta"}')).toBeNull();
    expect(stripSendBlocksFromSseLine("data: [partial")).toBeNull();
    expect(stripSendBlocksFromSseLine(": keep-alive")).toBeNull();
  });
});

describe("rewriteSurfaceFor", () => {
  test("only the composer's conversation and usage endpoints are rewritten", () => {
    expect(rewriteSurfaceFor("/backend-api/conversation/init")).toBe("conversation");
    expect(rewriteSurfaceFor("/backend-api/f/conversation")).toBe("conversation");
    expect(rewriteSurfaceFor("/backend-api/f/conversation/prepare")).toBe("conversation");
    expect(rewriteSurfaceFor("/backend-api/conversation")).toBe("conversation");
    expect(rewriteSurfaceFor("/backend-api/wham/usage")).toBe("usage");
    expect(rewriteSurfaceFor("/backend-api/wham/usage/stream")).toBe("usage");
  });

  test("lookalike and unrelated paths pass through", () => {
    for (const path of [
      "/backend-api/conversations",
      "/backend-api/conversation-history",
      "/backend-api/wham/usage/thread_usage/query",
      "/backend-api/wham/usage/plan_limit_history",
      "/backend-api/wham/tasks/list",
      "/review-fixture/not-a-composer-endpoint",
      "/",
    ]) expect(rewriteSurfaceFor(path)).toBeNull();
  });
});

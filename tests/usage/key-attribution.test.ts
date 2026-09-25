import { describe, expect, test } from "bun:test";
import {
  addFinalRequestLog, beginRequestAttempt, finishRequestAttempt, noteProviderAttemptSend,
  recordKeyAttemptFailure, recordKeyAttemptUsage, applyResponseLogMetadata, sealRequestAttemptIdentity,
  inspectResponseLogSsePayload, type RequestLogContext, type RequestLogEntry,
} from "../../src/server/request-log";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { normalizeUsageEntryForTest } from "../../src/usage/log";
import { formatAnthropicProviderForLog } from "../../src/oauth/anthropic-routing";

describe("key attempt accounting", () => {
  test("a combo parent copied before streaming rotation cannot overwrite the final key's usage", () => {
    const active = beginRequestAttempt(1, "test", "model", "openai-chat");
    const child: RequestLogContext = { provider: "test", model: "model", comboId: "stream",
      activeAttempt: active, attempts: [active] };
    const key = (reference: string) => ({ adapter: "openai-chat" as const, authMode: "key" as const,
      baseUrl: "https://example.test", _apiKeyAttempt: { reference } });
    noteProviderAttemptSend(child, "test", key("synthetic-a"), undefined);
    recordKeyAttemptUsage(child, { inputTokens: 100, outputTokens: 10 });
    const parent = { ...child };
    noteProviderAttemptSend(child, "test", key("synthetic-b"), undefined, "key-429");
    recordKeyAttemptUsage(child, { inputTokens: 200, outputTokens: 20 });
    const rows: RequestLogEntry[] = [];
    addFinalRequestLog("stream-key-switch", Date.now(), parent, 200, undefined, row => rows.push(row));
    expect(rows[0].attempts?.map(attempt => attempt.usage?.inputTokens)).toEqual([100, 200]);
    expect(rows[0].usage).toMatchObject({ inputTokens: 300, outputTokens: 30 });
  });

  test("a reader takes the attempts or the request total, never both", () => {
    // The row above deliberately carries BOTH the per-attempt records (100 + 200) and the
    // request total (300). A consumer that added them would report 600 input tokens for 300
    // that were actually spent, and the same arithmetic is what would corrupt a client's own
    // accounting if hidden attempts were folded into the response it sees.
    const summary = readFileSync(repoPath("src/usage/summary.ts"), "utf8");
    const attributions = summary.slice(
      summary.indexOf("function usageAttributions("),
      summary.indexOf("function projectedComboUsage("),
    );
    // The entry-level row is the fallback for a request written before attempts existed, and it
    // is reachable only when there are none.
    expect(attributions).toContain("if (!entry.attempts?.length) {");
    // Everything after that early return maps the attempts; there is no branch that emits the
    // entry row alongside them.
    const fallback = attributions.indexOf("if (!entry.attempts?.length) {");
    const perAttempt = attributions.indexOf("return entry.attempts.map(attempt =>", fallback);
    expect(fallback).toBeGreaterThan(-1);
    expect(perAttempt).toBeGreaterThan(fallback);
    expect(attributions.match(/return \[\{/g) ?? []).toHaveLength(1);
  });
  test("adding reported usage cannot upgrade an earlier estimate to a measurement", () => {
    const active = beginRequestAttempt(1, "test", "model", "openai-chat");
    const ctx: RequestLogContext = { provider: "test", model: "model", activeAttempt: active };
    recordKeyAttemptUsage(ctx, { inputTokens: 100, outputTokens: 0, estimated: true });
    recordKeyAttemptUsage(ctx, { inputTokens: 10, outputTokens: 2 });
    finishRequestAttempt(active, 429, 1);
    expect(active).toMatchObject({ usageStatus: "estimated", usage: { inputTokens: 110, outputTokens: 2, estimated: true } });
  });
  test.each(["synthetic-a", undefined])("a late unreported segment (%s) cannot reuse a stale parent total", reference => {
    const active = beginRequestAttempt(1, "test", "model", "openai-chat");
    const child: RequestLogContext = { provider: "test", model: "model", comboId: "stream",
      activeAttempt: active, attempts: [active] };
    const key = (value?: string) => ({ adapter: "openai-chat" as const, authMode: "key" as const,
      baseUrl: "https://example.test", _apiKeyAttempt: value ? { reference: value } : undefined });
    noteProviderAttemptSend(child, "test", key("synthetic-a"), undefined);
    recordKeyAttemptUsage(child, { inputTokens: 100, outputTokens: 10 });
    const parent = { ...child };
    noteProviderAttemptSend(child, "test", key("synthetic-b"), undefined, "key-429");
    noteProviderAttemptSend(child, "test", key(reference), undefined, "key-429");
    const rows: RequestLogEntry[] = [];
    addFinalRequestLog("stale-parent", Date.now(), parent, 499, undefined, row => rows.push(row));
    expect(rows[0].attempts?.map(attempt => attempt.usage?.inputTokens)).toEqual([100, undefined, undefined]);
    expect(rows[0].attempts?.[2].usageStatus).toBe("unreported");
  });
  test("rotation preserves reported failure usage and the stable active object; unknown stays unreported", async () => {
    const provider = (reference?: string) => ({ adapter: "openai-chat" as const, authMode: "key" as const,
      baseUrl: "https://example.test/v1", _apiKeyAttempt: reference ? { reference } : undefined });
    const active = beginRequestAttempt(1, "test-provider", "test-model", "openai-chat");
    const ctx: RequestLogContext = { provider: "test-provider", model: "test-model", comboId: "fixture",
      activeAttempt: active, activeAttemptStartedAt: Date.now(), attempts: [active] };
    noteProviderAttemptSend(ctx, "test-provider", provider("test-key-a"), 99999);
    const labelA = active.accountLogLabel;
    const failed = Response.json({ usage: { prompt_tokens: 100, completion_tokens: 20 } }, { status: 429 });
    await recordKeyAttemptFailure(ctx, failed);
    expect(await failed.json()).toEqual({ usage: { prompt_tokens: 100, completion_tokens: 20 } });
    noteProviderAttemptSend(ctx, "test-provider", provider("test-key-b"), 200, "rate-limit-429");
    expect(ctx.activeAttempt).toBe(active);
    expect(ctx.attempts).toHaveLength(2);
    expect(ctx.attempts?.[0]).toMatchObject({ accountLogLabel: labelA, status: 429, ordinal: 1,
      usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 20 }, sendCount: 1 });
    expect(active.accountLogLabel).not.toBe(labelA);
    expect(active.usage).toBeUndefined();
    // The next failure reports no usage. It must not inherit the preceding account's usage or an estimate.
    await recordKeyAttemptFailure(ctx, Response.json({ error: "synthetic" }, { status: 401 }));
    noteProviderAttemptSend(ctx, "test-provider", provider(), 300, "key-401");
    expect(ctx.attempts?.[1]).toMatchObject({ status: 401, ordinal: 2, usageStatus: "unreported" });
    expect(ctx.attempts?.[1].usage).toBeUndefined();
    expect(active.accountLogLabel).toBeUndefined();
    recordKeyAttemptUsage(ctx, { inputTokens: 300, outputTokens: 40 });
    const rows: RequestLogEntry[] = [];
    addFinalRequestLog("key-rotation", Date.now(), ctx, 200, undefined, row => rows.push(row));
    const roundTrip = normalizeUsageEntryForTest(JSON.parse(JSON.stringify(rows[0])))!;
    expect(roundTrip.attempts).toHaveLength(3);
    expect(roundTrip.attempts?.map(a => a.ordinal)).toEqual([1, 2, 3]);
    expect(roundTrip.attempts?.[0].accountLogLabel).toBe(labelA);
    expect(roundTrip.attempts?.[2].usage).toMatchObject({ inputTokens: 300, outputTokens: 40 });
    expect(roundTrip.usage).toMatchObject({ inputTokens: 400, outputTokens: 60 });
    expect(JSON.stringify(roundTrip)).not.toContain("test-key-");
  });
  test.each([
    ["generic OAuth", "o111111", "o222222"],
    ["Codex pool", "paaaaa1", "pbbbbb2"],
  ])("a %s account rotation opens its own attempt row", (_kind, first, second) => {
    const oauth = { adapter: "openai-responses" as const, authMode: "oauth" as const, baseUrl: "https://example.test" };
    const active = beginRequestAttempt(1, "xai", "model", "openai-responses");
    const ctx: RequestLogContext = { provider: "xai", model: "model", activeAttempt: active,
      activeAttemptStartedAt: Date.now(), attempts: [active], accountLogLabel: first };
    noteProviderAttemptSend(ctx, "xai", oauth, undefined);
    recordKeyAttemptUsage(ctx, { inputTokens: 100, outputTokens: 10 });
    ctx.accountLogLabel = second;
    noteProviderAttemptSend(ctx, "xai", oauth, undefined, "rate-limit-429");
    expect(ctx.activeAttempt).toBe(active);
    expect(ctx.attempts).toHaveLength(2);
    expect(ctx.attempts?.[0]).toMatchObject({ ordinal: 1, accountLogLabel: first, sendCount: 1,
      usage: { inputTokens: 100, outputTokens: 10 } });
    // The second account's tokens land on their own row rather than on the first account's.
    expect(active).toMatchObject({ ordinal: 2, accountLogLabel: second, sendCount: 1 });
    expect(active.usage).toBeUndefined();
  });
  test.each([
    ["generic OAuth", "o111111", "o222222"],
    ["Codex pool", "paaaaa1", "pbbbbb2"],
  ])("a post-send seal preserves the old %s row before the next send", (_kind, first, second) => {
    const oauth = { adapter: "openai-responses" as const, authMode: "oauth" as const,
      baseUrl: "https://example.test" };
    const active = beginRequestAttempt(1, "xai", "model", "openai-responses");
    const ctx: RequestLogContext = { provider: "xai", model: "model", activeAttempt: active,
      activeAttemptStartedAt: Date.now(), attempts: [active], accountLogLabel: first };

    noteProviderAttemptSend(ctx, "xai", oauth, undefined);
    recordKeyAttemptUsage(ctx, { inputTokens: 100, outputTokens: 10 });

    ctx.accountLogLabel = second;
    sealRequestAttemptIdentity(active, "xai", "openai-responses", second);
    noteProviderAttemptSend(ctx, "xai", oauth, undefined, "rate-limit-429");
    recordKeyAttemptUsage(ctx, { inputTokens: 50, outputTokens: 5 });

    expect(ctx.attempts).toHaveLength(2);
    expect(ctx.attempts?.[0]).toMatchObject({
      ordinal: 1, accountLogLabel: first, sendCount: 1,
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    expect(active).toMatchObject({
      ordinal: 2, accountLogLabel: second, sendCount: 1,
      usage: { inputTokens: 50, outputTokens: 5 },
    });
  });
  test("a sent attempt keeps the account-qualified provider it spent its tokens on", () => {
    // Anthropic pool accounts carry no label at all -- `stampOAuthAccountLabel` skips that base
    // provider -- so the account lives in the log provider string and the seal used to erase it.
    const oauth = { adapter: "anthropic-messages", authMode: "oauth" as const, baseUrl: "https://example.test" };
    const firstProvider = formatAnthropicProviderForLog("anthropic", "account-a");
    const secondProvider = formatAnthropicProviderForLog("anthropic", "account-b");
    expect(firstProvider).toMatch(/^anthropic-p[a-f0-9]{6}$/);
    expect(secondProvider).toMatch(/^anthropic-p[a-f0-9]{6}$/);
    const active = beginRequestAttempt(1, "anthropic", "model", "anthropic-messages");
    const ctx: RequestLogContext = { provider: firstProvider, model: "model",
      activeAttempt: active, activeAttemptStartedAt: Date.now(), attempts: [active] };
    noteProviderAttemptSend(ctx, "anthropic", oauth, undefined);
    expect(active).toMatchObject({ provider: firstProvider, sendCount: 1 });
    ctx.provider = secondProvider;
    sealRequestAttemptIdentity(active, ctx.provider, "anthropic-messages", ctx.accountLogLabel);
    expect(active.provider).toBe(firstProvider);
  });
  test("an Anthropic account rotation opens its own attempt row", () => {
    // No label to compare: the account lives in the account-qualified log provider string.
    const oauth = { adapter: "anthropic-messages", authMode: "oauth" as const, baseUrl: "https://example.test" };
    const firstProvider = formatAnthropicProviderForLog("anthropic", "account-a");
    const secondProvider = formatAnthropicProviderForLog("anthropic", "account-b");
    const active = beginRequestAttempt(1, "anthropic", "model", "anthropic-messages");
    const ctx: RequestLogContext = { provider: firstProvider, model: "model",
      activeAttempt: active, activeAttemptStartedAt: Date.now(), attempts: [active] };
    noteProviderAttemptSend(ctx, "anthropic", oauth, undefined);
    recordKeyAttemptUsage(ctx, { inputTokens: 100, outputTokens: 10 });
    ctx.provider = secondProvider;
    // The dispatch paths re-seal between sends (src/server/responses/request-transport.ts:691).
    // That re-stamp is what used to launder the rotation before the split below could read it.
    sealRequestAttemptIdentity(active, ctx.provider, "anthropic-messages", ctx.accountLogLabel);
    noteProviderAttemptSend(ctx, "anthropic", oauth, undefined, "rate-limit-429");
    recordKeyAttemptUsage(ctx, { inputTokens: 50, outputTokens: 5 });
    expect(ctx.activeAttempt).toBe(active);
    expect(ctx.attempts).toHaveLength(2);
    // Each account keeps the tokens it actually spent.
    expect(ctx.attempts?.[0]).toMatchObject({ ordinal: 1, provider: firstProvider,
      sendCount: 1, usage: { inputTokens: 100, outputTokens: 10 } });
    expect(active).toMatchObject({ ordinal: 2, provider: secondProvider,
      sendCount: 1, usage: { inputTokens: 50, outputTokens: 5 } });
  });
  test("wire snapshots replace the current send against a pre-send baseline", () => {
    const active = beginRequestAttempt(1, "test", "model", "openai-chat");
    const ctx: RequestLogContext = { provider: "test", model: "model", activeAttempt: active, attempts: [active] };
    const key = { adapter: "openai-chat" as const, authMode: "key" as const, baseUrl: "https://example.test", _apiKeyAttempt: { reference: "synthetic-a" } };
    noteProviderAttemptSend(ctx, "test", key, undefined);
    applyResponseLogMetadata(ctx, { usage: { prompt_tokens: 10, completion_tokens: 1 } });
    inspectResponseLogSsePayload(ctx, JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    noteProviderAttemptSend(ctx, "test", key, undefined);
    applyResponseLogMetadata(ctx, { usage: { prompt_tokens: 3, completion_tokens: 2 } });
    applyResponseLogMetadata(ctx, { usage: { prompt_tokens: 3, completion_tokens: 2 } });
    finishRequestAttempt(active, 200, 1);
    expect(active.usage).toMatchObject({ inputTokens: 13, outputTokens: 3 });
    expect(active.usage?.estimated).toBeUndefined();
  });
  test("an estimated baseline plus repeated and progressive wire snapshots stay one current send", () => {
    const active = beginRequestAttempt(1, "test", "model", "openai-chat");
    const ctx: RequestLogContext = { provider: "test", model: "model", activeAttempt: active, attempts: [active] };
    const key = { adapter: "openai-chat" as const, authMode: "key" as const, baseUrl: "https://example.test", _apiKeyAttempt: { reference: "synthetic-a" } };
    noteProviderAttemptSend(ctx, "test", key, undefined);
    recordKeyAttemptUsage(ctx, { inputTokens: 10, outputTokens: 0, estimated: true });
    noteProviderAttemptSend(ctx, "test", key, undefined);
    applyResponseLogMetadata(ctx, { usage: { prompt_tokens: 3, completion_tokens: 2 } });
    applyResponseLogMetadata(ctx, { usage: { prompt_tokens: 3, completion_tokens: 2 } });
    applyResponseLogMetadata(ctx, { usage: { prompt_tokens: 4, completion_tokens: 2 } });
    finishRequestAttempt(active, 200, 1);
    expect(active).toMatchObject({
      usageStatus: "estimated",
      usage: { inputTokens: 14, outputTokens: 2, estimated: true },
    });
  });
});

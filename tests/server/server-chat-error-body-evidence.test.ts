import { comboFailureDecision, comboFailureCooldownScope } from "../../src/combos/failover";
import { expect, test } from "bun:test";
import { attachComboFailureEvidence } from "../../src/lib/client-error-body";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { markVerifiedModelNotInPlanResponse } from "../../src/lib/errors";
import { markResponseNonReplayable, markReplayRefusalResponse } from "../../src/lib/upstream-retry";
import { responseWithDeferredRequestLog, markPreinspectedJsonResponse } from "../../src/server/relay";
import { createBoundedResponseLogBody } from "../../src/server/response-log-body";
import type { RequestLogContext } from "../../src/server/request-log";

const KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
for (const [status, code, message] of [[429, "rate_limit_exceeded", "rate limit"], [500, "insufficient_quota", "quota exhausted"],
  [400, "cyber_policy", "cyber policy"], [400, "model_not_in_plan", "plan refusal"], [429, "upstream_reset_replay_refused", "connection closed"],
  [403, "model_not_allowed_for_key", "not allowed"], [400, "usage_limit_reached", "usage limit reached"], [401, "invalid_api_key", "invalid api key"]] as const) {
  for (const size of [0, 65535, 65536, 65537]) test(`combo legacy evidence ${code}, bytes=${size || "small"}`, async () => {
    let legacy = JSON.stringify({ error: { message: `${message} ${KEY}`, type: code === "model_not_allowed_for_key" ? code : "upstream_error", code }, usage: { input_tokens: 3, output_tokens: 2 } });
    if (size) legacy += " ".repeat(size - Buffer.byteLength(legacy));
    const make = (text: string) => {
      const response = new Response(text, { status, headers: { "retry-after": "7", "x-codex-primary-reset-at": "2000000000" } });
      if (code === "model_not_in_plan") markVerifiedModelNotInPlanResponse(response);
      if (code === "upstream_reset_replay_refused") markReplayRefusalResponse(response);
      if (code === "model_not_allowed_for_key") markResponseNonReplayable(response);
      return response;
    };
    const before = await consumeComboFailure(make(legacy), undefined, 1800000000000);
    const after = await consumeComboFailure(attachComboFailureEvidence(make(JSON.stringify({ error: { message: "The provider failed to complete the request.", type: "server_error", code: null } })), legacy), undefined, 1800000000000);
    expect(after.response.status).toBe(before.response.status);
    const beforeBody = await before.response.text(); const afterBody = await after.response.text();
    expect(afterBody).toBe(beforeBody);
    const { response: a, ...factsA } = after; const { response: b, ...factsB } = before;
    expect(factsA).toEqual(factsB);
    expect(comboFailureDecision(after.response.status, after.classificationText, { code: after.upstreamCode, verifiedPlanRefusal: after.verifiedPlanRefusal }))
      .toBe(comboFailureDecision(before.response.status, before.classificationText, { code: before.upstreamCode, verifiedPlanRefusal: before.verifiedPlanRefusal }));
    expect(comboFailureCooldownScope(after.response.status, after.classificationText, { code: after.upstreamCode }))
      .toBe(comboFailureCooldownScope(before.response.status, before.classificationText, { code: before.upstreamCode }));
    expect([...a.headers]).toEqual([...b.headers]);
  });
}
for (const length of [32700, 32800]) test(`combo multibyte bounded evidence ${length}`, async () => {
  const legacy = JSON.stringify({ error: { message: `quota exhausted ${KEY}`, type: "é".repeat(length), code: KEY } });
  const before = await consumeComboFailure(new Response(legacy, { status: 500 }));
  const after = await consumeComboFailure(attachComboFailureEvidence(new Response("{}", { status: 500 }), legacy));
  expect(after.classificationText).toBe(before.classificationText);
  expect(after.upstreamCode).toBe(before.upstreamCode);
});
for (const end of ["eof", "cancel", "chunk-cancel", "read-error"] as const) {
  for (const earlier of [{}, { upstreamError: "earlier" }, { upstreamErrorCode: "rate_limit_exceeded", upstreamErrorType: "rate_limit_error" }]) {
    test(`deferred legacy inspection ${end} earlier=${JSON.stringify(earlier)}`, async () => {
      const legacy = JSON.stringify({ error: { message: `rate limit ${KEY}`, type: "rate_limit_error", code: "rate_limit_exceeded" } });
      async function inspect(owned: boolean) {
        const ctx: RequestLogContext = { model: "fixture", provider: "fixture", ...earlier };
        const rows: unknown[] = [];
        let count = 0;
        const body = new ReadableStream<Uint8Array>({ pull(controller) {
          if (count++ === 0) controller.enqueue(new TextEncoder().encode(owned ? "{}" : legacy));
          else if (end === "read-error") controller.error(new Error("fixture")); else controller.close();
        } }, { highWaterMark: 0 });
        const response = responseWithDeferredRequestLog(new Response(body, { status: 429, headers: { "content-type": "application/json" } }), "fixture", Date.now(), ctx, row => rows.push(row), owned ? legacy : undefined);
        expect(response.status).toBe(429);
        if (end === "cancel") await response.body!.cancel();
        else if (end === "chunk-cancel") { const reader = response.body!.getReader(); expect((await reader.read()).done).toBe(false); await reader.cancel(); }
        else { try { await response.text(); } catch { expect(end).toBe("read-error"); } }
        expect(rows).toHaveLength(1);
        return { ctx, rows };
      }
      const before = await inspect(false); const after = await inspect(true);
      // Timing fields belong to the request clock, not body inspection.
      for (const result of [before, after]) for (const row of result.rows as Array<Record<string, unknown>>) { delete row.timestamp; delete row.latencyMs; delete row.ttfbMs; delete row.durationMs; }
      expect(after).toEqual(before);
    });
  }
}
test("legacy source owns the JSON inspection size bound", async () => {
  for (const legacy of ['{"a":1}', '{"a":"too large"}']) {
    const seen: string[] = [];
    const body = createBoundedResponseLogBody(new Response("{}").body!, { json: true, inspectionSource: legacy, maxInspectionBytes: 8, inspect: text => seen.push(text), finalize() {} });
    expect(await new Response(body).text()).toBe("{}");
    expect(seen).toEqual(Buffer.byteLength(legacy) <= 8 ? [legacy] : []);
  }
});
test("preinspected JSON suppresses the legacy override", async () => {
  const ctx: RequestLogContext = { model: "fixture", provider: "fixture" };
  const original = new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
  markPreinspectedJsonResponse(original);
  const response = responseWithDeferredRequestLog(original, "fixture", Date.now(), ctx, () => {}, JSON.stringify({ error: { message: KEY } }));
  expect(response.status).toBe(400); await response.text();
  expect(ctx.upstreamError).toBeUndefined();
});

test("deferred legacy inspection preserves numeric reset and diagnostic projection", async () => {
  const resetAt = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const legacy = JSON.stringify({ error: { message: `Subscription quota exhausted. Your usage window resets at ${resetAt}.`, type: "rate_limit_error", code: "rate_limit_exceeded", param: KEY } });
  async function project(owned: boolean) {
    const ctx: RequestLogContext = { provider: "meta-muse", model: "fixture" }; const rows: Array<Record<string, unknown>> = [];
    const response = responseWithDeferredRequestLog(new Response(owned ? "{}" : legacy, { status: 429, headers: { "content-type": "application/json" } }), "fixture", Date.now(), ctx, row => rows.push(row as unknown as Record<string, unknown>), owned ? legacy : undefined);
    expect(response.status).toBe(429); await response.text(); expect(rows).toHaveLength(1);
    const row = rows[0]!; expect(row.rateLimitResetAt).toBe(Date.parse(resetAt)); expect(row.errorCode).toBe("rate_limit_exceeded"); expect(row.upstreamCondition).toBe("rate_limited");
    expect(JSON.stringify(row)).not.toContain(KEY); delete row.durationMs; delete row.timestamp;
    return { row, ctx };
  }
  expect(await project(true)).toEqual(await project(false));
});

test("combo rebuilding carries only the original local response identity", async () => {
  const { markProxyError, isProxyError } = await import("../../src/lib/client-error-body");
  const envelope = { error: { type: "authentication_error", code: "invalid_api_key", message: "owned local refusal" } };
  const local = await consumeComboFailure(markProxyError(Response.json(envelope, { status: 401 })));
  const upstream = await consumeComboFailure(Response.json({ ...envelope, proxyAuthored: true }, { status: 401 }));
  expect(local.response.status).toBe(401);
  expect(upstream.response.status).toBe(401);
  expect(isProxyError(upstream.response)).toBe(false);
  expect(isProxyError(local.response)).toBe(true);
});

test("local auth constructors own their response and copied fields do not", async () => {
  const { nativeMainRefreshFailureResponse } = await import("../../src/server/responses/codex-auth-error");
  const { isProxyError } = await import("../../src/lib/client-error-body");
  const response = nativeMainRefreshFailureResponse(new Error(KEY));
  expect(response.status).toBe(401);
  const body = await response.json();
  expect(body.error.type).toBe("authentication_error");
  expect(body.error.code).toBe("invalid_api_key");
  expect(isProxyError(response)).toBe(true);
  const copy = Response.json({ ...body, proxyAuthored: true }, { status: 401 });
  expect(copy.status).toBe(401);
  expect(isProxyError(copy)).toBe(false);
  expect(JSON.stringify(body)).not.toContain(KEY);
});

test("non-replayable projection carries local identity without granting it to copied fields", async () => {
  const { markProxyError, isProxyError } = await import("../../src/lib/client-error-body");
  const { sanitizeNonReplayableUpstreamError } = await import("../../src/server/responses/non-replayable-error");
  const envelope = { error: { type: "permission_error", code: "model_not_allowed_for_key", message: KEY }, proxyAuthored: true };
  const local = markProxyError(Response.json(envelope, { status: 403 }));
  const upstream = Response.json(envelope, { status: 403 });
  markResponseNonReplayable(local); markResponseNonReplayable(upstream);
  const own = await sanitizeNonReplayableUpstreamError(local, new AbortController().signal);
  const copy = await sanitizeNonReplayableUpstreamError(upstream, new AbortController().signal);
  expect(own.status).toBe(403); expect(copy.status).toBe(403);
  const body = await own.json();
  expect(body.error.type).toBe("permission_error"); expect(body.error.code).toBeUndefined();
  expect(isProxyError(copy)).toBe(false);
  expect(isProxyError(own)).toBe(true);
  expect(JSON.stringify(body)).not.toContain(KEY);
});

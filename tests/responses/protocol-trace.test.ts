/**
 * Observed protocol trace derivation (src/protocols/trace.ts, PF-02).
 */
import { describe, expect, test } from "bun:test";
import { PROTOCOL_CONTRACT_VERSION } from "../../src/protocols/contract";
import { isProtocolTraceV1, PROTOCOL_DTO_LIMITS } from "../../src/protocols/dto";
import {
  markAttemptProtocolPath,
  markProtocolBlocked,
  markProtocolEntry,
  protocolTraceForRequest,
} from "../../src/protocols/trace";

const attempt = (ordinal: number, adapter: string) => ({ ordinal, adapter });

describe("protocolTraceForRequest", () => {
  test("Responses ingress needs no mark and follows the final adapter", () => {
    const ctx = { inboundProtocol: "responses" as const };
    const trace = protocolTraceForRequest(ctx, [attempt(1, "openai-responses")]);
    expect(trace).toMatchObject({
      v: 1,
      inbound: "responses",
      mode: "native",
      upstream: "responses",
      requestPath: ["responses", "responses"],
      responsePath: ["responses", "responses"],
      reasonCodes: ["same-wire-native"],
      contractVersion: PROTOCOL_CONTRACT_VERSION,
    });
    expect(isProtocolTraceV1(trace)).toBe(true);

    const translated = protocolTraceForRequest(ctx, [attempt(1, "anthropic")]);
    expect(translated?.requestPath).toEqual(["responses", "ir", "messages"]);
    expect(translated?.mode).toBe("translated");
    expect(translated?.reasonCodes).toEqual(["cross-wire-ir"]);
  });

  test("no attempt and no native or blocked mark means no trace", () => {
    expect(protocolTraceForRequest({ inboundProtocol: "responses" }, [])).toBeUndefined();
    expect(protocolTraceForRequest({ inboundProtocol: "chat" }, [attempt(1, "openai-chat")])).toBeUndefined();
    const bridged = {};
    markProtocolEntry(bridged, { inbound: "chat", lane: "bridge" });
    expect(protocolTraceForRequest(bridged, undefined)).toBeUndefined();
    expect(protocolTraceForRequest({}, undefined)).toBeUndefined();
  });

  test("a native Chat lane is chat to chat, with features passed through", () => {
    const ctx = {};
    markProtocolEntry(ctx, { inbound: "chat", lane: "native", features: () => ["request.tools", "request.seed"] });
    const trace = protocolTraceForRequest(ctx, [attempt(1, "openai-chat")]);
    expect(trace).toMatchObject({
      inbound: "chat",
      mode: "native",
      upstream: "chat",
      requestPath: ["chat", "chat"],
      featureEffects: [
        { feature: "request.tools", disposition: "passthrough" },
        { feature: "request.seed", disposition: "passthrough" },
      ],
      attempts: [{ ordinal: 1, upstream: "chat", mode: "native", requestPath: ["chat", "chat"] }],
    });
    expect(trace?.attempts?.[0]).not.toHaveProperty("responsePath");
    expect(isProtocolTraceV1(trace)).toBe(true);
  });

  test("a native Messages passthrough without an attempt still has a path", () => {
    const ctx = {};
    markProtocolEntry(ctx, { inbound: "messages", lane: "native", reasonCodes: ["same-wire-native"] });
    const trace = protocolTraceForRequest(ctx, undefined);
    expect(trace).toMatchObject({ mode: "native", upstream: "messages", requestPath: ["messages", "messages"] });
    expect(trace?.reasonCodes).toEqual(["same-wire-native"]);
    expect(trace).not.toHaveProperty("attempts");
  });

  test("a bridge lane reports the internal Responses hop and the declined reason", () => {
    const ctx = {};
    markProtocolEntry(ctx, {
      inbound: "chat",
      lane: "bridge",
      reasonCodes: ["cross-wire-ir"],
      features: ["request.seed", "request.tools"],
    });
    const trace = protocolTraceForRequest(ctx, [attempt(1, "anthropic")]);
    expect(trace).toMatchObject({
      mode: "legacy-bridge",
      upstream: "messages",
      requestPath: ["chat", "responses-internal", "ir", "messages"],
      responsePath: ["messages", "ir", "responses-internal", "chat"],
      reasonCodes: ["cross-wire-ir", "not-migrated"],
      featureEffects: [
        { feature: "request.tools", disposition: "translated" },
        { feature: "request.seed", disposition: "unsupported" },
      ],
    });
    const codec = {};
    markProtocolEntry(codec, { inbound: "messages", lane: "bridge" });
    expect(protocolTraceForRequest(codec, [attempt(1, "openai-responses")])).toMatchObject({
      mode: "translated",
      requestPath: ["messages", "responses"],
      reasonCodes: ["cross-wire-codec"],
    });
  });

  test("combo attempts each keep their own path and the final one decides", () => {
    const ctx = {};
    markProtocolEntry(ctx, { inbound: "chat", lane: "bridge" });
    const trace = protocolTraceForRequest(ctx, [attempt(1, "cursor"), attempt(2, "openai-responses")]);
    expect(trace?.mode).toBe("translated");
    expect(trace?.attempts?.map(a => [a.ordinal, a.upstream, a.mode])).toEqual([
      [1, "other", "legacy-bridge"],
      [2, "responses", "translated"],
    ]);
  });

  test("an explicit attempt mark overrides the lane-derived path", () => {
    const ctx = {};
    const live = attempt(1, "anthropic");
    markProtocolEntry(ctx, { inbound: "messages", lane: "bridge" });
    markAttemptProtocolPath(live, { mode: "translated", requestPath: ["messages", "ir", "messages"], responsePath: ["messages", "messages"] });
    const trace = protocolTraceForRequest(ctx, [live]);
    expect(trace?.mode).toBe("translated");
    expect(trace?.attempts?.[0]?.responsePath).toEqual(["messages", "messages"]);
    expect(isProtocolTraceV1(trace)).toBe(true);
  });

  test("a blocked mark wins and carries no path", () => {
    const ctx = {};
    markProtocolBlocked(ctx, { inbound: "messages", reasonCodes: ["surface-disabled"] });
    const trace = protocolTraceForRequest(ctx, [attempt(1, "anthropic")]);
    expect(trace).toMatchObject({ mode: "blocked", requestPath: [], responsePath: [], reasonCodes: ["surface-disabled"] });
    expect(trace).not.toHaveProperty("upstream");
    expect(isProtocolTraceV1(trace)).toBe(true);
  });

  test("limits hold and a throwing feature scan is contained", () => {
    const ctx = {};
    markProtocolEntry(ctx, {
      inbound: "chat",
      lane: "bridge",
      features: () => { throw new Error("boom"); },
    });
    // The mark is dropped, not half-written; the request carries on.
    expect(protocolTraceForRequest(ctx, [attempt(1, "anthropic")])).toBeUndefined();

    const many = {};
    markProtocolEntry(many, { inbound: "responses", lane: "bridge" });
    const attempts = Array.from({ length: PROTOCOL_DTO_LIMITS.attempts + 4 }, (_, i) => attempt(i + 1, "openai-responses"));
    const trace = protocolTraceForRequest(many, attempts);
    expect(trace?.attempts).toHaveLength(PROTOCOL_DTO_LIMITS.attempts);
    expect(trace?.attempts?.at(-1)?.ordinal).toBe(PROTOCOL_DTO_LIMITS.attempts + 4);
    expect(isProtocolTraceV1(trace)).toBe(true);
  });
});

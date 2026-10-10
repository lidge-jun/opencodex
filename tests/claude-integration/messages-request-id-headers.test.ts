import { expect, test } from "bun:test";
import { withMessagesRequestLogId, withRequestLogId } from "../../src/server/index/startup-warnings";
import { retainUpstreamMessagesRequestId, upstreamMessagesRequestIdHeaders } from "../../src/server/messages-response-headers";

const ocxId = `ocx-${"1".repeat(32)}`;

test("Messages uses the ledger id and preserves the upstream id and existing exposure", async () => {
  const original = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("fixture"));
      controller.close();
    },
  }), { status: 429, statusText: "Fixture Refusal", headers: {
    "request-id": "req_fixture",
    "x-opencodex-request-id": "caller-controlled",
    "x-opencodex-upstream-request-id": "caller-controlled",
    "Access-Control-Expose-Headers": "X-Existing, ReQuEsT-Id",
    "retry-after": "3",
  } });
  const body = original.body;
  const response = withMessagesRequestLogId(original, ocxId);
  expect(response.body).toBe(body);
  expect(response.status).toBe(429);
  expect(response.statusText).toBe("Fixture Refusal");
  expect(response.headers.get("request-id")).toBe(ocxId);
  expect(response.headers.get("x-opencodex-request-id")).toBe(ocxId);
  expect(response.headers.get("x-opencodex-upstream-request-id")).toBe("req_fixture");
  expect(response.headers.get("retry-after")).toBe("3");
  const exposed = response.headers.get("Access-Control-Expose-Headers")!.toLowerCase().split(",").map(value => value.trim());
  expect(exposed).toContain("x-existing");
  expect(exposed.filter(value => value === "request-id")).toHaveLength(1);
  expect(exposed).toContain("x-opencodex-request-id");
  expect(exposed).toContain("x-opencodex-upstream-request-id");
  expect(await response.text()).toBe("fixture");
});

test("Responses keeps its existing request-id semantics", () => {
  const response = withRequestLogId(new Response(null, { headers: { "request-id": "req_fixture" } }), ocxId);
  expect(response.headers.get("request-id")).toBe("req_fixture");
  expect(response.headers.get("x-opencodex-request-id")).toBe(ocxId);
  expect(response.headers.has("x-opencodex-upstream-request-id")).toBe(false);
});

test("upstream metadata is bounded, allowlisted and never invented", () => {
  expect(upstreamMessagesRequestIdHeaders(new Headers({ "request-id": "req_fixture", "set-cookie": "fixture" })))
    .toEqual({ "request-id": "req_fixture" });
  for (const value of ["", "account_fixture", "req_", `req_${"x".repeat(129)}`, "req_has space"]) {
    expect(upstreamMessagesRequestIdHeaders(new Headers({ "request-id": value }))).toEqual({});
    const response = withMessagesRequestLogId(new Response(null, { headers: {
      "request-id": value, "x-opencodex-upstream-request-id": "untrusted",
    } }), ocxId);
    expect(response.headers.has("x-opencodex-upstream-request-id")).toBe(false);
    expect(response.headers.get("request-id")).toBe(ocxId);
  }
  expect(upstreamMessagesRequestIdHeaders(new Headers())).toEqual({});
});

test("native retention preserves Response identity and cancellation without reading or teeing", async () => {
  let cancelled: unknown;
  const original = new Response(new ReadableStream<Uint8Array>({
    cancel(reason) { cancelled = reason; },
  }, { highWaterMark: 0 }));
  expect(retainUpstreamMessagesRequestId(original, new Headers({ "request-id": "req_fixture" }))).toBe(original);
  const response = withMessagesRequestLogId(original, ocxId);
  expect(response.body).toBe(original.body);
  await response.body!.cancel("fixture-cancel");
  expect(cancelled).toBe("fixture-cancel");
});

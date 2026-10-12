import { describe, expect, test } from "bun:test";
import { isAnthropicBillingRefusal, readAnthropicBillingRefusal } from "../../../src/providers/anthropic-billing-refusal";

const message = "Your credit balance is too low to access the Anthropic API.";
const payload = (type = "invalid_request_error", text = message) => ({ type: "error", error: { type, message: text } });
const response = (body: string, status = 400, contentType = "application/json") => new Response(body, {
  status, headers: { "content-type": contentType },
});

describe("Anthropic billing refusal evidence", () => {
  for (const status of [400, 402]) for (const type of ["invalid_request_error", "billing_error", "permission_error"]) {
    test(`${status} ${type} accepts the whole credit-balance message`, () => {
      expect(isAnthropicBillingRefusal(status, payload(type))).toBe(true);
      expect(isAnthropicBillingRefusal(status, payload(type, `${message} Please go to Plans & Billing to upgrade or purchase credits.`))).toBe(true);
    });
  }

  test("unrelated statuses, codes, messages and envelopes are not evidence", () => {
    for (const status of [200, 401, 403, 429, 500]) expect(isAnthropicBillingRefusal(status, payload())).toBe(false);
    for (const type of ["authentication_error", "api_error", "rate_limit_error", "", null]) {
      expect(isAnthropicBillingRefusal(400, { type: "error", error: { type, message } })).toBe(false);
    }
    for (const code of ["context_length_exceeded", "invalid_api_key", 1, {}, ""]) {
      expect(isAnthropicBillingRefusal(400, { ...payload(), error: { ...payload().error, code } })).toBe(false);
    }
    for (const text of [`Diagnostic: ${message}`, `"${message}"`, `${message} Model access denied.`, "Your account does not have an active subscription", "Insufficient credits", "Invalid request"]) {
      expect(isAnthropicBillingRefusal(400, payload("invalid_request_error", text))).toBe(false);
    }
    for (const value of [null, [], { error: payload().error }, { type: "message", error: payload().error }, { response: payload() }, { type: "error", error: [] }]) {
      expect(isAnthropicBillingRefusal(400, value)).toBe(false);
    }
  });

  test("only the existing explicit account-refusal code allowlist is accepted", () => {
    for (const code of [null, "subscription_required", "insufficient_quota", "permission_denied"]) {
      expect(isAnthropicBillingRefusal(400, { ...payload(), error: { ...payload().error, code } })).toBe(true);
    }
  });

  test("complete JSON is inspected without consuming the terminal body", async () => {
    const body = JSON.stringify(payload());
    const upstream = response(body);
    expect(await readAnthropicBillingRefusal(upstream)).toBe(true);
    expect(upstream.bodyUsed).toBe(false);
    expect(await upstream.text()).toBe(body);
  });

  test("malformed, truncated, non-JSON and over-limit bodies retain their original bytes", async () => {
    for (const body of [JSON.stringify(payload()).slice(0, -1), "{", JSON.stringify(payload("invalid_request_error", "Invalid request")), JSON.stringify(payload()) + " ".repeat(8192)]) {
      const upstream = response(body);
      expect(await readAnthropicBillingRefusal(upstream)).toBe(false);
      expect(await upstream.text()).toBe(body);
    }
    const html = response(JSON.stringify(payload()), 400, "text/html");
    expect(await readAnthropicBillingRefusal(html)).toBe(false);
    expect(html.bodyUsed).toBe(false);
  });

  test("the 8 KiB byte boundary is inclusive", async () => {
    const base = JSON.stringify(payload());
    const bounded = response(base + " ".repeat(8192 - new TextEncoder().encode(base).length));
    expect(await readAnthropicBillingRefusal(bounded)).toBe(true);
  });

  test("invalid UTF-8 is never authority even when inside ignorable JSON fields", async () => {
    const prefix = new TextEncoder().encode(JSON.stringify(payload()).slice(0, -1) + ',"request_id":"');
    const suffix = new TextEncoder().encode('"}');
    const bytes = new Uint8Array([...prefix, 0xff, ...suffix]);
    const upstream = new Response(bytes, { status: 400, headers: { "content-type": "application/json" } });
    expect(await readAnthropicBillingRefusal(upstream)).toBe(false);
    expect(new Uint8Array(await upstream.arrayBuffer())).toEqual(bytes);
  });

  test("read failure leaves the original errored body untouched", async () => {
    const failure = new Error("fixture body read failure");
    const upstream = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } }), {
      status: 400, headers: { "content-type": "application/json" },
    });
    expect(await readAnthropicBillingRefusal(upstream)).toBe(false);
    expect(upstream.bodyUsed).toBe(false);
    await expect(upstream.text()).rejects.toBe(failure);
  });

  test("a stalled clone stops after the explicit deadline and leaves the original readable", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), {
      status: 400, headers: { "content-type": "application/json" },
    });
    const started = performance.now();
    expect(await readAnthropicBillingRefusal(upstream)).toBe(false);
    expect(performance.now() - started).toBeGreaterThanOrEqual(200);
    expect(performance.now() - started).toBeLessThan(1500);
    controller.enqueue(new TextEncoder().encode(JSON.stringify(payload())));
    controller.close();
    expect(await upstream.text()).toBe(JSON.stringify(payload()));
  });

  test("cancellation stops a pending body read without consuming the original", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const signal = new AbortController();
    const upstream = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), {
      status: 402, headers: { "content-type": "application/json" },
    });
    const reading = readAnthropicBillingRefusal(upstream, signal.signal);
    signal.abort();
    expect(await reading).toBe(false);
    controller.enqueue(new TextEncoder().encode(JSON.stringify(payload())));
    controller.close();
    expect(await upstream.text()).toBe(JSON.stringify(payload()));
    const cancelled = response(JSON.stringify(payload()));
    expect(await readAnthropicBillingRefusal(cancelled, signal.signal)).toBe(false);
    expect(cancelled.bodyUsed).toBe(false);
  });
});

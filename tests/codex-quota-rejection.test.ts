import { describe, expect, test } from "bun:test";
import { classifyCodexPreStreamRejection } from "../src/codex/quota-rejection";
import { BOUNDED_BODY_MAX_BYTES } from "../src/lib/bounded-body";
import { shouldRetryCodexPoolAccountQuota } from "../src/server/responses/core";

function jsonRejection(status: number, error: Record<string, unknown>): Response {
  return Response.json({ error }, { status });
}

function jsonPayload(status: number, payload: Record<string, unknown>): Response {
  return Response.json(payload, { status });
}

describe("Codex pre-stream quota rejection classification", () => {
  test("a 403 naming a workspace denial carries structured denial evidence (#1789)", async () => {
    // The credential is valid; the account simply cannot reach this workspace. Without this
    // evidence routing quarantines the account for reauth, which cannot fix a workspace grant.
    const nested = await classifyCodexPreStreamRejection(jsonRejection(403, {
      code: "codex_workspace_access_denied",
      message: "workspace access denied",
    }));
    expect(nested).toMatchObject({ kind: "permission-error", denial: "workspace" });

    const topLevel = await classifyCodexPreStreamRejection(jsonPayload(403, {
      code: "workspace_access_denied",
    }));
    expect(topLevel).toMatchObject({ kind: "permission-error", denial: "workspace" });

    const detail = await classifyCodexPreStreamRejection(jsonPayload(403, {
      detail: {
        code: "codex_workspace_access_denied",
        message: "workspace access denied",
      },
    }));
    expect(detail).toMatchObject({ kind: "permission-error", denial: "workspace" });

    const entitlement = await classifyCodexPreStreamRejection(jsonRejection(403, {
      code: "codex_entitlement_missing",
    }));
    expect(entitlement).toMatchObject({ kind: "permission-error", denial: "entitlement" });

    const detailEntitlement = await classifyCodexPreStreamRejection(jsonPayload(403, {
      detail: { code: "entitlement_missing" },
    }));
    expect(detailEntitlement).toMatchObject({ kind: "permission-error", denial: "entitlement" });
  });

  test("a 403 without denial evidence stays an ordinary permission error (#1789)", async () => {
    // Fail safe: status alone must never downgrade a credential failure, or a genuinely
    // revoked credential would stop prompting for reauthentication.
    const unknownCode = await classifyCodexPreStreamRejection(jsonRejection(403, {
      code: "something_else",
    }));
    expect(unknownCode.denial).toBeUndefined();

    const noBody = await classifyCodexPreStreamRejection(new Response(null, { status: 403 }));
    expect(noBody).toMatchObject({ kind: "permission-error" });
    expect(noBody.denial).toBeUndefined();

    const malformed = await classifyCodexPreStreamRejection(new Response("{not json", { status: 403 }));
    expect(malformed.denial).toBeUndefined();

    const invalidDetail = await classifyCodexPreStreamRejection(jsonPayload(403, {
      detail: { code: 403 },
    }));
    expect(invalidDetail.denial).toBeUndefined();
  });

  test.each([
    [402, true],
    [429, true],
    [400, false],
    [503, false],
  ])("selects pool-account retries by HTTP %i", async (status, expected) => {
    await expect(shouldRetryCodexPoolAccountQuota(new Response(null, { status }))).resolves.toBe(expected);
  });

  test("recognizes a quota message wrapped in HTTP 5xx without consuming the response", async () => {
    const body = JSON.stringify({ error: { message: "The usage limit has been reached" } });
    const response = new Response(body, { status: 502 });

    await expect(shouldRetryCodexPoolAccountQuota(response)).resolves.toBe(true);
    expect(await response.text()).toBe(body);
  });

  test("does not match quota wording echoed outside JSON error.message", async () => {
    const response = Response.json({
      error: { message: "upstream server error" },
      request: { input: "Explain the usage limit" },
    }, { status: 502 });
    await expect(shouldRetryCodexPoolAccountQuota(response)).resolves.toBe(false);
  });

  test.each([
    ["error.message", { error: { message: "The usage limit has been reached" } }],
    ["last_error.message", { last_error: { message: "The usage limit has been reached" } }],
    ["response.error.message", { response: { error: { message: "The usage limit has been reached" } } }],
    ["response.incomplete_details.message", {
      response: { incomplete_details: { message: "The usage limit has been reached" } },
    }],
  ])("recognizes the canonical %s upstream message path", async (_path, payload) => {
    await expect(shouldRetryCodexPoolAccountQuota(
      Response.json(payload, { status: 502 }),
    )).resolves.toBe(true);
  });

  test.each([
    ["JSON string", JSON.stringify("The usage limit has been reached")],
    ["top-level message", JSON.stringify({ message: "The usage limit has been reached" })],
    ["string error", JSON.stringify({ error: "The usage limit has been reached" })],
  ])("recognizes the valid %s fallback shape", async (_shape, body) => {
    await expect(shouldRetryCodexPoolAccountQuota(
      new Response(body, { status: 502 }),
    )).resolves.toBe(true);
  });

  test("recognizes a plain-text quota failure", async () => {
    const response = new Response("The usage limit has been reached", { status: 502 });
    await expect(shouldRetryCodexPoolAccountQuota(response)).resolves.toBe(true);
  });

  test.each([
    [502, JSON.stringify({ error: { message: "upstream server error" } })],
    [503, JSON.stringify({ error: { message: "servers overloaded" } })],
    [502, "x".repeat(BOUNDED_BODY_MAX_BYTES + 1)],
  ])("keeps unrelated or oversized HTTP %i failures transient", async (status, body) => {
    await expect(shouldRetryCodexPoolAccountQuota(new Response(body, { status }))).resolves.toBe(false);
  });

  test("fails closed for malformed UTF-8 and an already-aborted read", async () => {
    const malformed = new Uint8Array([
      0x54, 0x68, 0x65, 0x20, 0xff, 0x20, 0x75, 0x73, 0x61, 0x67, 0x65, 0x20, 0x6c, 0x69, 0x6d, 0x69, 0x74,
    ]);
    await expect(shouldRetryCodexPoolAccountQuota(
      new Response(malformed, { status: 502 }),
    )).resolves.toBe(false);

    const controller = new AbortController();
    controller.abort();
    await expect(shouldRetryCodexPoolAccountQuota(
      new Response("The usage limit has been reached", { status: 502 }),
      controller.signal,
    )).resolves.toBe(false);
  });

  test.each([
    [429, "nested code", { error: { code: "usage_limit_exceeded" } }, "usage_limit_exceeded"],
    [429, "nested type", { error: { type: "insufficient_quota" } }, "insufficient_quota"],
    [402, "nested code", { error: { code: "insufficient_quota" } }, "insufficient_quota"],
    [429, "root code", { code: "usage_limit_exceeded" }, "usage_limit_exceeded"],
    [402, "root type", { type: "insufficient_quota" }, "insufficient_quota"],
    [429, "matching code and type", {
      error: { code: "usage_limit_exceeded", type: "usage_limit_exceeded" },
    }, "usage_limit_exceeded"],
  ] as const)("accepts exact %s reset-eligible exhaustion on HTTP %i", async (
    status,
    _schema,
    payload,
    code,
  ) => {
    const result = await classifyCodexPreStreamRejection(jsonPayload(status, payload));
    expect(result).toEqual({
      kind: "reset-eligible-exhaustion",
      status,
      alternateRetryEligible: true,
      resetCreditEligible: true,
      semanticCode: code,
    });
  });

  test.each([
    ["leading and trailing whitespace", { error: { code: " usage_limit_exceeded " } }],
    ["uppercase", { error: { code: "USAGE_LIMIT_EXCEEDED" } }],
    ["mixed case", { type: "Insufficient_Quota" }],
    ["trailing whitespace at the root", { code: "insufficient_quota " }],
  ] as const)("rejects the %s near-miss", async (_case, payload) => {
    const result = await classifyCodexPreStreamRejection(jsonPayload(429, payload));
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
    expect(result).not.toHaveProperty("semanticCode");
  });

  test.each([
    ["primitive error with a root code", {
      error: "opaque",
      code: "usage_limit_exceeded",
    }],
    ["matching root and nested codes", {
      code: "usage_limit_exceeded",
      error: { code: "usage_limit_exceeded" },
    }],
    ["unknown root and eligible nested codes", {
      code: "unknown",
      error: { code: "usage_limit_exceeded" },
    }],
    ["eligible root code with an empty nested error", {
      code: "usage_limit_exceeded",
      error: {},
    }],
  ] as const)("fails closed for ambiguous schemas: %s", async (_case, payload) => {
    const result = await classifyCodexPreStreamRejection(jsonPayload(429, payload));
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
    expect(result).not.toHaveProperty("semanticCode");
  });

  test.each([
    ["root", '{"code":"rate_limit_error","code":"usage_limit_exceeded"}'],
    ["nested", '{"error":{"code":"rate_limit_error","code":"usage_limit_exceeded"}}'],
  ] as const)("fails closed for duplicate keys in a %s object", async (_case, body) => {
    const response = new Response(body, {
      status: 429,
      headers: { "content-type": "application/json" },
    });
    const result = await classifyCodexPreStreamRejection(response);
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
    expect(result).not.toHaveProperty("semanticCode");
    expect(await response.text()).toBe(body);
  });

  test.each([
    ["nested unknown code and eligible type", {
      error: { code: "unknown", type: "insufficient_quota" },
    }],
    ["root eligible code and unrelated type", {
      code: "usage_limit_exceeded",
      type: "rate_limit_error",
    }],
    ["two different eligible values", {
      error: { code: "usage_limit_exceeded", type: "insufficient_quota" },
    }],
    ["eligible code and non-string type", {
      error: { code: "usage_limit_exceeded", type: null },
    }],
  ] as const)("fails closed for code/type disagreement: %s", async (_case, payload) => {
    const result = await classifyCodexPreStreamRejection(jsonPayload(429, payload));
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
    expect(result).not.toHaveProperty("semanticCode");
  });

  test("keeps a generic 429 with Retry-After out of reset-credit eligibility", async () => {
    const response = jsonRejection(429, {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "try again later",
    });
    response.headers.set("retry-after", "60");
    await expect(classifyCodexPreStreamRejection(response)).resolves.toEqual({
      kind: "generic-rate-limit",
      status: 429,
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
  });

  test("does not trust reset-eligible words found only in a message", async () => {
    const result = await classifyCodexPreStreamRejection(jsonRejection(429, {
      type: "rate_limit_error",
      message: "usage_limit_exceeded: insufficient_quota",
    }));
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
  });

  test("fails closed when malformed UTF-8 would otherwise be replaced", async () => {
    const prefix = new TextEncoder().encode(
      '{"error":{"code":"usage_limit_exceeded","message":"',
    );
    const suffix = new TextEncoder().encode('"}}');
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix);
    bytes[prefix.length] = 0xff;
    bytes.set(suffix, prefix.length + 1);
    const response = new Response(bytes, {
      status: 429,
      headers: { "content-type": "application/json" },
    });

    const result = await classifyCodexPreStreamRejection(response);

    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
    expect(result).not.toHaveProperty("semanticCode");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

	test("fails closed for malformed JSON while preserving broad 429 failover", async () => {
		const response = new Response('{"error":', {
			status: 429,
			headers: { "content-type": "application/json" },
    });
    const result = await classifyCodexPreStreamRejection(response);
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
		expect(await response.text()).toBe('{"error":');
	});

	test("fails closed for an empty response body", async () => {
		const result = await classifyCodexPreStreamRejection(new Response(null, { status: 429 }));

		expect(result).toMatchObject({
			kind: "generic-rate-limit",
			alternateRetryEligible: true,
			resetCreditEligible: false,
		});
		expect(result).not.toHaveProperty("semanticCode");
	});

	test("fails closed for an oversized structured body", async () => {
		const response = jsonRejection(429, {
			code: "usage_limit_exceeded",
			padding: "x".repeat(BOUNDED_BODY_MAX_BYTES),
		});

		const result = await classifyCodexPreStreamRejection(response);

		expect(result).toMatchObject({
			kind: "generic-rate-limit",
			alternateRetryEligible: true,
			resetCreditEligible: false,
		});
		expect(result).not.toHaveProperty("semanticCode");
	});

	test("fails closed when a structured body is truncated by a transport error", async () => {
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"error":{"code":"usage_limit_exceeded"'));
				controller.error(new TypeError("transport truncated"));
			},
		}), {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		const result = await classifyCodexPreStreamRejection(response);

		expect(result).toMatchObject({
			kind: "generic-rate-limit",
			alternateRetryEligible: true,
			resetCreditEligible: false,
		});
		expect(result).not.toHaveProperty("semanticCode");
	});

	test("fails closed when the structured body was already consumed", async () => {
		const response = jsonRejection(429, { code: "usage_limit_exceeded" });
		await response.text();

		const result = await classifyCodexPreStreamRejection(response);

		expect(result).toMatchObject({
			kind: "generic-rate-limit",
			alternateRetryEligible: true,
			resetCreditEligible: false,
		});
		expect(result).not.toHaveProperty("semanticCode");
	});

	test.each([
    [503, "transient-server-error"],
    [401, "authentication-error"],
    [403, "permission-error"],
    [400, "other"],
  ] as const)("separates non-eligible HTTP %i as %s", async (status, kind) => {
    const result = await classifyCodexPreStreamRejection(jsonRejection(status, {
      code: "usage_limit_exceeded",
    }));
    expect(result).toMatchObject({
      kind,
      alternateRetryEligible: false,
      resetCreditEligible: false,
    });
  });

  test("classifies an unverified 402 without authorizing a reset credit", async () => {
    await expect(classifyCodexPreStreamRejection(jsonRejection(402, {
      code: "billing_error",
    }))).resolves.toEqual({
      kind: "unverified-billing-or-quota",
      status: 402,
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
  });

  test("an aborted body read fails closed and leaves generic failover eligible", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await classifyCodexPreStreamRejection(
      jsonRejection(429, { code: "usage_limit_exceeded" }),
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
  });
});

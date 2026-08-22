import { describe, expect, test } from "bun:test";
import { authenticateGatewayRequest } from "../src/auth";

const GATEWAY_KEY = "gateway-key-01234567890123456789012";

describe("authenticateGatewayRequest", () => {
  test("accepts a valid bearer token", () => {
    const req = new Request("https://example.test/v1/models", {
      headers: { Authorization: `Bearer ${GATEWAY_KEY}` },
    });
    expect(authenticateGatewayRequest(req, GATEWAY_KEY)).toEqual({ ok: true });
  });

  test("rejects missing authorization", () => {
    const req = new Request("https://example.test/v1/models");
    expect(authenticateGatewayRequest(req, GATEWAY_KEY)).toEqual({
      ok: false,
      category: "auth_failed",
    });
  });

  test("rejects malformed authorization scheme", () => {
    const req = new Request("https://example.test/v1/models", {
      headers: { Authorization: `Basic ${GATEWAY_KEY}` },
    });
    expect(authenticateGatewayRequest(req, GATEWAY_KEY)).toEqual({
      ok: false,
      category: "auth_failed",
    });
  });

  test("rejects wrong token without leaking timing differences via category", () => {
    const req = new Request("https://example.test/v1/models", {
      headers: { Authorization: "Bearer wrong-token-012345678901234567890" },
    });
    expect(authenticateGatewayRequest(req, GATEWAY_KEY)).toEqual({
      ok: false,
      category: "auth_failed",
    });
  });
});

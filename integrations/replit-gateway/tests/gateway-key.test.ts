import { describe, expect, test } from "bun:test";
import {
  GATEWAY_KEY_PATTERN,
  MAX_GATEWAY_KEY_LENGTH,
  validateGatewayKey,
} from "../src/gateway-key";
import { MIN_GATEWAY_KEY_LENGTH } from "../src/constants";

describe("validateGatewayKey", () => {
  const validKey = "gateway-key-01234567890123456789012";

  test("accepts printable ASCII keys at minimum and maximum length", () => {
    expect(() => validateGatewayKey("a".repeat(MIN_GATEWAY_KEY_LENGTH))).not.toThrow();
    expect(() => validateGatewayKey("!".repeat(MAX_GATEWAY_KEY_LENGTH))).not.toThrow();
    expect(() => validateGatewayKey(validKey)).not.toThrow();
  });

  test("rejects keys below the minimum length", () => {
    expect(() => validateGatewayKey("a".repeat(MIN_GATEWAY_KEY_LENGTH - 1))).toThrow(
      /at least 32/i,
    );
  });

  test("rejects keys above the maximum length", () => {
    expect(() => validateGatewayKey("a".repeat(MAX_GATEWAY_KEY_LENGTH + 1))).toThrow(
      /at most 512/i,
    );
  });

  test("rejects control characters and non-printable bytes", () => {
    expect(() => validateGatewayKey(`${"a".repeat(16)}\n${"a".repeat(16)}`)).toThrow(/invalid/i);
    expect(() => validateGatewayKey(`${"a".repeat(16)}\u0000${"a".repeat(15)}`)).toThrow(
      /printable ASCII/i,
    );
    expect(() => validateGatewayKey(`${"a".repeat(16)}\t${"a".repeat(15)}`)).toThrow(
      /printable ASCII/i,
    );
  });

  test("rejects whitespace and other non-printable-ASCII characters", () => {
    expect(() => validateGatewayKey(`a${" ".repeat(10)}${"b".repeat(21)}`)).toThrow(
      /printable ASCII/i,
    );
    expect(() => validateGatewayKey("key with spaces 012345678901234567890123456")).toThrow(
      /printable ASCII/i,
    );
  });

  test("uses the same printable ASCII pattern as the installer", () => {
    expect(GATEWAY_KEY_PATTERN).toEqual(/^[\x21-\x7E]+$/);
    expect(MAX_GATEWAY_KEY_LENGTH).toBe(512);
  });
});

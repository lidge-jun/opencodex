import {
  MAX_REPLIT_GATEWAY_KEY_LENGTH,
  MIN_REPLIT_GATEWAY_KEY_LENGTH,
  REPLIT_GATEWAY_KEY_PATTERN,
} from "../../../../src/providers/replit/constants";

export type GatewayKeyValidationIssue = "empty" | "too_short" | "too_long" | "invalid_chars";

export function validateGatewayKeyInput(value: string): GatewayKeyValidationIssue | null {
  const trimmed = value.trim();
  if (!trimmed) return "empty";
  if (trimmed.length < MIN_REPLIT_GATEWAY_KEY_LENGTH) return "too_short";
  if (trimmed.length > MAX_REPLIT_GATEWAY_KEY_LENGTH) return "too_long";
  if (!REPLIT_GATEWAY_KEY_PATTERN.test(trimmed)) return "invalid_chars";
  return null;
}

export { MAX_REPLIT_GATEWAY_KEY_LENGTH };

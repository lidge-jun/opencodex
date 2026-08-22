import { MIN_GATEWAY_KEY_LENGTH } from "./constants";

export const MAX_GATEWAY_KEY_LENGTH = 512;

/** Matches opencodex installer policy in `src/providers/replit/constants.ts`. */
export const GATEWAY_KEY_PATTERN = /^[\x21-\x7E]+$/;

export function validateGatewayKey(raw: string): void {
  const key = raw.trim();
  if (/[\r\n]/.test(key)) {
    throw new Error("REPLIT_GATEWAY_KEY is invalid");
  }
  if (key.length < MIN_GATEWAY_KEY_LENGTH) {
    throw new Error(`REPLIT_GATEWAY_KEY must be at least ${MIN_GATEWAY_KEY_LENGTH} characters`);
  }
  if (key.length > MAX_GATEWAY_KEY_LENGTH) {
    throw new Error(`REPLIT_GATEWAY_KEY must be at most ${MAX_GATEWAY_KEY_LENGTH} characters`);
  }
  if (!GATEWAY_KEY_PATTERN.test(key)) {
    throw new Error("REPLIT_GATEWAY_KEY must contain only printable ASCII characters");
  }
}

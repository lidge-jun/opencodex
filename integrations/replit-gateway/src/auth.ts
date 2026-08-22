import { createHash, timingSafeEqual } from "node:crypto";
import type { GatewayErrorCategory } from "./errors";

export interface GatewayAuthSuccess {
  ok: true;
}

export interface GatewayAuthFailure {
  ok: false;
  category: GatewayErrorCategory;
}

export type GatewayAuthResult = GatewayAuthSuccess | GatewayAuthFailure;

function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function digestSecret(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function secretEquals(expected: string, actual: string): boolean {
  return timingSafeEqual(digestSecret(expected), digestSecret(actual));
}

export function authenticateGatewayRequest(
  req: Request,
  gatewayKey: string,
): GatewayAuthResult {
  const token = parseBearerToken(req.headers.get("Authorization"));
  if (!token || !secretEquals(gatewayKey, token)) {
    return { ok: false, category: "auth_failed" };
  }
  return { ok: true };
}

import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { normalizeKiroModelId } from "../providers/kiro-models";
import type { OcxParsedRequest } from "../types";

let cachedFp: string | undefined;

export function fingerprint(): string {
  if (cachedFp) return cachedFp;
  try {
    cachedFp = createHash("sha256").update(`${hostname()}-${userInfo().username}-kiro`).digest("hex");
  } catch {
    cachedFp = createHash("sha256").update("default-kiro").digest("hex");
  }
  return cachedFp;
}

export function osTag(): string {
  const p = process.platform;
  if (p === "darwin") return "macos#24.0.0";
  if (p === "win32") return "win32#10.0.26100";
  return "linux#6.8.0";
}

/** Registry/user model id -> CodeWhisperer model id. */
export function mapModelId(id: string): string {
  return normalizeKiroModelId(id);
}

/** CodeWhisperer toolUseId constraint: ^[a-zA-Z0-9_-]{1,64}$ */
export function normalizeToolId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return s.length > 64 ? s.slice(0, 64) : s;
}

/**
 * Kiro `runtimeservice` rejects a toolSpecification.name that is not `^[a-zA-Z0-9_-]{1,64}$`
 * ("ValidationException: Invalid tool use format."). MCP wire names routinely break this: codex_apps
 * tools carry spaces (e.g. `...__workspace agents_create_agent`) and the namespaced form often
 * exceeds 64 chars. Normalize deterministically so the SAME input always maps to the SAME output —
 * the toolSpecification, the replayed assistant toolUse, and the response-side restore all derive
 * from the same wire name, so they stay in agreement without sharing state.
 *
 * Non-conforming chars become `_`. When the result would exceed 64 chars (or anything had to be
 * rewritten and the tail would otherwise collide), the name is shortened to a 55-char prefix plus an
 * 8-hex-char hash of the ORIGINAL wire name, keeping it unique and reversible via the per-request map.
 */
export function kiroToolName(wireName: string, used?: Set<string>): string {
  const cleaned = wireName.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Conforming, non-empty, short, and not already claimed: pass through unchanged (the common case;
  // keeps names readable and round-trippable without a map lookup).
  if (cleaned === wireName && cleaned.length >= 1 && cleaned.length <= 64 && !(used?.has(cleaned))) {
    used?.add(cleaned);
    return cleaned;
  }
  // Lossy (chars rewritten), too long, empty, or colliding: build `<=55-char prefix>_<8-hex>` where
  // the hash covers the original wire name. A numeric salt is mixed in until the result is unclaimed,
  // so two distinct wire names can never collapse to the same Kiro name within one request (the 8-hex
  // suffix alone is only 32 bits, and a hashed name could otherwise equal a conforming one — the
  // `used` check closes both gaps). Empty input falls back to a stable "tool" prefix.
  const base = cleaned.slice(0, 55) || "tool";
  for (let salt = 0; ; salt++) {
    const hashInput = salt === 0 ? wireName : `${wireName}#${salt}`;
    const suffix = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
    const candidate = `${base}_${suffix}`;
    if (!(used?.has(candidate))) {
      used?.add(candidate);
      return candidate;
    }
  }
}

export function fallbackToolUseId(): string {
  return `toolu_${randomUUID().slice(0, 8)}`;
}

export function invocationId(): string {
  return randomUUID();
}

export function stableConversationId(parsed: OcxParsedRequest): string {
  const msgs = parsed.context.messages;
  if (!msgs || msgs.length === 0) return randomUUID().slice(0, 16);
  const key = (msgs.length <= 3 ? msgs : [...msgs.slice(0, 3), msgs[msgs.length - 1]])
    .map(m => `${m.role}:${JSON.stringify((m as { content?: unknown }).content ?? "").slice(0, 100)}`)
    .join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

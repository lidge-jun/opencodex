import { createHash } from "node:crypto";
import type { FailureEvent, FailureFingerprint } from "./types";

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:bearer\s+|basic\s+|api[_-]?key\s*[:=]\s*|token\s*[:=]\s*|secret\s*[:=]\s*)[^\s,;]+/gi, "[redacted]"],
  [/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[redacted-key]"],
  [/\b(?:request|session)[_-]?id\s*[:=]\s*[^\s,;]+/gi, ""],
  [/\b(?:timestamp|time)\s*[:=]\s*[^\s,;]+/gi, ""],
  [/\b\d{10,13}\b/g, ""],
  [/(:\d+\s*:\s*\d+)(?=\b|\D)/g, ""],
  [/\b(?:line|col(?:umn)?)\s*[:=]?\s*\d+/gi, ""],
  [/\/(?:[a-zA-Z0-9._-]+(?: [a-zA-Z0-9._-]+)*\/){1,}[a-zA-Z0-9._-]+(?: [a-zA-Z0-9._-]+)*/g, "[path]"],
  [/[a-zA-Z]:\\(?:[a-zA-Z0-9._-]+(?: [a-zA-Z0-9._-]+)*\\)+[a-zA-Z0-9._-]+(?: [a-zA-Z0-9._-]+)*/g, "[path]"],
];

const MAX_SIGNATURE_LEN = 1024;
const MAX_FIELD_LEN = 128;

export function sanitizeSignature(raw: string): string {
  if (typeof raw !== "string") return "";
  let text = raw;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_SIGNATURE_LEN);
}

function sanitizeField(value: unknown, maxLen = MAX_FIELD_LEN): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return sanitizeSignature(trimmed).slice(0, maxLen);
}

export interface CanonicalFailurePayload {
  v: 1;
  k: string;
  p?: string;
  m?: string;
  s: string;
}

export function canonicalizeFailureEvent(event: FailureEvent): CanonicalFailurePayload {
  const k = sanitizeField(event.failureKind) ?? "unknown_failure";
  const p = sanitizeField(event.provider, 64);
  const m = sanitizeField(event.model, 64);
  const s = sanitizeSignature(event.signature);

  return {
    v: 1,
    k,
    ...(p ? { p } : {}),
    ...(m ? { m } : {}),
    s,
  };
}

export function computeFailureFingerprint(event: FailureEvent): FailureFingerprint {
  const canonical = canonicalizeFailureEvent(event);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

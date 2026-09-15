import { MASK_PLACEHOLDER, REDACT_KEYS } from "./constants";

const SECRET_LIKE = /(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+[A-Za-z0-9._\-+=/]+)/gi;

export function maskSecret(value: string | null | undefined): string {
  if (!value) return MASK_PLACEHOLDER;
  const trimmed = value.trim();
  if (!trimmed) return MASK_PLACEHOLDER;
  if (trimmed.length <= 8) return MASK_PLACEHOLDER;
  const tail = trimmed.slice(-4);
  return `${"•".repeat(12)}${tail}`;
}

export function redactText(input: string): string {
  let out = input;
  for (const key of REDACT_KEYS) {
    const pattern = new RegExp(`(${key}\\s*[:=]\\s*)([^\\s,;]+)`, "gi");
    out = out.replace(pattern, `$1${MASK_PLACEHOLDER}`);
  }
  out = out.replace(SECRET_LIKE, MASK_PLACEHOLDER);
  return out;
}

export function redactRecord(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactRecord);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.includes(key.toLowerCase())) out[key] = MASK_PLACEHOLDER;
      else out[key] = redactRecord(inner);
    }
    return out;
  }
  return value;
}

export function assertNoSecret(payload: unknown, secret: string): void {
  const dumped = JSON.stringify(payload ?? "");
  if (secret && secret.length >= 8 && dumped.includes(secret)) {
    throw new Error("Secret leakage detected in serialized payload.");
  }
}


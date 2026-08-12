import {
  MAX_ARRAY_ELEMENTS_PER_EVENT,
  MAX_EVENT_NESTING_DEPTH,
  MAX_OBJECT_KEYS_PER_EVENT,
  MAX_SANITIZED_STRING_FIELD,
} from "../constants";
import { LabValidationError } from "./errors";

const FORBIDDEN_KEY_RE =
  /(?:^|_)(?:secret|token|apikey|api_key|password|credential|authorization|cookie|bearer|prompt|repository|filepath|file_path|baseurl|base_url|hostname|rawrequest|raw_request)(?:$|_)/i;

const FORBIDDEN_EXACT_KEYS = new Set([
  "authorization",
  "apiKey",
  "api_key",
  "password",
  "secret",
  "token",
  "cookie",
  "cookies",
  "headers",
  "prompt",
  "path",
  "filepath",
  "filePath",
  "repository",
  "repo",
  "baseUrl",
  "url",
  "rawRequest",
  "rawBytes",
]);

const RAW_POSIX_PATH_RE =
  /(?:^|[^A-Za-z0-9._~/])\/(?:(?=$|[^A-Za-z0-9._~/])|(?!\/)(?![ \t\r\n])(?:\/|[^/\0\r\n]+)+\/?(?=$|[^A-Za-z0-9._~/]))/u;

function fieldPath(base: string, key: string | number): string {
  return base ? `${base}.${String(key)}` : String(key);
}

function assertAllowedValueType(value: unknown, path: string): void {
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new LabValidationError("non_finite", `${path} must be finite number`);
    }
    return;
  }
  if (Array.isArray(value) || (t === "object" && value !== null)) return;
  throw new LabValidationError("unsupported_type", `${path} has unsupported type`);
}

function assertKeyAllowed(key: string, path: string): void {
  if (FORBIDDEN_EXACT_KEYS.has(key) || FORBIDDEN_KEY_RE.test(key)) {
    throw new LabValidationError("forbidden_field", `${path} forbidden`);
  }
  if (key.includes("\0")) {
    throw new LabValidationError("nul_forbidden", `${path} contains NUL`);
  }
}

/** Recursive deterministic CL-00 structural/privacy ceilings before JSONL admission. */
export function enforceEventStructureLimits(
  value: unknown,
  path = "",
  depth = 0,
): void {
  assertAllowedValueType(value, path || "event");
  if (value === null) return;

  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > MAX_SANITIZED_STRING_FIELD) {
      throw new LabValidationError("field_too_large", `${path} exceeds ${MAX_SANITIZED_STRING_FIELD} bytes`);
    }
    if (/sk-[a-z0-9]{10,}/i.test(value) || /Bearer\s+\S+/i.test(value)) {
      throw new LabValidationError("secret_pattern", `${path} contains secret-shaped data`);
    }
    if (
      /^[A-Za-z]:\\/.test(value) ||
      RAW_POSIX_PATH_RE.test(value) ||
      value.includes("\\Users\\")
    ) {
      throw new LabValidationError("raw_path", `${path} contains raw filesystem path`);
    }
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") return;

  if (Array.isArray(value)) {
    if (depth >= MAX_EVENT_NESTING_DEPTH) {
      throw new LabValidationError("nesting_depth", `${path} exceeds nesting depth ${MAX_EVENT_NESTING_DEPTH}`);
    }
    if (value.length > MAX_ARRAY_ELEMENTS_PER_EVENT) {
      throw new LabValidationError("array_too_large", `${path} exceeds ${MAX_ARRAY_ELEMENTS_PER_EVENT} elements`);
    }
    for (let i = 0; i < value.length; i++) {
      enforceEventStructureLimits(value[i], fieldPath(path, i), depth + 1);
    }
    return;
  }

  if (depth >= MAX_EVENT_NESTING_DEPTH) {
    throw new LabValidationError("nesting_depth", `${path} exceeds nesting depth ${MAX_EVENT_NESTING_DEPTH}`);
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length > MAX_OBJECT_KEYS_PER_EVENT) {
    throw new LabValidationError("too_many_keys", `${path} exceeds ${MAX_OBJECT_KEYS_PER_EVENT} keys`);
  }
  for (const key of keys) {
    assertKeyAllowed(key, fieldPath(path, key));
    enforceEventStructureLimits((value as Record<string, unknown>)[key], fieldPath(path, key), depth + 1);
  }
}

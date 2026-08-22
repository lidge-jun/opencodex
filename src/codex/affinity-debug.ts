/**
 * Opt-in Codex affinity diagnostics for account-switch compatibility failures.
 *
 * The provider debug stream may compare values only within the current process. It never emits
 * raw header values, credentials, account identifiers, or durable unsalted hashes.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isDebugEnabled } from "../lib/debug-settings";
import { debugProviderDiagnostic } from "../lib/debug";

const MAX_TAGGED_VALUE_BYTES = 16 * 1024;
const RUN_KEY = randomBytes(32);
let nextSequence = 0;

const SAFE_AFFINITY_HEADERS = [
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
] as const;

const KNOWN_TURN_FIELDS = [
  "forked_from_thread_id",
  "parent_thread_id",
  "request_kind",
  "session_id",
  "subagent_kind",
  "thread_id",
] as const;

type SizeBucket = "0" | "1-31" | "32-127" | "128-511" | "512-2047" | "2048-16384" | "oversized";

export interface CodexAffinityValueTag {
  name: string;
  size: SizeBucket;
  tag?: string;
}

export interface CodexAffinityJsonSummary {
  shape: "absent" | "malformed" | "oversized" | "array" | "scalar" | "object";
  knownFields?: Array<CodexAffinityValueTag & { kind: "string" | "number" | "boolean" | "null" | "array" | "object" }>;
  unknownFieldCount?: number;
}

export interface CodexAffinityDiagnosticInput {
  inboundHeaders: Headers;
  outboundHeaders: HeadersInit;
  authKind: "main" | "pool" | "main-pool";
  accountMode: "direct" | "pool" | undefined;
  fixedAccount: boolean;
  credentialSubstituted: boolean;
  accountGatedModel: boolean;
  wireModelNormalized: boolean;
  status: number;
}

function sizeBucket(bytes: number): SizeBucket {
  if (bytes === 0) return "0";
  if (bytes <= 31) return "1-31";
  if (bytes <= 127) return "32-127";
  if (bytes <= 511) return "128-511";
  if (bytes <= 2047) return "512-2047";
  if (bytes <= MAX_TAGGED_VALUE_BYTES) return "2048-16384";
  return "oversized";
}

function valueTag(name: string, value: string): CodexAffinityValueTag {
  const bytes = Buffer.byteLength(value, "utf8");
  const size = sizeBucket(bytes);
  if (size === "oversized") return { name, size };
  const tag = createHmac("sha256", RUN_KEY)
    .update(name)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, 12);
  return { name, size, tag };
}

function headerTags(headers: Headers): CodexAffinityValueTag[] {
  const rows: CodexAffinityValueTag[] = [];
  for (const name of SAFE_AFFINITY_HEADERS) {
    const value = headers.get(name);
    if (value !== null) rows.push(valueTag(name, value));
  }
  return rows;
}

function jsonSummary(headers: Headers, name: "x-codex-turn-metadata" | "x-codex-turn-state"): CodexAffinityJsonSummary {
  const raw = headers.get(name);
  if (raw === null) return { shape: "absent" };
  if (Buffer.byteLength(raw, "utf8") > MAX_TAGGED_VALUE_BYTES) return { shape: "oversized" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { shape: "malformed" };
  }
  if (Array.isArray(parsed)) return { shape: "array" };
  if (!parsed || typeof parsed !== "object") return { shape: "scalar" };
  const record = parsed as Record<string, unknown>;
  const knownFields: NonNullable<CodexAffinityJsonSummary["knownFields"]> = [];
  for (const field of KNOWN_TURN_FIELDS) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (value === null) {
      knownFields.push({ name: field, kind: "null", size: "0" });
    } else {
      const scalarKind = typeof value;
      if (scalarKind === "string" || scalarKind === "number" || scalarKind === "boolean") {
        knownFields.push({ ...valueTag(`${name}.${field}`, String(value)), name: field, kind: scalarKind });
        continue;
      }
      knownFields.push({ name: field, kind: Array.isArray(value) ? "array" : "object", size: "0" });
    }
  }
  const known = new Set<string>(KNOWN_TURN_FIELDS);
  const unknownFieldCount = Object.keys(record).filter(key => !known.has(key)).length;
  return {
    shape: "object",
    ...(knownFields.length > 0 ? { knownFields } : {}),
    ...(unknownFieldCount > 0 ? { unknownFieldCount } : {}),
  };
}

/** Emit one observation-only, privacy-bounded provider-debug record. */
export function captureCodexAffinityDiagnostic(input: CodexAffinityDiagnosticInput): void {
  if (!isDebugEnabled()) return;
  try {
    const outbound = new Headers(input.outboundHeaders);
    debugProviderDiagnostic("codex", "affinity", {
      sequence: ++nextSequence,
      authKind: input.authKind,
      accountMode: input.accountMode ?? "unset",
      fixedAccount: input.fixedAccount,
      credentialSubstituted: input.credentialSubstituted,
      accountGatedModel: input.accountGatedModel,
      wireModelNormalized: input.wireModelNormalized,
      status: input.status,
      inbound: headerTags(input.inboundHeaders),
      outbound: headerTags(outbound),
      inboundTurnMetadata: jsonSummary(input.inboundHeaders, "x-codex-turn-metadata"),
      outboundTurnMetadata: jsonSummary(outbound, "x-codex-turn-metadata"),
      inboundTurnState: jsonSummary(input.inboundHeaders, "x-codex-turn-state"),
      outboundTurnState: jsonSummary(outbound, "x-codex-turn-state"),
    });
  } catch {
    // Diagnostics must never affect request handling.
  }
}

export const CODEX_AFFINITY_DEBUG_SAFE_HEADERS = SAFE_AFFINITY_HEADERS;

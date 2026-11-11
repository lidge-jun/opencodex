/**
 * Data-driven reasoning ladders for routed providers.
 *
 * Routed providers rarely publish per-model effort ladders: OpenCode Zen Go answers /models
 * with ids only (id/object/created/owned_by), so opencodex had to hardcode ladders in
 * registry.ts and synthesise max/ultra for codex-rs catalog membership. The public models.dev
 * catalogue DOES publish them per model:
 *   reasoning: true
 *   reasoning_options: [{type:"effort",values:["low","high","max"]}, {type:"toggle"},
 *                       {type:"budget_tokens"}]
 * This module snapshots that catalogue to disk and hands configuredReasoningEfforts() a
 * fallback ladder, so the Codex catalog AND the wire clamp agree with the model instead of a
 * hand-written guess.
 *
 * Failure policy: a missing or corrupt snapshot yields undefined, and an expired snapshot still
 * serves its last ladder while a best-effort refresh runs in the background. The second
 * cache records rungs the upstream actually rejected (400/403 naming reasoning_effort), so an
 * entitlement gap (muse-spark max needs an active Muse Code subscription) costs one rejected
 * request instead of failing every turn that selects that rung.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Leaf modules on purpose: this file is imported from reasoning-effort.ts, which combos/types.ts
// already imports. Going through the ../config barrel closes a cycle back into account-namespaces.ts
// and leaves COMBO_NAMESPACE in its temporal dead zone for entry points that start at combos/types.ts.
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import {
  extractJsonEnvelope,
  extractJsonEnvelopeWithContext,
  isHardPolicyOrOriginRefusal,
} from "../lib/hard-refusal";
export { extractJsonEnvelope, extractJsonEnvelopeWithContext, isHardPolicyOrOriginRefusal };
import type { OcxProviderConfig } from "../types";
import { resolveProviderApiKey } from "./api-key-resolve";

const FILENAME = "reasoning-metadata-cache.json";
const SUPPORT_FILENAME = "reasoning-support-cache.json";
const SOURCE_URL = "https://models.dev/api.json";
const USER_AGENT = "opencodex-reasoning-metadata/1.0 (+https://github.com/lidge-jun/opencodex)";
/** Snapshot age that triggers a background refresh. Older snapshots still serve reads. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** A learned "this rung is refused" fact expires: entitlements change. */
const SUPPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 250;

/** Canonical Codex ladder order; mirrors reasoning-effort.ts CODEX_REASONING_LEVELS. */
const LADDER_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** Ranked rungs used for downgrade planning; ultra is client-only and folds to max. */
const RANKED = ["low", "medium", "high", "xhigh", "max"];
/** Mirror of registry.ts THINKING_TOGGLE_EFFORTS / THINKING_BUDGET_EFFORTS. */
const CLASSIFIED_STYLE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * models.dev provider key for a provider config. OcxProviderConfig carries no id, so the
 * destination URL is the stable handle. Only destinations this patch has evidence for are
 * listed; an unlisted provider simply keeps its current behaviour.
 */
const BASE_URL_TO_METADATA_PROVIDER: Record<string, string> = {
  "https://opencode.ai/zen/go/v1": "opencode-go",
  "https://opencode.ai/zen/v1": "opencode",
};

/**
 * Both sides of the mapping are compared after this normalisation, so a trailing slash or a
 * `/v1` suffix never decides whether a destination resolves. models.dev publishes each
 * provider's own `api` URL; the snapshot keeps it (v2) so the mapping can be checked against
 * published data instead of trusted blindly.
 */
export function normalizeDestinationUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string" || url.trim() === "") return undefined;
  try {
    const parsed = new URL(url.trim());
    const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
    return (parsed.protocol + "//" + parsed.host + path).toLowerCase();
  } catch {
    return undefined;
  }
}

export type ReasoningMetadataOption = { type: string; values?: string[] };
export type ReasoningMetadataModel = { reasoning: boolean; options: ReasoningMetadataOption[] };

interface MetadataSnapshot {
  version: 1 | 2;
  fetchedAt: number;
  source: string;
  providers: Record<string, Record<string, ReasoningMetadataModel>>;
  /**
   * v2: models.dev provider key -> that provider's published api URL (normalised). v1 snapshots
   * predate the field and keep working through BASE_URL_TO_METADATA_PROVIDER.
   */
  apis?: Record<string, string>;
}

interface SupportSnapshot {
  version: 2;
  rows: Record<string, { effort: string; at: number; evidence?: string }>;
}

let snapshotMemo: MetadataSnapshot | null | undefined;
let supportMemo: Map<string, number> | undefined;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight: Promise<RefreshOutcome> | null = null;
/** Bumped by reset so a fired support write still waiting for ACL admission writes nothing. */
let persistGeneration = 0;

/** Test seam: drop the memoised snapshot/support caches so a suite can drive the load paths. */
export function resetReasoningMetadataCachesForTests(): void {
  snapshotMemo = undefined;
  supportMemo = undefined;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  refreshInFlight = null;
  persistGeneration += 1;
}

function readJsonFile<T>(filename: string): T | null {
  try {
    const path = join(getConfigDir(), filename);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // A corrupt cache must never break routing, the catalog, or the dashboard.
    return null;
  }
}

/** Canonical order + dedupe. Local mirror of sanitizeCodexReasoningEfforts (import cycle). */
function sanitizeLadder(values: readonly string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const seen = new Set(values.filter((value): value is string => typeof value === "string"));
  const ordered = LADDER_ORDER.filter(effort => seen.has(effort));
  return ordered.length > 0 ? ordered : undefined;
}

function metadataProviderKey(provider: OcxProviderConfig): string | undefined {
  const normalized = normalizeDestinationUrl(typeof provider.baseUrl === "string" ? provider.baseUrl : undefined);
  if (!normalized) return undefined;
  for (const [destination, key] of Object.entries(BASE_URL_TO_METADATA_PROVIDER)) {
    if (normalizeDestinationUrl(destination) === normalized) return key;
  }
  return undefined;
}

/** Whether catalog sync should bootstrap metadata for this destination. */
export function providerUsesReasoningMetadata(provider: OcxProviderConfig): boolean {
  return metadataProviderKey(provider) !== undefined;
}

/**
 * Local mirror of `modelRecordValue()` from `src/reasoning-effort.ts`, which imports this
 * module and so cannot be imported back. Exact id, then the `family:` prefix, then a
 * case-folded match — a configured ladder must resolve here exactly as it does there, or the
 * downgrade rung is chosen off a different ladder than the catalog advertises.
 */
function modelLadderValue(
  record: Record<string, string[]> | undefined,
  modelId: string,
): readonly string[] | undefined {
  if (!record) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, modelId)) return record[modelId];
  const colon = modelId.indexOf(":");
  if (colon > 0) {
    const family = modelId.slice(0, colon);
    if (Object.prototype.hasOwnProperty.call(record, family)) return record[family];
  }
  const folded = modelId.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === folded) return value;
  }
  return undefined;
}

/**
 * Bind learned capability to the credential that supplied the evidence. A digest keeps the
 * credential itself out of the persisted cache while remaining stable across restarts and key
 * selection. Providers without key-auth identity may use metadata, but cannot teach the cache.
 *
 * The hash input is the resolved wire credential, not the configured expression: the catalog
 * path carries the raw config string in apiKey (a keychain:/env reference stays unresolved
 * there), while the request path carries the resolved secret in apiKey and the configured
 * expression in _apiKeyAttempt.reference. The request path hashes apiKey exactly as routed --
 * the reference is only provenance, and re-resolving it at record time could read a credential
 * rotated since the request was served. The catalog path resolves the configured expression,
 * so both sides still bind learned refusals to the same wire credential, and a rotation behind
 * a stable reference starts clean instead of inheriting the previous credential's refusals.
 */
function credentialIdentity(provider: OcxProviderConfig): string | undefined {
  const resolved = provider._apiKeyAttempt?.reference !== undefined
    ? provider.apiKey
    : resolveProviderApiKey(provider.apiKey);
  if (typeof resolved !== "string" || resolved.length === 0) return undefined;
  return createHash("sha256").update(resolved).digest("hex");
}

/** JSON encoding avoids delimiter ambiguity in provider, model, and effort identifiers. */
function supportKey(providerKey: string, credential: string, modelId: string, effort: string): string {
  return JSON.stringify([providerKey, credential, modelId, effort]);
}

function loadSnapshot(): MetadataSnapshot | null {
  if (snapshotMemo !== undefined) return snapshotMemo;
  const parsed = readJsonFile<MetadataSnapshot>(FILENAME);
  snapshotMemo = parsed && (parsed.version === 1 || parsed.version === 2) && parsed.providers && typeof parsed.providers === "object"
    ? parsed
    : null;
  return snapshotMemo;
}

/**
 * Mapping report for diagnostics and tests: every gated destination, the models.dev provider it
 * resolves to, and whether the snapshot (v2) publishes an `api` URL that confirms it. The gate is
 * deliberate -- 36 of the registry's 83 destinations match a models.dev provider, so resolving by
 * URL alone would silently move ladders for providers this change has no evidence for.
 */
export function reasoningMetadataMapping(): Array<{
  destination: string;
  provider: string;
  publishedApi?: string;
  confirmed?: boolean;
  models: number;
}> {
  const snapshot = loadSnapshot();
  return Object.entries(BASE_URL_TO_METADATA_PROVIDER).map(([destination, provider]) => {
    const normalized = normalizeDestinationUrl(destination);
    const publishedApi = snapshot?.apis?.[provider];
    const row = {
      destination,
      provider,
      ...(publishedApi ? { publishedApi } : {}),
      ...(publishedApi ? { confirmed: publishedApi === normalized } : {}),
      models: Object.keys(snapshot?.providers?.[provider] ?? {}).length,
    };
    return row;
  });
}

function loadSupport(): Map<string, number> {
  const nowMs = Date.now();
  if (supportMemo) {
    // The memo lives for the process lifetime, so the TTL has to be re-applied on every read.
    // Checking it only on the disk load meant a long-running proxy kept clamping on a refusal
    // it recorded a month earlier, and `dropLearnedUnsupportedReasoningEfforts` inherited that
    // through the same map.
    for (const [key, at] of supportMemo) {
      if (nowMs - at > SUPPORT_TTL_MS) {
        supportMemo.delete(key);
        supportEvidence.delete(key);
      }
    }
    return supportMemo;
  }
  const rows = new Map<string, number>();
  const parsed = readJsonFile<SupportSnapshot>(SUPPORT_FILENAME);
  // Version 1 rows had no credential identity and are deliberately invalidated: accepting them
  // would preserve destination-wide refusals written by a lower-entitlement account.
  if (parsed && parsed.version === 2 && parsed.rows && typeof parsed.rows === "object") {
    for (const [key, row] of Object.entries(parsed.rows)) {
      if (!row || typeof row.at !== "number") continue;
      if (nowMs - row.at > SUPPORT_TTL_MS) continue;
      rows.set(key, row.at);
    }
  }
  supportMemo = rows;
  return rows;
}

/** Snapshot health for ocx status / diagnostics. */
export function reasoningMetadataStatus(): { fetchedAt?: number; ageMs?: number; stale: boolean; models: number } {
  const snapshot = loadSnapshot();
  if (!snapshot) return { stale: false, models: 0 };
  const ageMs = Date.now() - snapshot.fetchedAt;
  let models = 0;
  for (const provider of Object.values(snapshot.providers)) models += Object.keys(provider).length;
  return { fetchedAt: snapshot.fetchedAt, ageMs, stale: ageMs > CACHE_TTL_MS, models };
}

export function reasoningMetadataModel(provider: OcxProviderConfig, modelId: string): ReasoningMetadataModel | undefined {
  const key = metadataProviderKey(provider);
  if (!key) return undefined;
  const models = loadSnapshot()?.providers?.[key];
  if (!models) return undefined;
  const model = models[modelId];
  return model && typeof model === "object" ? model : undefined;
}

/** Raw models.dev effort values for a model, canonicalised; undefined when not published. */
export function metadataEffortValues(provider: OcxProviderConfig, modelId: string): string[] | undefined {
  const model = reasoningMetadataModel(provider, modelId);
  if (!model) return undefined;
  const options = Array.isArray(model.options) ? model.options : [];
  const effort = options.find(option => option && option.type === "effort");
  const ladder = sanitizeLadder(effort?.values);
  // none/minimal are sentinels, not picker rungs (mapReasoningEffort folds minimal to low), and
  // advertising them would trip the Codex runtime clamp for no user-visible gain.
  const rungs = ladder?.filter(value => value !== "none" && value !== "minimal");
  return rungs && rungs.length > 0 ? rungs : undefined;
}

/** True when models.dev publishes the named option type (toggle / budget_tokens) for a model. */
export function metadataDeclaresType(provider: OcxProviderConfig, modelId: string, type: string): boolean {
  const model = reasoningMetadataModel(provider, modelId);
  if (!model) return false;
  const options = Array.isArray(model.options) ? model.options : [];
  return options.some(option => option?.type === type);
}

export function isReasoningEffortLearnedUnsupported(provider: OcxProviderConfig, modelId: string, effort: string): boolean {
  const key = metadataProviderKey(provider);
  const credential = credentialIdentity(provider);
  if (!key || !credential) return false;
  return loadSupport().has(supportKey(key, credential, modelId, effort));
}

/**
 * After the ladder is chosen (registry config or models.dev metadata), remove the rungs this
 * account actually had refused. Applied at the configuredReasoningEfforts() exit so a
 * registry-pinned ladder learns exactly like a metadata-derived one; without it a pinned rung
 * the upstream rejects would replay-and-fail on every request. An all-refused ladder keeps the
 * original list: turning "some rungs" into "no effort control" would silently drop the picker.
 */
export function dropLearnedUnsupportedReasoningEfforts(
  provider: OcxProviderConfig,
  modelId: string,
  efforts: readonly string[],
): string[] {
  if (efforts.length === 0) return [...efforts];
  const key = metadataProviderKey(provider);
  if (!key) return [...efforts];
  const credential = credentialIdentity(provider);
  if (!credential) return [...efforts];
  const support = loadSupport();
  if (support.size === 0) return [...efforts];
  const kept = efforts.filter(effort => !support.has(supportKey(key, credential, modelId, effort)));
  return kept.length === 0 ? [...efforts] : kept;
}

/**
 * Metadata fallback ladder for a provider/model.
 *
 * - Published effort values win.
 * - A model the provider already classifies as thinking-toggle / thinking-budget keeps the
 *   provider's own effort list; a toggle-only entry never invents wire semantics here.
 * - Rungs the upstream actually refused are removed; a ladder emptied by that learning
 *   returns undefined (status quo) rather than advertising "no effort control".
 */
export function reasoningEffortsFromMetadata(provider: OcxProviderConfig, modelId: string): string[] | undefined {
  const published = metadataEffortValues(provider, modelId);
  let ladder = published;
  if (!ladder) {
    const classified = (provider.thinkingToggleModels ?? []).includes(modelId)
      || (provider.thinkingBudgetModels ?? []).includes(modelId);
    ladder = classified ? CLASSIFIED_STYLE_EFFORTS : undefined;
  }
  if (!ladder || ladder.length === 0) return undefined;
  const kept = ladder.filter(effort => !isReasoningEffortLearnedUnsupported(provider, modelId, effort));
  if (kept.length === 0) return undefined;
  return kept;
}

const supportEvidence = new Map<string, string>();

/**
 * Record that the upstream refused a rung. Persisted (debounced) so the next catalog sync and
 * every later request clamp before dispatch. Returns true when this is new information.
 */
export function recordUnsupportedReasoningEffort(
  provider: OcxProviderConfig,
  modelId: string,
  effort: string,
  evidence?: string,
): boolean {
  const key = metadataProviderKey(provider);
  const credential = credentialIdentity(provider);
  if (!key || !credential || !effort) return false;
  const rowKey = supportKey(key, credential, modelId, effort);
  const rows = loadSupport();
  if (rows.has(rowKey)) return false;
  rows.set(rowKey, Date.now());
  if (evidence) supportEvidence.set(rowKey, evidence.slice(0, 240));
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    // Admitted after an overlapping optional config-root ACL flight (#7815); rows are read
    // inside the callback, and a timed-out admission skips this best-effort write.
    const dir = getConfigDir();
    const generation = persistGeneration;
    void withConfigDirHardeningSettled(dir, () => {
      if (generation !== persistGeneration) return;
      const out: SupportSnapshot["rows"] = {};
      for (const [rowKey, at] of rows) {
        const evidenceText = supportEvidence.get(rowKey);
        out[rowKey] = {
          effort: JSON.parse(rowKey)[3] ?? "",
          at,
          ...(evidenceText ? { evidence: evidenceText } : {}),
        };
      }
      atomicWriteFile(join(dir, SUPPORT_FILENAME), JSON.stringify({ version: 2, rows: out }) + "\n");
    }).catch(() => {
      // Best-effort persistence only.
    });
  }, PERSIST_DEBOUNCE_MS);
  return true;
}

/** Test seam: flush a pending support write, admitted like the timer write (#7815). */
export async function flushReasoningSupportCache(): Promise<void> {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  const dir = getConfigDir();
  const generation = persistGeneration;
  await withConfigDirHardeningSettled(dir, () => {
    if (generation !== persistGeneration) return;
    const rows = loadSupport();
    const out: SupportSnapshot["rows"] = {};
    for (const [rowKey, at] of rows) {
      const evidenceText = supportEvidence.get(rowKey);
      out[rowKey] = { effort: JSON.parse(rowKey)[3] ?? "", at, ...(evidenceText ? { evidence: evidenceText } : {}) };
    }
    atomicWriteFile(join(dir, SUPPORT_FILENAME), JSON.stringify({ version: 2, rows: out }) + "\n");
  }).catch(() => {
    // Best-effort persistence only.
  });
}

/**
 * Words an upstream uses when it is refusing the parameter it just named. Requiring one of
 * these beside the effort term is what separates "the gateway rejected reasoning effort" from
 * "the gateway rejected something else and echoed the request back".
 */
const REJECTION_LANGUAGE = /unsupported|not supported|does not support|invalid|not valid|unrecognized|unknown|not allowed|not permitted|must be|requires|required|cannot|can't|out of range/i;

/**
 * How far from the effort term the rejection language may sit and still be about it. Kept
 * deliberately short: an error body that echoes the request back puts unrelated field names and
 * their complaints within a hundred characters of each other, so a generous window classifies
 * every 400 that mentions effort as a refusal of it.
 */
const REJECTION_WINDOW = 48;

/**
 * The `invalid_request_error` type tag rides along on essentially every 400 an OpenAI-shaped
 * gateway emits, so it is evidence of nothing. Blanked before the language scan rather than
 * dropped from the pattern, because `invalid` is real evidence when it is the message.
 */
const GENERIC_ERROR_TYPE = /invalid_request_error/gi;

const EFFORT_COMPATIBLE_CODES = new Set([
  "",
  "invalid_request_error",
  "invalid_argument",
  "invalid_parameter",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_parameter_error",
]);
const EFFORT_COMPATIBLE_TYPES = new Set([
  "",
  "invalid_request_error",
  "upstream_error",
  "bad_request",
]);

/**
 * Error codes and types arrive as snake_case, kebab-case or PascalCase depending on the gateway
 * (Volcengine Ark sends `InvalidParameter` / `BadRequest`). Fold all three to snake_case before the
 * compatibility lookup so a generic vendor code is not read as naming some other field.
 */
function normalizeErrorTag(value: string): string {
  return value.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replaceAll("-", "_");
}

function isIncompleteStructuredWrapper(text: string): boolean {
  let s = text.trim();
  for (let d = 0; d < 3; d += 1) {
    if (s.startsWith("Provider error 400: ")) {
      s = s.slice("Provider error 400: ".length).trim();
    } else if (s.startsWith("Provider error: ")) {
      s = s.slice("Provider error: ".length).trim();
    } else if (s.startsWith("Gateway error 400: ")) {
      s = s.slice("Gateway error 400: ".length).trim();
    } else if (s.startsWith("Gateway error: ")) {
      s = s.slice("Gateway error: ".length).trim();
    }
    if (s.startsWith("data:") && !s.includes("\n")) {
      s = s.slice("data:".length).trim();
    }
  }
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      JSON.parse(s);
      return false;
    } catch {
      return true;
    }
  }
  if (/^(?:(?:Provider|Gateway) error (?:400:\s*)?|data:\s*)[{\[]/i.test(text.trim())) {
    return true;
  }
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1) {
    let openBraces = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") openBraces += 1;
        else if (ch === "}") openBraces -= 1;
      }
    }
    if (openBraces !== 0) return true;
    if (lastBrace > firstBrace && s.slice(firstBrace, lastBrace + 1).includes(":")) {
      try {
        JSON.parse(s.slice(firstBrace, lastBrace + 1));
      } catch {
        return true;
      }
    }
  }
  const firstBracket = s.indexOf("[");
  const lastBracket = s.lastIndexOf("]");
  if (firstBracket !== -1) {
    let openBrackets = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "[") openBrackets += 1;
        else if (ch === "]") openBrackets -= 1;
      }
    }
    if (openBrackets !== 0) return true;
    const bracketSlice = s.slice(firstBracket, lastBracket + 1);
    if (
      lastBracket > firstBracket &&
      (bracketSlice.includes('"') || bracketSlice.includes("'") || bracketSlice.includes(":") || bracketSlice.includes(","))
    ) {
      try {
        JSON.parse(bracketSlice);
      } catch {
        // "reasoning_effort must be one of ['low','medium','high']" is a value list in prose, not
        // a truncated or reflected envelope (#8173).
        if (!isEffortValueEnumeration(bracketSlice)) return true;
      }
    }
  }
  return false;
}

const EFFORT_PARAM_NAMES = new Set([
  "reasoning_effort",
  "reasoning.effort",
  "reasoning",
  "reasoning_parameters",
  "effort",
  // A thinking-budget field is the same subject on the Anthropic-shaped wires: a refusal that
  // names it is about the reasoning control, not about some other parameter.
  "thinking_budget",
  "thinking.budget",
  "thinking.budget_tokens",
]);

function cleanParam(str: string): string {
  return str.trim().toLowerCase().replaceAll("-", "_").replace(/[^a-z0-9_]+$/gi, "").replace(/^[^a-z0-9_]+/gi, "");
}

const KNOWN_NON_EFFORT_PARAMS = new Set([
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "min_tokens",
  "stop",
  "stop_sequences",
  "presence_penalty",
  "frequency_penalty",
  "repetition_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "seed",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "response_format",
  "stream",
  "stream_options",
  "user",
  "service_tier",
  "modalities",
  "prediction",
  "parallel_tool_calls",
  "messages",
  "prompt",
  "n",
  "best_of",
]);

const GENERIC_PARAM_WORDS = new Set([
  "request",
  "requests",
  "argument",
  "arguments",
  "parameter",
  "parameters",
  "param",
  "params",
  "payload",
  "body",
  "input",
  "inputs",
  "json",
  "format",
  "data",
  "content",
  "value",
  "values",
  "field",
  "fields",
  "call",
  "type",
  "error",
  "message",
  "model",
  "url",
  "header",
  "headers",
  "auth",
  "api",
  "key",
  "token",
  "status",
  "code",
  "response",
  "gateway",
  "provider",
  "invalid",
  "unsupported",
  "unknown",
  "unrecognized",
  "unexpected",
  "unallowed",
  "it",
  "this",
  "that",
  "these",
  "those",
  "which",
  "what",
  "all",
  "each",
  "every",
  "both",
  "either",
  "neither",
  "one",
  "they",
  "there",
  "here",
  "string",
  "number",
  "boolean",
  "integer",
  "array",
  "object",
  "null",
  "none",
]);

const EFFORT_RUNGS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
  "ultra",
  "minimal",
  "standard",
  "default",
]);

/**
 * Words that describe a diagnostic, never name a request field.
 *
 * "Unsupported parameter: 'reasoning_effort'" puts an adjective exactly where a field name sits
 * in "`field` parameter", and "Unsupported value: 'max'" puts the refused value under a noun.
 * Reading either as the competing subject made genuine effort refusals terminal (#8173).
 */
const DIAGNOSTIC_NOISE_WORDS = new Set([
  "unsupported",
  "invalid",
  "unrecognized",
  "unknown",
  "unexpected",
  "bad",
  "malformed",
  "value",
  "values",
  "parameter",
  "parameters",
  "param",
  "params",
  "field",
  "fields",
  "argument",
  "arguments",
  "arg",
  "property",
  "request",
  "response",
  "payload",
  "body",
  "error",
  // Determiners and participles that introduce the subject: "The following parameter is not
  // supported: reasoning_effort" puts one where a field name would sit.
  "following",
  "specified",
  "given",
  "provided",
  "requested",
  "supplied",
  "above",
  "a",
  "an",
  "the",
  "same",
]);

/**
 * A bare number (or numeric literal) is a value in every diagnostic that names a limit, never a
 * field name, so "thinking budget 32000 is not supported" is not a competing-parameter refusal.
 */
const NUMERIC_VALUE_TOKEN = /^[0-9]+(?:\.[0-9]+)?$/;

/** Connectives and glue words allowed inside a published-value enumeration. */
const EFFORT_ENUMERATION_FILLER = new Set([
  "and",
  "or",
  "values",
  "value",
  "supported",
  "allowed",
  "available",
  "one",
  "of",
  "are",
  "is",
]);

/**
 * Whether a bracket slice is just a list of effort rungs, e.g. `['low','medium','high']`.
 *
 * "reasoning_effort must be one of ['low','medium','high']" is prose that lists the ladder. The
 * structured-wrapper checks treat any bracket payload with commas and quotes as a malformed or
 * reflected envelope, which made this genuine refusal terminal (#8173). A payload composed only
 * of rung names is a value list, not an envelope.
 */
function isEffortValueEnumeration(slice: string): boolean {
  const tokens = slice.match(/[A-Za-z_][A-Za-z0-9_.\-]*|[0-9]+(?:\.[0-9]+)?/g);
  if (!tokens || tokens.length === 0) return false;
  return tokens.every(token => {
    const normalized = token.toLowerCase();
    return EFFORT_RUNGS.has(normalized) || EFFORT_ENUMERATION_FILLER.has(normalized);
  });
}

/** True when every bracketed group in the text is an effort-value enumeration. */
function carriesOnlyEffortEnumerations(text: string): boolean {
  const groups = text.match(/\[[^\]]*\]/g);
  return !!groups && groups.length > 0 && groups.every(isEffortValueEnumeration);
}

const STRUCTURAL_EFFORT_WORDS = new Set([
  "level",
  "mode",
  "rung",
  "rungs",
]);

const SUBJECT_FOLLOWING_VERBS = new Set([
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "has",
  "have",
  "had",
  "does",
  "do",
  "did",
  "cannot",
  "cant",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
]);

const REASONING_EFFORT_CONTEXT_REGEX = /\b(?:reasoning[._\s]+effort|reasoning[._\s]+parameters|reasoning|effort)\b/i;

/** How far from a rung value its own clause may name effort and still describe it. */
const EFFORT_DESCRIPTOR_WINDOW = 64;

function isExplicitFieldOrParameter(text: string, matchIndex: number, param: string): boolean {
  if (SUBJECT_FOLLOWING_VERBS.has(param)) return false;
  // "Unsupported parameter", "Invalid value", "Missing field" put a diagnostic word exactly
  // where a field name sits. It is never the subject the sentence is about (#8173).
  if (DIAGNOSTIC_NOISE_WORDS.has(param)) return false;
  // A rung value is never a field name: "Invalid reasoning effort. The max field is invalid."
  // names its subject explicitly in the sentence before, and no diagnostic says "the max field"
  // about an unrelated field named max. Judging the value on its own words first keeps the
  // quoted-field windows below from being applied to a ladder rung.
  if (EFFORT_RUNGS.has(param) && !namesRungAsDeclaredField(text, matchIndex, param)) return false;
  const pre = text.slice(Math.max(0, matchIndex - 48), matchIndex);
  if (
    /\b(?:reasoning[._\s]+effort|reasoning[._\s]+parameters|reasoning|effort)\s+(?:parameter|param|argument|arg|field|property)\s*(?:[:=]\s*['"`]?|['"`]|\s+)\s*$/i.test(
      pre
    )
  ) {
    return false;
  }
  if (/\b(?:parameter|param|argument|arg|field|property)\s*(?:[:=]\s*['"`]?|['"`]|\s+)\s*$/i.test(pre)) return true;
  const post = text.slice(matchIndex + param.length, Math.min(text.length, matchIndex + param.length + 32));
  if (/^\s*['"`]?\s+(?:parameter|param|argument|arg|field|property)\b/i.test(post)) return true;
  return false;
}

/**
 * Whether the rung at `matchIndex` is introduced as a field in its own right — the shapes
 * "the max field", "Invalid field: max", "parameter max" — rather than as a value under a
 * diagnostic noun such as "Unsupported value: 'max'".
 */
function namesRungAsDeclaredField(text: string, matchIndex: number, param: string): boolean {
  const pre = text.slice(Math.max(0, matchIndex - 48), matchIndex);
  if (/\b(?:parameter|param|argument|arg|field|property)\s*(?:[:=]\s*['"`]?|['"`]|\s+)\s*$/i.test(pre)) return true;
  const post = text.slice(matchIndex + param.length, Math.min(text.length, matchIndex + param.length + 32));
  return /^\s*['"`]?\s+(?:parameter|param|argument|arg|field|property)\b/i.test(post);
}

function isEffortDescriptorInContext(text: string, matchIndex: number, param: string): boolean {
  if (EFFORT_RUNGS.has(param)) {
    if (namesRungAsDeclaredField(text, matchIndex, param)) return false;
    // A rung is an effort descriptor when the surrounding words tie it to effort. The context
    // window is the whole diagnostic minus OTHER parameters: a message that ends
    // "Supported values are: 'low','medium','high'" must not turn the refused 'max' into a
    // competing field merely because the same sentence lists a ladder.
    const pre = text.slice(Math.max(0, matchIndex - EFFORT_DESCRIPTOR_WINDOW), matchIndex);
    if (REASONING_EFFORT_CONTEXT_REGEX.test(pre)) return true;
    const post = text.slice(matchIndex + param.length, Math.min(text.length, matchIndex + param.length + EFFORT_DESCRIPTOR_WINDOW));
    return REASONING_EFFORT_CONTEXT_REGEX.test(post);
  }
  if (STRUCTURAL_EFFORT_WORDS.has(param)) {
    const preText = text.slice(Math.max(0, matchIndex - 32), matchIndex);
    return /(?:reasoning[._\s]+effort|reasoning|effort)\s*[:=]?\s*['"`]?$/i.test(preText);
  }
  return false;
}

function tokenStartIndex(m: RegExpExecArray, rawToken: string, isPrefixToken: boolean): number {
  const offset = isPrefixToken ? m[0].indexOf(rawToken) : m[0].lastIndexOf(rawToken);
  return offset >= 0 ? m.index + offset : m.index;
}

function isCompetingParameterToken(text: string, tokenIndex: number, rawToken: string): boolean {
  const p = cleanParam(rawToken);
  if (!p || EFFORT_PARAM_NAMES.has(p) || SUBJECT_FOLLOWING_VERBS.has(p)) return false;
  // A diagnostic adjective or noun ("Unsupported", "invalid", "value", "field") occupies the
  // syntactic slot of a field name without naming one. GENERIC_PARAM_WORDS covers most of them;
  // "bad" and "malformed" were missing there, so the two sets stay separate.
  if (DIAGNOSTIC_NOISE_WORDS.has(p)) return false;
  // A bare number names a limit, not a request field ("thinking budget 32000 is not supported").
  if (NUMERIC_VALUE_TOKEN.test(p)) return false;
  if (isExplicitFieldOrParameter(text, tokenIndex, p)) return true;
  if (GENERIC_PARAM_WORDS.has(p)) return false;
  if (isEffortDescriptorInContext(text, tokenIndex, p)) return false;
  return true;
}

/**
 * Concrete request fields a diagnostic can name instead of effort. Unlike the heuristic subject
 * patterns below, a member of this list is a real wire field, so naming one beside an
 * authoritative effort param really is a different subject.
 */
const CONCRETE_FIELD_TERM =
  /\b(?:temperature|top_p|top_k|max_tokens|max_completion_tokens|max_output_tokens|min_tokens|stop|stop_sequences|presence_penalty|frequency_penalty|repetition_penalty|logit_bias|logprobs|top_logprobs|seed|tools|tool_choice|functions|function_call|response_format|stream|stream_options|user|safety_identifier|service_tier|modalities|prediction|parallel_tool_calls|messages|prompt|input|image_url)\b/gi;

/**
 * Whether the text names a concrete non-effort request field while rejecting something.
 *
 * This is the only inference allowed to override a structured `param` that already names
 * reasoning effort. Everything heuristic in `diagnosticTextNamesOtherParameter` — adjective
 * subjects, quoted rungs, "value:" prefixes — must not, or it would re-break every canonical
 * effort refusal whose prose happens to quote the refused value (#8173).
 */
function diagnosticTextNamesConcreteOtherField(text: string): boolean {
  for (let m = CONCRETE_FIELD_TERM.exec(text); m; m = CONCRETE_FIELD_TERM.exec(text)) {
    const from = Math.max(0, m.index - REJECTION_WINDOW);
    const to = Math.min(text.length, m.index + m[0].length + REJECTION_WINDOW);
    if (REJECTION_LANGUAGE.test(text.slice(from, to))) return true;
  }
  return false;
}

function diagnosticTextNamesOtherParameter(text: string, authoritativeEffortSubject = false): boolean {
  if (!text) return false;
  const s = text.replace(GENERIC_ERROR_TYPE, " ");
  if (authoritativeEffortSubject) return diagnosticTextNamesConcreteOtherField(s);

  const paramPattern = /\b(?:parameter|param|argument|arg|field|property)\s*(?:[:=]\s*['"`]?|['"`]|\s+)['"`]?([a-zA-Z0-9_\-\.]+)['"`]?/gi;
  for (let m = paramPattern.exec(s); m; m = paramPattern.exec(s)) {
    const tokenIndex = tokenStartIndex(m, m[1], false);
    if (isCompetingParameterToken(s, tokenIndex, m[1])) return true;
  }

  const prefixParamPattern = /\b['"`]?([a-zA-Z0-9_\-\.]+)['"`]?\s+(?:parameter|param|argument|arg|field|property)\b/gi;
  for (let m = prefixParamPattern.exec(s); m; m = prefixParamPattern.exec(s)) {
    const tokenIndex = tokenStartIndex(m, m[1], true);
    if (isCompetingParameterToken(s, tokenIndex, m[1])) return true;
  }

  const subjectMustBe = /\b['"`]?([a-zA-Z0-9_\-\.]+)['"`]?\s+must\s+be\b/gi;
  for (let m = subjectMustBe.exec(s); m; m = subjectMustBe.exec(s)) {
    const tokenIndex = tokenStartIndex(m, m[1], true);
    if (isCompetingParameterToken(s, tokenIndex, m[1])) return true;
  }

  const subjectIsRejection =
    /\b['"`]?([a-zA-Z0-9_\-\.]+)['"`]?\s+(?:is|are)\s+(?:invalid|not\s+valid|unsupported|unrecognized|unknown|not\s+allowed|not\s+permitted|not\s+supported|required|missing)\b/gi;
  for (let m = subjectIsRejection.exec(s); m; m = subjectIsRejection.exec(s)) {
    const tokenIndex = tokenStartIndex(m, m[1], true);
    if (isCompetingParameterToken(s, tokenIndex, m[1])) return true;
  }

  const subjectColon =
    /\b['"`]?([a-zA-Z0-9_\-\.]+)['"`]?\s*:\s*(?:must\s+be|invalid|unsupported|unrecognized|unknown|expected|required|missing|not\s+allowed)\b/gi;
  for (let m = subjectColon.exec(s); m; m = subjectColon.exec(s)) {
    const tokenIndex = tokenStartIndex(m, m[1], true);
    if (isCompetingParameterToken(s, tokenIndex, m[1])) return true;
  }

  const rejectionExtra =
    /\b(?:unexpected|missing|cannot\s+(?:specify|use|set|pass|provide))\s+(?:field|param|parameter|argument|property)?\s*['"`]?([a-zA-Z0-9_\-\.]+)['"`]?/gi;
  for (let m = rejectionExtra.exec(s); m; m = rejectionExtra.exec(s)) {
    const tokenIndex = tokenStartIndex(m, m[1], false);
    if (isCompetingParameterToken(s, tokenIndex, m[1])) return true;
  }

  const nonEffortTerm = /\b(?:temperature|top_p|top_k|max_tokens|max_completion_tokens|max_output_tokens|min_tokens|stop|stop_sequences|presence_penalty|frequency_penalty|repetition_penalty|logit_bias|logprobs|top_logprobs|seed|tools|tool_choice|functions|function_call|response_format|stream|stream_options|user|service_tier|modalities|prediction|parallel_tool_calls|messages|prompt)\b/gi;
  for (let m = nonEffortTerm.exec(s); m; m = nonEffortTerm.exec(s)) {
    const from = Math.max(0, m.index - REJECTION_WINDOW);
    const to = Math.min(s.length, m.index + m[0].length + REJECTION_WINDOW);
    if (REJECTION_LANGUAGE.test(s.slice(from, to))) return true;
  }

  const rejectionDirect = /\b(?:invalid|unsupported|unrecognized|unknown)\s+['"`]?([a-zA-Z0-9_\-\.]+)['"`]?/gi;
  for (let m = rejectionDirect.exec(s); m; m = rejectionDirect.exec(s)) {
    const tokenIndex = tokenStartIndex(m, m[1], false);
    if (isCompetingParameterToken(s, tokenIndex, m[1])) return true;
  }
  return false;
}

function isConflictingDiagnosticProse(str: string | undefined, authoritativeEffortSubject = false): boolean {
  if (!str) return false;
  const s = str.trim();
  if (!s) return false;
  if (
    /\b(?:permission[-_]denied|insufficient[-_]quota|rate[-_]limit[-_]exceeded|model[-_]not[-_]found|context[-_]length[-_]exceeded|access[-_]denied|unauthorized|invalid[-_]api[-_]key|account[-_]deactivated|billing[-_]hard[-_]limit)\b/i.test(s)
  ) {
    return true;
  }
  const codeMatch = /\bcode\s*[:=]\s*["']?([a-zA-Z0-9_\-]+)["']?/i.exec(s);
  if (codeMatch && codeMatch[1]) {
    const code = normalizeErrorTag(codeMatch[1]);
    if (!EFFORT_COMPATIBLE_CODES.has(code) && !isHttpStatusText(code)) return true;
  }
  const typeMatch = /\btype\s*[:=]\s*["']?([a-zA-Z0-9_\-]+)["']?/i.exec(s);
  if (typeMatch && typeMatch[1]) {
    const type = normalizeErrorTag(typeMatch[1]);
    if (!EFFORT_COMPATIBLE_TYPES.has(type)) return true;
  }
  if (diagnosticTextNamesOtherParameter(s, authoritativeEffortSubject)) {
    return true;
  }
  return false;
}

/**
 * Whether a numeric code is the HTTP status echoed back rather than a vendor error code.
 *
 * Google answers a bad reasoning effort with `{"code":400,"error":{"message":"…"}}`, where the
 * numeric field is the response status. Treating it as an unrecognized semantic code made that
 * genuine refusal terminal (#8173). Only 4xx is accepted: a numeric 5xx is a server failure and
 * must keep its terminal verdict.
 */
function isHttpStatusText(token: string): boolean {
  if (!NUMERIC_VALUE_TOKEN.test(token)) return false;
  const value = Number(token);
  return Number.isInteger(value) && value >= 400 && value <= 499;
}

function isHttpStatusNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 499;
}

/**
 * Rejects error envelopes that carry a conflicting code (e.g. permission_denied, insufficient_quota,
 * rate_limit_exceeded, model_not_found, malformed non-string code) or competing diagnostic parameters
 * (e.g. reasoning_effort at root with an inner error identifying temperature) so they stay terminal
 * or proceed to combo failover without false reasoning-effort learning or same-target ladder retries (#8173).
 */
export function hasConflictingReasoningEffortCode(text: string | undefined): boolean {
  if (!text) return false;
  if (isIncompleteStructuredWrapper(text)) return true;
  let unescaped = text.trim();
  for (let d = 0; d < 3; d += 1) {
    if (unescaped.startsWith("Provider error 400: ")) {
      unescaped = unescaped.slice("Provider error 400: ".length).trim();
    }
    if (unescaped.startsWith("data:") && !unescaped.includes("\n")) {
      unescaped = unescaped.slice("data:".length).trim();
    }
  }
  let parsed: unknown;
  let outerPrefix = "";
  let outerSuffix = "";
  try {
    parsed = JSON.parse(unescaped);
  } catch {
    const extracted = extractJsonEnvelopeWithContext(unescaped);
    if (extracted) {
      parsed = extracted.value;
      outerPrefix = extracted.prefix;
      outerSuffix = extracted.suffix;
    }
  }
  if (isConflictingDiagnosticProse(outerPrefix) || isConflictingDiagnosticProse(outerSuffix)) {
    return true;
  }
  if (!parsed || typeof parsed !== "object") {
    if (isIncompleteStructuredWrapper(unescaped)) return true;
    const hasBraces = unescaped.includes("{") && unescaped.includes("}");
    const hasBrackets =
      unescaped.includes('["') ||
      (unescaped.includes("[") &&
        unescaped.includes("]") &&
        (unescaped.includes('"') || unescaped.includes("'") || unescaped.includes(",")));
    if (hasBraces || (hasBrackets && !carriesOnlyEffortEnumerations(unescaped))) return true;
    return isConflictingDiagnosticProse(unescaped);
  }
  try {
    const queue: unknown[] = [parsed];
    let examined = 0;
    while (queue.length > 0 && examined < 32) {
      const candidate = queue.shift();
      examined += 1;
      if (!candidate || typeof candidate !== "object") continue;
      if (Array.isArray(candidate)) {
        if (candidate.length > 32) return true;
        for (const item of candidate) {
          if (item && typeof item === "object") {
            queue.push(item);
          } else if (typeof item === "string") {
            if (item.length > 16_384) return true;
            let innerItem: unknown;
            let innerPrefix = "";
            let innerSuffix = "";
            try {
              innerItem = JSON.parse(item);
            } catch {
              const extractedItem = extractJsonEnvelopeWithContext(item);
              if (extractedItem) {
                innerItem = extractedItem.value;
                innerPrefix = extractedItem.prefix;
                innerSuffix = extractedItem.suffix;
              }
            }
            if (innerItem && typeof innerItem === "object") {
              if (isConflictingDiagnosticProse(innerPrefix) || isConflictingDiagnosticProse(innerSuffix)) {
                return true;
              }
              queue.push(innerItem);
            } else if (isIncompleteStructuredWrapper(item)) {
              return true;
            } else {
              const trimmed = item.trim();
              if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                try {
                  const parsedItem = JSON.parse(item);
                  if (parsedItem && typeof parsedItem === "object") {
                    queue.push(parsedItem);
                  } else {
                    return true;
                  }
                } catch {
                  return true;
                }
              } else {
                const codeLike = normalizeErrorTag(trimmed);
                if (
                  !codeLike.includes(" ") &&
                  (codeLike.includes("_") || codeLike.length < 32) &&
                  !EFFORT_COMPATIBLE_CODES.has(codeLike) &&
                  !EFFORT_COMPATIBLE_TYPES.has(codeLike)
                ) {
                  return true;
                }
                if (isConflictingDiagnosticProse(trimmed)) {
                  return true;
                }
              }
            }
          } else {
            return true;
          }
        }
        continue;
      }
      const rec = candidate as Record<string, unknown>;
      // A structured param/field naming effort is authoritative about the subject. Text
      // inference may only override it by naming a concrete other request field, never by
      // reading a diagnostic adjective or the refused value as a field name (#8173).
      const authoritativeEffortSubject = typeof rec.param === "string" && EFFORT_PARAM_NAMES.has(rec.param.trim().toLowerCase());
      if (rec.param !== undefined && rec.param !== null) {
        if (typeof rec.param !== "string") return true;
        const param = rec.param.trim().toLowerCase();
        if (param.length > 0 && !EFFORT_PARAM_NAMES.has(param)) return true;
      }
      if (rec.code !== undefined && rec.code !== null) {
        if (isHttpStatusNumber(rec.code)) {
          // An HTTP status echoed into `code` says nothing about which field was refused.
        } else if (typeof rec.code !== "string") return true;
        else {
          const code = normalizeErrorTag(rec.code);
          if (!EFFORT_COMPATIBLE_CODES.has(code)) return true;
        }
      }
      if (rec.type !== undefined && rec.type !== null) {
        if (typeof rec.type !== "string") return true;
        const type = normalizeErrorTag(rec.type);
        if (!EFFORT_COMPATIBLE_TYPES.has(type)) return true;
      }
      for (const field of ["message", "error", "details", "detail", "response", "last_error", "errors"] as const) {
        const val = rec[field];
        if (val && typeof val === "object") {
          queue.push(val);
        } else if (typeof val === "string") {
          let inner: unknown;
          let innerPrefix = "";
          let innerSuffix = "";
          try {
            inner = JSON.parse(val);
          } catch {
            const extracted = extractJsonEnvelopeWithContext(val);
            if (extracted) {
              inner = extracted.value;
              innerPrefix = extracted.prefix;
              innerSuffix = extracted.suffix;
            }
          }
          if (inner && typeof inner === "object") {
            if (isConflictingDiagnosticProse(innerPrefix, authoritativeEffortSubject) || isConflictingDiagnosticProse(innerSuffix, authoritativeEffortSubject)) {
              return true;
            }
            queue.push(inner);
          } else if (isIncompleteStructuredWrapper(val)) {
            return true;
          } else if (isConflictingDiagnosticProse(val, authoritativeEffortSubject)) {
            return true;
          }
        }
      }
    }
    if (queue.length > 0) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function diagnosticTextBlamesReasoningEffort(text: string): boolean {
  if (diagnosticTextNamesOtherParameter(text)) return false;
  if (/unsupported.{0,24}effort/i.test(text)) return true;
  const scanned = text.replace(GENERIC_ERROR_TYPE, " ");
  const term = /reasoning\.effort|reasoning_effort|reasoning effort|thinking budget|reasoning_parameters/gi;
  for (let match = term.exec(scanned); match; match = term.exec(scanned)) {
    const preText = scanned.slice(0, match.index);
    const postText = scanned.slice(match.index + match[0].length);
    const lastBoundary = Math.max(
      preText.lastIndexOf(";"),
      preText.lastIndexOf("\n"),
      preText.lastIndexOf("|"),
      preText.search(/\.(?:\s+|$)(?=[^.]*$)/)
    );
    const clauseStart = lastBoundary !== -1 ? lastBoundary + 1 : 0;
    const nextBoundary = postText.search(/[;\n|]|\.(?:\s+|$)/);
    const clauseEnd = nextBoundary !== -1 ? match.index + match[0].length + nextBoundary : scanned.length;

    const from = Math.max(clauseStart, match.index - REJECTION_WINDOW);
    const to = Math.min(clauseEnd, match.index + match[0].length + REJECTION_WINDOW);
    const windowText = scanned.slice(from, to);
    if (REJECTION_LANGUAGE.test(windowText)) {
      if (!diagnosticTextNamesOtherParameter(windowText)) {
        return true;
      }
    }
  }
  return false;
}

function diagnosticRecordBlamesReasoningEffort(rec: Record<string, unknown>, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof rec.param === "string") {
    const param = rec.param.trim().toLowerCase();
    if (EFFORT_PARAM_NAMES.has(param)) return true;
    return false;
  }
  if (typeof rec.message === "string") {
    if (rec.message.includes("{") || rec.message.startsWith("Provider error 400: ")) {
      return isReasoningEffortRejection(rec.message, depth + 1);
    }
    if (diagnosticTextBlamesReasoningEffort(rec.message)) return true;
  }
  if (typeof rec.error === "string") {
    if (rec.error.includes("{") || rec.error.startsWith("Provider error 400: ")) {
      return isReasoningEffortRejection(rec.error, depth + 1);
    }
    if (diagnosticTextBlamesReasoningEffort(rec.error)) return true;
  }
  if (typeof rec.detail === "string") {
    if (rec.detail.includes("{") || rec.detail.startsWith("Provider error 400: ")) {
      return isReasoningEffortRejection(rec.detail, depth + 1);
    }
    if (diagnosticTextBlamesReasoningEffort(rec.detail)) return true;
  } else if (Array.isArray(rec.detail)) {
    for (const item of rec.detail) {
      if (item && typeof item === "object") {
        if (diagnosticRecordBlamesReasoningEffort(item as Record<string, unknown>, depth + 1)) return true;
      } else if (typeof item === "string") {
        if (item.includes("{") || item.startsWith("Provider error 400: ")) {
          if (isReasoningEffortRejection(item, depth + 1)) return true;
        } else if (diagnosticTextBlamesReasoningEffort(item)) {
          return true;
        }
      }
    }
  } else if (rec.detail && typeof rec.detail === "object") {
    if (diagnosticRecordBlamesReasoningEffort(rec.detail as Record<string, unknown>, depth + 1)) return true;
  }
  if (typeof rec.details === "string") {
    if (rec.details.includes("{") || rec.details.startsWith("Provider error 400: ")) {
      return isReasoningEffortRejection(rec.details, depth + 1);
    }
    if (diagnosticTextBlamesReasoningEffort(rec.details)) return true;
  } else if (Array.isArray(rec.details)) {
    for (const item of rec.details) {
      if (item && typeof item === "object") {
        if (diagnosticRecordBlamesReasoningEffort(item as Record<string, unknown>, depth + 1)) return true;
      } else if (typeof item === "string") {
        if (item.includes("{") || item.startsWith("Provider error 400: ")) {
          if (isReasoningEffortRejection(item, depth + 1)) return true;
        } else if (diagnosticTextBlamesReasoningEffort(item)) {
          return true;
        }
      }
    }
  } else if (rec.details && typeof rec.details === "object") {
    if (diagnosticRecordBlamesReasoningEffort(rec.details as Record<string, unknown>, depth + 1)) return true;
  }
  if (typeof rec.last_error === "string") {
    if (rec.last_error.includes("{") || rec.last_error.startsWith("Provider error 400: ")) {
      return isReasoningEffortRejection(rec.last_error, depth + 1);
    }
    if (diagnosticTextBlamesReasoningEffort(rec.last_error)) return true;
  } else if (rec.last_error && typeof rec.last_error === "object") {
    if (diagnosticRecordBlamesReasoningEffort(rec.last_error as Record<string, unknown>, depth + 1)) return true;
  }
  return false;
}

/**
 * Evidence test for a rejection body: does it blame reasoning effort?
 *
 * Restricts inspections to authoritative diagnostic carriers (error, errors, details, detail, last_error, response)
 * so echoed request context (e.g. request.param: "reasoning_effort") does not falsely classify unrelated 400s
 * (such as temperature or max_tokens errors) as effort refusals (#8173).
 */
export function isReasoningEffortRejection(text: string | undefined, depth = 0): boolean {
  if (!text || depth > 4) return false;
  if (isHardPolicyOrOriginRefusal(text)) return false;
  if (hasConflictingReasoningEffortCode(text)) return false;

  let unescaped = text.trim();
  for (let d = 0; d < 3; d += 1) {
    if (unescaped.startsWith("Provider error 400: ")) {
      unescaped = unescaped.slice("Provider error 400: ".length).trim();
    }
    if (unescaped.startsWith("data:") && !unescaped.includes("\n")) {
      unescaped = unescaped.slice("data:".length).trim();
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(unescaped);
  } catch {
    parsed = extractJsonEnvelope(unescaped);
  }

  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed)) {
      if (hasConflictingReasoningEffortCode(unescaped)) return false;
      for (const item of parsed) {
        if (item && typeof item === "object") {
          if (diagnosticRecordBlamesReasoningEffort(item as Record<string, unknown>, depth + 1)) return true;
        } else if (typeof item === "string") {
          if (item.includes("{") || item.startsWith("Provider error 400: ")) {
            if (isReasoningEffortRejection(item, depth + 1)) return true;
          } else if (diagnosticTextBlamesReasoningEffort(item)) {
            return true;
          }
        }
      }
      return false;
    }

    const root = parsed as Record<string, unknown>;

    if (root.error !== undefined && root.error !== null) {
      if (typeof root.error === "object" && !Array.isArray(root.error)) {
        if (diagnosticRecordBlamesReasoningEffort(root.error as Record<string, unknown>, depth + 1)) return true;
      } else if (typeof root.error === "string") {
        if (root.error.includes("{") || root.error.startsWith("Provider error 400: ")) {
          if (isReasoningEffortRejection(root.error, depth + 1)) return true;
        } else if (diagnosticTextBlamesReasoningEffort(root.error)) {
          return true;
        }
      }
    }

    if (Array.isArray(root.errors)) {
      for (const item of root.errors) {
        if (item && typeof item === "object") {
          if (diagnosticRecordBlamesReasoningEffort(item as Record<string, unknown>, depth + 1)) return true;
        } else if (typeof item === "string") {
          if (item.includes("{") || item.startsWith("Provider error 400: ")) {
            if (isReasoningEffortRejection(item, depth + 1)) return true;
          } else if (diagnosticTextBlamesReasoningEffort(item)) {
            return true;
          }
        }
      }
    }

    if (Array.isArray(root.details)) {
      for (const item of root.details) {
        if (item && typeof item === "object") {
          if (diagnosticRecordBlamesReasoningEffort(item as Record<string, unknown>, depth + 1)) return true;
        } else if (typeof item === "string") {
          if (item.includes("{") || item.startsWith("Provider error 400: ")) {
            if (isReasoningEffortRejection(item, depth + 1)) return true;
          } else if (diagnosticTextBlamesReasoningEffort(item)) {
            return true;
          }
        }
      }
    } else if (typeof root.details === "string") {
      if (root.details.includes("{") || root.details.startsWith("Provider error 400: ")) {
        if (isReasoningEffortRejection(root.details, depth + 1)) return true;
      } else if (diagnosticTextBlamesReasoningEffort(root.details)) {
        return true;
      }
    } else if (root.details && typeof root.details === "object") {
      if (diagnosticRecordBlamesReasoningEffort(root.details as Record<string, unknown>, depth + 1)) return true;
    }

    if (typeof root.detail === "string") {
      if (root.detail.includes("{") || root.detail.startsWith("Provider error 400: ")) {
        if (isReasoningEffortRejection(root.detail, depth + 1)) return true;
      } else if (diagnosticTextBlamesReasoningEffort(root.detail)) {
        return true;
      }
    } else if (Array.isArray(root.detail)) {
      for (const item of root.detail) {
        if (item && typeof item === "object") {
          if (diagnosticRecordBlamesReasoningEffort(item as Record<string, unknown>, depth + 1)) return true;
        } else if (typeof item === "string") {
          if (item.includes("{") || item.startsWith("Provider error 400: ")) {
            if (isReasoningEffortRejection(item, depth + 1)) return true;
          } else if (diagnosticTextBlamesReasoningEffort(item)) {
            return true;
          }
        }
      }
    } else if (root.detail && typeof root.detail === "object") {
      if (diagnosticRecordBlamesReasoningEffort(root.detail as Record<string, unknown>, depth + 1)) return true;
    }

    if (typeof root.last_error === "string") {
      if (root.last_error.includes("{") || root.last_error.startsWith("Provider error 400: ")) {
        if (isReasoningEffortRejection(root.last_error, depth + 1)) return true;
      } else if (diagnosticTextBlamesReasoningEffort(root.last_error)) {
        return true;
      }
    } else if (root.last_error && typeof root.last_error === "object") {
      if (diagnosticRecordBlamesReasoningEffort(root.last_error as Record<string, unknown>, depth + 1)) return true;
    }

    if (root.response && typeof root.response === "object") {
      const resp = root.response as Record<string, unknown>;
      if (resp.error && typeof resp.error === "object") {
        if (diagnosticRecordBlamesReasoningEffort(resp.error as Record<string, unknown>, depth + 1)) return true;
      }
      if (typeof resp.last_error === "string") {
        if (resp.last_error.includes("{") || resp.last_error.startsWith("Provider error 400: ")) {
          if (isReasoningEffortRejection(resp.last_error, depth + 1)) return true;
        } else if (diagnosticTextBlamesReasoningEffort(resp.last_error)) {
          return true;
        }
      } else if (resp.last_error && typeof resp.last_error === "object") {
        if (diagnosticRecordBlamesReasoningEffort(resp.last_error as Record<string, unknown>, depth + 1)) return true;
      }
      if (typeof resp.details === "string") {
        if (resp.details.includes("{") || resp.details.startsWith("Provider error 400: ")) {
          if (isReasoningEffortRejection(resp.details, depth + 1)) return true;
        } else if (diagnosticTextBlamesReasoningEffort(resp.details)) {
          return true;
        }
      } else if (resp.details && typeof resp.details === "object") {
        if (diagnosticRecordBlamesReasoningEffort(resp.details as Record<string, unknown>, depth + 1)) return true;
      }
      if (typeof resp.detail === "string") {
        if (resp.detail.includes("{") || resp.detail.startsWith("Provider error 400: ")) {
          if (isReasoningEffortRejection(resp.detail, depth + 1)) return true;
        } else if (diagnosticTextBlamesReasoningEffort(resp.detail)) {
          return true;
        }
      } else if (resp.detail && typeof resp.detail === "object") {
        if (diagnosticRecordBlamesReasoningEffort(resp.detail as Record<string, unknown>, depth + 1)) return true;
      }
    }

    if (root.error === undefined || typeof root.error !== "object") {
      if (diagnosticRecordBlamesReasoningEffort(root, depth + 1)) return true;
    }

    return false;
  }

  const hasBraces = unescaped.includes("{") && unescaped.includes("}");
  const hasBrackets =
    unescaped.includes('["') ||
    (unescaped.includes("[") &&
      unescaped.includes("]") &&
      (unescaped.includes('"') || unescaped.includes("'") || unescaped.includes(",")));
  if (hasBraces || (hasBrackets && !carriesOnlyEffortEnumerations(unescaped))) return false;
  if (isIncompleteStructuredWrapper(unescaped)) return false;

  return diagnosticTextBlamesReasoningEffort(unescaped);
}

/**
 * Plan a single-rung downgrade for a rejected request: records the refusal (so later turns
 * clamp before dispatch) and returns the next lower rung the model does publish.
 */
export function planReasoningEffortDowngrade(args: {
  provider: OcxProviderConfig;
  modelId: string;
  requested?: string;
  rejectionText?: string;
}): { effort: string; recorded: boolean } | undefined {
  if (args.rejectionText && (isHardPolicyOrOriginRefusal(args.rejectionText) || hasConflictingReasoningEffortCode(args.rejectionText))) return undefined;
  const requested = args.requested === "ultra" ? "max" : args.requested;
  if (!requested || !RANKED.includes(requested)) return undefined;
  const recorded = recordUnsupportedReasoningEffort(args.provider, args.modelId, requested, args.rejectionText);
  // Same precedence as configuredReasoningEfforts(): a hand-written ladder is a contract and
  // models.dev is only consulted when nothing was configured for this model. Reading metadata
  // first would have picked the downgrade rung off the published ladder even where a pinned
  // one disagreed, so the replay could land on a rung the registry deliberately excludes.
  const effective = sanitizeLadder(modelLadderValue(args.provider.modelReasoningEfforts, args.modelId))
    ?? sanitizeLadder(args.provider.reasoningEfforts)
    ?? metadataEffortValues(args.provider, args.modelId);
  const ladder = (effective ?? []).filter(effort => RANKED.includes(effort));
  if (ladder.length === 0) return undefined;
  const candidates = ladder
    .filter(effort => RANKED.indexOf(effort) < RANKED.indexOf(requested))
    .filter(effort => !isReasoningEffortLearnedUnsupported(args.provider, args.modelId, effort));
  if (candidates.length === 0) return undefined;
  return { effort: candidates[candidates.length - 1], recorded };
}

/**
 * Refresh the models.dev snapshot. Best-effort and idempotent: never throws, never blocks a
 * request, keeps the previous snapshot on failure. Ladders are stored for the gated destinations
 * only (OpenCode Zen + Zen Go: about 130 models), while every published provider `api` URL is
 * kept so the gate can be checked against real data and widened without another format change.
 * Non-reasoning models carry no ladder and are dropped.
 */
type RefreshOutcome = {
  ok: boolean;
  reason: string;
  providers?: number;
  models?: number;
};

/** Bound a caller's wait without cancelling the shared refresh job. */
function waitForRefresh(work: Promise<RefreshOutcome>, waitMs: number | undefined): Promise<RefreshOutcome> {
  if (waitMs === undefined) return work;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    return Promise.resolve({ ok: false, reason: "invalid wait budget" });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RefreshOutcome>(resolve => {
    timer = setTimeout(() => resolve({ ok: false, reason: "wait budget exceeded" }), waitMs);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function refreshReasoningMetadata(options: { force?: boolean; waitMs?: number } = {}): Promise<RefreshOutcome> {
  const snapshot = loadSnapshot();
  if (!options.force && snapshot && Date.now() - snapshot.fetchedAt <= CACHE_TTL_MS) {
    return { ok: true, reason: "fresh" };
  }
  if (refreshInFlight) {
    // A joined caller learns the shared outcome: a refused or failed refresh is not a success.
    return waitForRefresh(refreshInFlight.then(outcome => outcome.ok ? { ok: true, reason: "coalesced" } : outcome), options.waitMs);
  }
  const job = (async () => {
    const response = await fetch(SOURCE_URL, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      // A hanging connection must not pin refreshInFlight for the life of the process.
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("models.dev HTTP " + response.status);
    const raw = await response.json() as Record<string, { api?: unknown; models?: Record<string, unknown> }>;
    const providers: MetadataSnapshot["providers"] = {};
    const apis: Record<string, string> = {};
    const gated = new Set(Object.values(BASE_URL_TO_METADATA_PROVIDER));
    let models = 0;
    for (const [providerKey, entry] of Object.entries(raw ?? {})) {
      const api = normalizeDestinationUrl(typeof entry?.api === "string" ? entry.api : undefined);
      if (api) apis[providerKey] = api;
      if (!gated.has(providerKey)) continue;
      const out: Record<string, ReasoningMetadataModel> = {};
      for (const [modelId, value] of Object.entries(entry?.models ?? {})) {
        const model = value as { reasoning?: unknown; reasoning_options?: unknown };
        if (model?.reasoning !== true) continue;
        const options: ReasoningMetadataOption[] = [];
        if (Array.isArray(model?.reasoning_options)) {
          for (const option of model.reasoning_options) {
            if (!option || typeof option !== "object") continue;
            const type = (option as { type?: unknown }).type;
            if (typeof type !== "string") continue;
            const values = (option as { values?: unknown }).values;
            options.push({
              type,
              ...(Array.isArray(values)
                ? { values: values.filter((v): v is string => typeof v === "string").slice(0, 12) }
                : {}),
            });
          }
        }
        out[modelId] = { reasoning: model?.reasoning === true, options };
        models += 1;
      }
      if (Object.keys(out).length === 0) continue;
      providers[providerKey] = out;
    }
    const next: MetadataSnapshot = { version: 2, fetchedAt: Date.now(), source: SOURCE_URL, providers, apis };
    // The last await is the network read; publication waits out an overlapping optional
    // config-root ACL flight (#7815) and a timed-out admission fails this refresh unpublished.
    const dir = getConfigDir();
    await withConfigDirHardeningSettled(dir, () => atomicWriteFile(join(dir, FILENAME), JSON.stringify(next) + "\n"));
    snapshotMemo = next;
    return { ok: true, reason: "refreshed", providers: Object.keys(providers).length, models };
  })();
  const settled = job.catch((error): RefreshOutcome => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
  const shared = settled.finally(() => { if (refreshInFlight === shared) refreshInFlight = null; });
  refreshInFlight = shared;
  return waitForRefresh(settled, options.waitMs);
}

/**
 * Optional background refresh for callers that do not wait for a snapshot. Catalog sync uses
 * refreshReasoningMetadata with a bounded wait; an expired ladder read can request this refresh.
 * A classified toggle/budget model can have a fallback ladder without any snapshot, so this
 * path must never bootstrap a missing snapshot. One refresh per process; failures are ignored.
 */
export function ensureReasoningMetadataSnapshot(): void {
  const snapshot = loadSnapshot();
  if (!snapshot || Date.now() - snapshot.fetchedAt <= CACHE_TTL_MS) return;
  if (refreshInFlight) return;
  void refreshReasoningMetadata().catch(() => undefined);
}

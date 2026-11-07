/**
 * Shared wire contract for anonymous daily product telemetry (schemaVersion 1).
 *
 * This module is deliberately import-free so both the local proxy and the Cloudflare Worker
 * collector (services/telemetry-collector) can import it directly without pulling runtime
 * dependencies across project boundaries.
 */

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_MAX_MODELS = 64;
export const TELEMETRY_VERSION_RE = /^\d+\.\d+\.\d+(-preview\.\d{8}(\.\d+)?)?$/;

export const PROVIDER_KINDS = Object.freeze([
  "openai",
  "chatgpt",
  "anthropic",
  "claude-subscription",
  "google",
  "vertex",
  "xai",
  "deepseek",
  "moonshot",
  "qwen",
  "zai",
  "minimax",
  "mistral",
  "openrouter",
  "groq",
  "cerebras",
  "together",
  "fireworks",
  "cursor",
  "kiro",
  "copilot",
  "devin",
  "ollama",
  "lmstudio",
  "local-other",
  "other",
] as const);

export type TelemetryProviderKind = typeof PROVIDER_KINDS[number];
export type ProviderKind = TelemetryProviderKind;

export const MODEL_FAMILIES = Object.freeze([
  "gpt-6",
  "gpt-5",
  "gpt-4",
  "o-series",
  "codex",
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  "gemini-3",
  "gemini-2",
  "grok",
  "deepseek",
  "qwen",
  "kimi",
  "glm",
  "minimax",
  "mistral",
  "llama",
  "other",
] as const);

export type TelemetryModelFamily = typeof MODEL_FAMILIES[number];
export type ModelFamily = TelemetryModelFamily;

export const INSTALL_CHANNELS = Object.freeze([
  "npm-global",
  "pnpm-global",
  "bun-global",
  "mise",
  "standalone",
  "desktop",
  "docker",
  "source",
  "unknown",
] as const);

export type TelemetryInstallChannel = typeof INSTALL_CHANNELS[number];
export type InstallChannel = TelemetryInstallChannel;

export const RELEASE_CHANNELS = Object.freeze([
  "latest",
  "preview",
] as const);

export type TelemetryReleaseChannel = typeof RELEASE_CHANNELS[number];
export type ReleaseChannel = TelemetryReleaseChannel;

export const OS_VALUES = Object.freeze([
  "darwin",
  "linux",
  "win32",
  "other",
] as const);

export type TelemetryOs = typeof OS_VALUES[number];

export const ARCH_VALUES = Object.freeze([
  "x64",
  "arm64",
  "other",
] as const);

export type TelemetryArch = typeof ARCH_VALUES[number];

export const REQUEST_OUTCOME_CLASSES = Object.freeze([
  "completed",
  "failed",
  "incomplete",
  "aborted",
] as const);
export const TELEMETRY_OUTCOME_CLASSES = REQUEST_OUTCOME_CLASSES;
export type TelemetryOutcomeClass = typeof REQUEST_OUTCOME_CLASSES[number];

export const REQUEST_FAILURE_CAUSES = Object.freeze([
  "transport-unsent",
  "transport-ambiguous",
  "upstream-declined",
  "rate-limit",
  "quota-exhausted",
  "credential-rejected",
  "policy-refusal",
  "parameter-rejected",
  "ciphertext-refusal",
  "payload-too-large",
  "payload-rejected",
  "upstream-fault",
  "empty-output",
  "client-cancelled",
  "local-refusal",
] as const);
export const TELEMETRY_FAILURE_CAUSES = REQUEST_FAILURE_CAUSES;
export type TelemetryFailureCause = typeof REQUEST_FAILURE_CAUSES[number];

export interface TelemetryEnvV1 {
  version: string;
  releaseChannel: TelemetryReleaseChannel;
  os: TelemetryOs;
  arch: TelemetryArch;
  installChannel: TelemetryInstallChannel;
}

export interface TelemetryRequestsV1 {
  completed: number;
  failed: number;
  incomplete: number;
  aborted: number;
}

export interface TelemetryModelRowV1 {
  providerKind: TelemetryProviderKind;
  modelFamily: TelemetryModelFamily;
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export type TelemetryErrorsV1 = Partial<Record<TelemetryFailureCause, number>>;

export interface TelemetryPayloadV1 {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  batchId: string;
  day: string;
  installDayHash: string;
  newInstall: boolean;
  env: TelemetryEnvV1;
  activeMinutes: number;
  requests: TelemetryRequestsV1;
  models: TelemetryModelRowV1[];
  errors: TelemetryErrorsV1;
}

const PROVIDER_KIND_SET: ReadonlySet<string> = new Set(PROVIDER_KINDS);
const MODEL_FAMILY_SET: ReadonlySet<string> = new Set(MODEL_FAMILIES);
const INSTALL_CHANNEL_SET: ReadonlySet<string> = new Set(INSTALL_CHANNELS);
const RELEASE_CHANNEL_SET: ReadonlySet<string> = new Set(RELEASE_CHANNELS);
const OS_VALUE_SET: ReadonlySet<string> = new Set(OS_VALUES);
const ARCH_VALUE_SET: ReadonlySet<string> = new Set(ARCH_VALUES);
const FAILURE_CAUSE_SET: ReadonlySet<string> = new Set(REQUEST_FAILURE_CAUSES);

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "batchId",
  "day",
  "installDayHash",
  "newInstall",
  "env",
  "activeMinutes",
  "requests",
  "models",
  "errors",
] as const;
const ENV_KEYS = ["version", "releaseChannel", "os", "arch", "installChannel"] as const;
const REQUESTS_KEYS = ["completed", "failed", "incomplete", "aborted"] as const;
const MODEL_ROW_KEYS = [
  "providerKind",
  "modelFamily",
  "requests",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const MAX_REQUEST_COUNT = 10_000_000;
const MAX_TOKEN_COUNT = 1_000_000_000_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  if (keys.length !== expected.length) return false;
  for (const key of expected) {
    if (!Object.hasOwn(record, key)) return false;
  }
  return true;
}

function isBoundedInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function parseCalendarUtcDayMs(day: string): number | null {
  const match = DAY_RE.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const ms = Date.UTC(year, month - 1, date);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== date
  ) {
    return null;
  }
  return ms;
}

export function validateTelemetryPayloadV1(
  input: unknown,
  now: number = Date.now(),
): { ok: true; payload: TelemetryPayloadV1 } | { ok: false; error: string } {
  if (!isPlainRecord(input)) return { ok: false, error: "payload must be a plain object" };
  if (!hasExactKeys(input, TOP_LEVEL_KEYS)) {
    return { ok: false, error: "payload has missing or unexpected top-level keys" };
  }
  if (input.schemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    return { ok: false, error: "schemaVersion must be 1" };
  }
  if (typeof input.batchId !== "string" || !UUID_RE.test(input.batchId)) {
    return { ok: false, error: "batchId must be a UUID" };
  }
  if (typeof input.day !== "string") {
    return { ok: false, error: "day must be a YYYY-MM-DD string" };
  }
  const dayMs = parseCalendarUtcDayMs(input.day);
  if (dayMs === null) {
    return { ok: false, error: "day must be a valid calendar date in YYYY-MM-DD format" };
  }
  const nowDate = new Date(now);
  const todayUtcMs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
  if (dayMs < todayUtcMs - 7 * DAY_MS || dayMs > todayUtcMs + DAY_MS) {
    return { ok: false, error: "day must be within [today - 7d, today + 1d]" };
  }
  if (typeof input.installDayHash !== "string" || !HEX64_RE.test(input.installDayHash)) {
    return { ok: false, error: "installDayHash must be 64 lowercase hex characters" };
  }
  if (typeof input.newInstall !== "boolean") {
    return { ok: false, error: "newInstall must be a boolean" };
  }
  if (!isPlainRecord(input.env) || !hasExactKeys(input.env, ENV_KEYS)) {
    return { ok: false, error: "env has missing or unexpected keys" };
  }
  const env = input.env;
  if (typeof env.version !== "string" || !TELEMETRY_VERSION_RE.test(env.version)) {
    return { ok: false, error: "env.version must match strict semver without build metadata" };
  }
  if (typeof env.releaseChannel !== "string" || !RELEASE_CHANNEL_SET.has(env.releaseChannel)) {
    return { ok: false, error: "env.releaseChannel is not in RELEASE_CHANNELS" };
  }
  if (typeof env.os !== "string" || !OS_VALUE_SET.has(env.os)) {
    return { ok: false, error: "env.os is not in OS_VALUES" };
  }
  if (typeof env.arch !== "string" || !ARCH_VALUE_SET.has(env.arch)) {
    return { ok: false, error: "env.arch is not in ARCH_VALUES" };
  }
  if (typeof env.installChannel !== "string" || !INSTALL_CHANNEL_SET.has(env.installChannel)) {
    return { ok: false, error: "env.installChannel is not in INSTALL_CHANNELS" };
  }
  if (!isBoundedInt(input.activeMinutes, 1440)) {
    return { ok: false, error: "activeMinutes must be an integer between 0 and 1440" };
  }
  if (!isPlainRecord(input.requests) || !hasExactKeys(input.requests, REQUESTS_KEYS)) {
    return { ok: false, error: "requests has missing or unexpected keys" };
  }
  for (const key of REQUESTS_KEYS) {
    if (!isBoundedInt(input.requests[key], MAX_REQUEST_COUNT)) {
      return { ok: false, error: `requests.${key} must be a bounded non-negative integer` };
    }
  }
  if (!Array.isArray(input.models) || input.models.length > TELEMETRY_MAX_MODELS) {
    return { ok: false, error: `models must be an array of at most ${TELEMETRY_MAX_MODELS} rows` };
  }
  const seenPairs = new Set<string>();
  const models: TelemetryModelRowV1[] = [];
  for (const row of input.models) {
    if (!isPlainRecord(row) || !hasExactKeys(row, MODEL_ROW_KEYS)) {
      return { ok: false, error: "models row has missing or unexpected keys" };
    }
    if (typeof row.providerKind !== "string" || !PROVIDER_KIND_SET.has(row.providerKind)) {
      return { ok: false, error: "models row providerKind is not in PROVIDER_KINDS" };
    }
    if (typeof row.modelFamily !== "string" || !MODEL_FAMILY_SET.has(row.modelFamily)) {
      return { ok: false, error: "models row modelFamily is not in MODEL_FAMILIES" };
    }
    const pairKey = `${row.providerKind}\0${row.modelFamily}`;
    if (seenPairs.has(pairKey)) {
      return { ok: false, error: "models rows must have unique (providerKind, modelFamily) pairs" };
    }
    seenPairs.add(pairKey);
    if (!isBoundedInt(row.requests, MAX_REQUEST_COUNT)) {
      return { ok: false, error: "models row requests must be a bounded non-negative integer" };
    }
    for (const tokenField of [
      "inputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "outputTokens",
      "reasoningTokens",
    ] as const) {
      if (!isBoundedInt(row[tokenField], MAX_TOKEN_COUNT)) {
        return { ok: false, error: `models row ${tokenField} must be a bounded non-negative integer` };
      }
    }
    models.push({
      providerKind: row.providerKind as TelemetryProviderKind,
      modelFamily: row.modelFamily as TelemetryModelFamily,
      requests: row.requests,
      inputTokens: row.inputTokens as number,
      cacheReadTokens: row.cacheReadTokens as number,
      cacheWriteTokens: row.cacheWriteTokens as number,
      outputTokens: row.outputTokens as number,
      reasoningTokens: row.reasoningTokens as number,
    });
  }
  if (!isPlainRecord(input.errors)) {
    return { ok: false, error: "errors must be a plain object" };
  }
  const errors: TelemetryErrorsV1 = {};
  for (const [cause, count] of Object.entries(input.errors)) {
    if (!FAILURE_CAUSE_SET.has(cause)) {
      return { ok: false, error: `errors key "${cause}" is not in REQUEST_FAILURE_CAUSES` };
    }
    if (!isBoundedInt(count, MAX_REQUEST_COUNT)) {
      return { ok: false, error: `errors["${cause}"] must be a bounded non-negative integer` };
    }
    errors[cause as TelemetryFailureCause] = count;
  }
  return {
    ok: true,
    payload: {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      batchId: input.batchId.toLowerCase(),
      day: input.day,
      installDayHash: input.installDayHash,
      newInstall: input.newInstall,
      env: {
        version: env.version,
        releaseChannel: env.releaseChannel as TelemetryReleaseChannel,
        os: env.os as TelemetryOs,
        arch: env.arch as TelemetryArch,
        installChannel: env.installChannel as TelemetryInstallChannel,
      },
      activeMinutes: input.activeMinutes,
      requests: {
        completed: input.requests.completed as number,
        failed: input.requests.failed as number,
        incomplete: input.requests.incomplete as number,
        aborted: input.requests.aborted as number,
      },
      models,
      errors,
    },
  };
}

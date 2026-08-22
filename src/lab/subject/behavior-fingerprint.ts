import { createHash } from "node:crypto";
import { jcsStringify } from "../digest";
import type { LabBehaviorSource, LabBehaviorValues } from "../live/types";

const CLOSED_KEYS = new Set([
  "wire.adapter", "wire.upstreamProtocol", "wire.responsesPath", "wire.commandCodeVersion", "wire.modelSuffixMode",
  "auth.mode", "auth.transport",
  "responses.stateful", "responses.upstreamStreaming", "responses.serviceTier", "responses.fastWireKind", "responses.fastWireValue", "responses.snapshotRepair", "responses.itemIdRepair",
  "limits.contextWindow", "limits.maxInputTokens", "limits.maxOutputTokens",
  "modalities.input",
  "sampling.omitTemperature", "sampling.omitTopP", "sampling.omitPenalties",
  "reasoning.supported", "reasoning.efforts", "reasoning.defaultEffort", "reasoning.effortMap", "reasoning.wireFormat",
  "reasoning.summaryMode", "reasoning.replayMode", "reasoning.splitMode", "reasoning.toggleMode", "reasoning.budgetMode",
  "tools.choiceRestrictions", "tools.parallel", "tools.hostedPreference", "tools.customFreeform", "tools.builtinNameEscaping",
  "cache.forwarding", "cache.retention", "anthropic.eofPolicy", "openai-chat.eofPolicy",
  "google.mode", "google.projectFingerprint", "google.locationFingerprint",
  "openrouter.order", "openrouter.only", "openrouter.allowFallbacks",
  "sidecars.vision", "sidecars.webSearch",
  "mcp.maxTools", "mcp.maxSchemaBytes", "mcp.maxResultBytes", "mcp.nativeLocalExec",
  "runtime.bunVersion", "runtime.platform", "runtime.arch", "runtime.streamMode", "runtime.fastMode", "runtime.effortCap",
  "headers.nonCredentialBehaviorDigest",
] as const);

const SOURCES = new Set<LabBehaviorSource>([
  "request", "model_override", "provider_config", "registry_runtime_default", "generated_model_metadata",
  "global_config", "adapter_default", "lab_forced",
]);

const SET_ARRAY_KEYS = new Set(["modalities.input", "reasoning.efforts", "tools.choiceRestrictions", "openrouter.only"]);
const ORDERED_ARRAY_KEYS = new Set(["openrouter.order"]);
const REQUIRED_KEYS = [
  "wire.adapter", "wire.upstreamProtocol", "auth.mode", "auth.transport", "mcp.nativeLocalExec",
  "runtime.bunVersion", "runtime.platform", "runtime.arch", "runtime.streamMode", "runtime.fastMode", "runtime.effortCap",
] as const;

function canonicalArray(key: string, value: unknown[]): unknown[] {
  if (SET_ARRAY_KEYS.has(key)) {
    const byBytes = value.map((item) => ({ item, bytes: jcsStringify(item) }));
    const seen = new Set<string>();
    for (const row of byBytes) {
      if (seen.has(row.bytes)) throw new Error(`harness_failure: duplicate behavior array value for ${key}`);
      seen.add(row.bytes);
    }
    byBytes.sort((a, b) => a.bytes < b.bytes ? -1 : a.bytes > b.bytes ? 1 : 0);
    return byBytes.map((row) => row.item);
  }
  if (ORDERED_ARRAY_KEYS.has(key)) return [...value];
  throw new Error(`harness_failure: unclassified_behavior_input array for ${key}`);
}

export function normalizeBehaviorValues(values: LabBehaviorValues): LabBehaviorValues {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("harness_failure: behavior resolver output is required");
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in values)) throw new Error(`harness_failure: unclassified_behavior_input missing ${key}`);
  }
  const normalized: LabBehaviorValues = {};
  for (const key of Object.keys(values).sort()) {
    if (!CLOSED_KEYS.has(key as never)) throw new Error(`harness_failure: unclassified_behavior_input ${key}`);
    const row = values[key];
    if (!row || typeof row !== "object" || Array.isArray(row) || !SOURCES.has(row.source)) {
      throw new Error(`harness_failure: invalid behavior source for ${key}`);
    }
    normalized[key] = {
      source: row.source,
      value: Array.isArray(row.value) ? canonicalArray(key, row.value) : row.value,
    };
  }
  return normalized;
}

/** Hash the authoritative production resolver output; Lab performs validation/canonicalization only. */
export function buildBehaviorFingerprintV1(values: LabBehaviorValues): string {
  const payload = { schemaVersion: 1, resolverVersion: 2, values: normalizeBehaviorValues(values) };
  return createHash("sha256").update(jcsStringify(payload)).digest("hex");
}

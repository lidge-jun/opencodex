import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const REQUIRED_ARTIFACTS = [
  "030_e2e.json",
  "030_client_history.json",
  "030_runtime_smoke.json",
  "030_gate_summary.txt",
] as const;

const TOP_LEVEL_KEYS: Record<string, readonly string[]> = {
  "030_e2e.json": [
    "schemaVersion", "verdict", "publicNetworkFallback", "poolDefault", "directIsolation",
    "http", "websocket", "compact", "apiProIsolation", "migrationRestore",
    "oneOpenAiModelGroup", "realClaudeStateUnchanged",
  ],
  "030_client_history.json": [
    "schemaVersion", "verdict", "selectedModel", "modelProvider", "resolvedModel",
    "reasoningMode", "rolloutCount", "attempts",
  ],
  "030_runtime_smoke.json": [
    "schemaVersion", "verdict", "instances", "distinctPids", "catalogReady", "poolDefault",
    "direct", "apiPro", "oneOpenAiModelGroup", "clientHistoryVerified", "codexVersion",
    "userStateUnchanged", "live10100Unchanged", "liveKey",
  ],
};
const MODE_CAPTURE_KEYS = [
  "providerName", "accountMode", "selectedModel", "wireModel", "upstream",
  "credentialOwner", "safeAccountOwner",
] as const;
const API_CAPTURE_KEYS = [...MODE_CAPTURE_KEYS, "reasoningMode"] as const;
const LIVE_KEY_KEYS = ["status", "liveCalls", "outcomes"] as const;
const OUTCOME_KEYS = ["status", "requestId", "selectedId", "resolvedId"] as const;

function exactKeys(value: unknown, allowed: readonly string[], label: string, errors: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label}: expected object`);
    return false;
  }
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) errors.push(`${label}: unknown or missing keys`);
  return true;
}

export function evidenceDenyFindings(text: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["absolute-home", /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/],
    ["temporary-path", /(?:\/(?:private\/)?(?:tmp|var\/folders)\/|[A-Za-z]:\\[^\r\n]*\\Temp\\)/i],
    ["email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
    ["bearer", /Bearer\s+[A-Za-z0-9._-]+/i],
    ["api-key", /\bsk-[A-Za-z0-9_-]{12,}\b/],
    ["jwt", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/],
    ["prompt", /(?:Reply exactly|"prompt"\s*:|"input"\s*:)/i],
    ["fixture-secret", /fixture-(?:api-key|codex-access|pool-access|refresh-token|admission|direct-caller|pool-account)/i],
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

function resolvedPaths(inputs: string[]): string[] {
  if (inputs.length === 1 && existsSync(inputs[0]!) && statSync(inputs[0]!).isDirectory()) {
    return REQUIRED_ARTIFACTS.map(name => join(inputs[0]!, name));
  }
  return inputs;
}

export function scanEvidence(inputs: string[]): string[] {
  const paths = resolvedPaths(inputs);
  const errors: string[] = [];
  if (paths.length !== REQUIRED_ARTIFACTS.length) errors.push("expected four provider-option artifacts");
  for (const path of paths) {
    const name = basename(path);
    if (!existsSync(path)) { errors.push(`${name}: missing`); continue; }
    const text = readFileSync(path, "utf8");
    if (!text.trim()) { errors.push(`${name}: empty`); continue; }
    for (const finding of evidenceDenyFindings(text)) errors.push(`${name}: ${finding}`);
    if (name === "030_gate_summary.txt") {
      if (!/^schemaVersion=1$/m.test(text)
        || !/^verdict=PASS$/m.test(text)
        || !/^command\[\d+\]=.+\|exit=0\|/m.test(text)) {
        errors.push(`${name}: invalid summary schema`);
      }
      continue;
    }
    const allowed = TOP_LEVEL_KEYS[name];
    if (!allowed) { errors.push(`${name}: unexpected artifact name`); continue; }
    let value: unknown;
    try { value = JSON.parse(text); } catch { errors.push(`${name}: invalid JSON`); continue; }
    if (!exactKeys(value, allowed, name, errors)) continue;
    if (value.schemaVersion !== 1 || value.verdict !== "PASS") errors.push(`${name}: invalid version/verdict`);
    if (name === "030_e2e.json") {
      if (value.publicNetworkFallback !== false) errors.push(`${name}: network fallback must be false`);
      for (const field of [
        "poolDefault", "directIsolation", "http", "websocket", "compact", "apiProIsolation",
        "migrationRestore", "oneOpenAiModelGroup",
      ]) if (value[field] !== "PASS") errors.push(`${name}: ${field} must PASS`);
      if (value.realClaudeStateUnchanged !== true) errors.push(`${name}: real Claude state changed`);
    }
    if (name === "030_client_history.json") {
      if (value.selectedModel !== "openai-apikey/gpt-5.6-sol-pro"
        || value.modelProvider !== "openai"
        || value.resolvedModel !== "gpt-5.6-sol"
        || value.reasoningMode !== "pro") {
        errors.push(`${name}: API-Pro client identity mismatch`);
      }
    }
    if (name === "030_runtime_smoke.json") {
      if (!Array.isArray(value.instances) || value.instances.length !== 2
        || value.instances.some(instance => !instance || typeof instance !== "object"
          || (instance as { port?: unknown }).port === 10100)) {
        errors.push(`${name}: invalid isolated instances`);
      }
      for (const field of [
        "distinctPids", "catalogReady", "oneOpenAiModelGroup", "clientHistoryVerified",
        "userStateUnchanged", "live10100Unchanged",
      ]) if (value[field] !== true) errors.push(`${name}: ${field} must be true`);
      if (exactKeys(value.poolDefault, MODE_CAPTURE_KEYS, `${name}.poolDefault`, errors)) {
        if (value.poolDefault.providerName !== "openai" || value.poolDefault.accountMode !== "pool"
          || value.poolDefault.credentialOwner !== "added") errors.push(`${name}: Pool evidence mismatch`);
      }
      if (exactKeys(value.direct, MODE_CAPTURE_KEYS, `${name}.direct`, errors)) {
        if (value.direct.providerName !== "openai" || value.direct.accountMode !== "direct"
          || value.direct.credentialOwner !== "caller" || value.direct.safeAccountOwner !== null) {
          errors.push(`${name}: Direct evidence mismatch`);
        }
      }
      if (exactKeys(value.apiPro, API_CAPTURE_KEYS, `${name}.apiPro`, errors)) {
        if (value.apiPro.providerName !== "openai-apikey"
          || value.apiPro.selectedModel !== "openai-apikey/gpt-5.6-sol-pro"
          || value.apiPro.wireModel !== "gpt-5.6-sol"
          || value.apiPro.reasoningMode !== "pro") errors.push(`${name}: API-Pro evidence mismatch`);
      }
      if (exactKeys(value.liveKey, LIVE_KEY_KEYS, `${name}.liveKey`, errors)) {
        if (![0, 2].includes(value.liveKey.liveCalls as number)) errors.push(`${name}: invalid liveCalls`);
        if (typeof value.liveKey.status !== "string" || !value.liveKey.status) errors.push(`${name}: missing live status`);
        const notRun = String(value.liveKey.status).startsWith("NOT RUN");
        if (notRun !== (value.liveKey.liveCalls === 0)) errors.push(`${name}: wrong live-key policy`);
        if (!Array.isArray(value.liveKey.outcomes)) errors.push(`${name}: outcomes must be an array`);
        else for (const [index, outcome] of value.liveKey.outcomes.entries()) {
          exactKeys(outcome, OUTCOME_KEYS, `${name}.outcomes[${index}]`, errors);
        }
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = scanEvidence(Bun.argv.slice(2));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log("OpenAI provider-option evidence scan passed");
}

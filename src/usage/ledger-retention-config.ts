import { statSync } from "node:fs";
import { loadConfig, saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig } from "../types";
import { usageLogPath } from "./log";
import {
  DEFAULT_USAGE_LEDGER_MAX_BYTES,
  MIN_USAGE_LEDGER_MAX_BYTES,
  normalizeUsageLedgerRetention,
  type UsageLedgerRetention,
} from "./ledger-retention";

export type UsageLedgerRetentionStatus = UsageLedgerRetention & {
  currentBytes: number;
  overLimit: boolean;
};

/** Read the opt-in policy from config. Unknown/malformed persisted keys fail closed. */
export function readUsageLedgerRetentionFromConfig(config?: OcxConfig): UsageLedgerRetention {
  const source = config ?? loadConfig();
  return normalizeUsageLedgerRetention(source.usageLedgerRetention);
}

/** Strict live-write parser. Destructive settings reject unknown keys instead of ignoring typos. */
export function parseUsageLedgerRetentionInput(
  raw: unknown,
  previous: UsageLedgerRetention = { enabled: false, maxBytes: DEFAULT_USAGE_LEDGER_MAX_BYTES },
): { ok: true; policy: UsageLedgerRetention } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const row = raw as Record<string, unknown>;
  const allowed = new Set(["enabled", "maxBytes"]);
  const unknownKey = Object.keys(row).find(key => !allowed.has(key));
  if (unknownKey) return { ok: false, error: `unknown field: ${unknownKey}` };

  if (row.enabled !== undefined && typeof row.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (row.maxBytes !== undefined) {
    if (
      typeof row.maxBytes !== "number"
      || !Number.isSafeInteger(row.maxBytes)
      || row.maxBytes < MIN_USAGE_LEDGER_MAX_BYTES
    ) {
      return {
        ok: false,
        error: `maxBytes must be a safe integer >= ${MIN_USAGE_LEDGER_MAX_BYTES}`,
      };
    }
  }

  return {
    ok: true,
    policy: {
      enabled: row.enabled === undefined ? previous.enabled : row.enabled,
      maxBytes: row.maxBytes === undefined ? previous.maxBytes : row.maxBytes,
    },
  };
}

/** Persist a complete normalized policy. The feature is never enabled implicitly. */
export function writeUsageLedgerRetentionToConfig(policy: UsageLedgerRetention): UsageLedgerRetention {
  const normalized = normalizeUsageLedgerRetention({
    enabled: policy.enabled,
    maxBytes: policy.maxBytes,
  });
  const config = loadConfig();
  config.usageLedgerRetention = {
    enabled: normalized.enabled,
    maxBytes: normalized.maxBytes,
  };
  saveConfigPreservingClaudeCode(config);
  return normalized;
}

/** Mirror a persisted policy into the live server config after a management PUT. */
export function applyUsageLedgerRetentionToLiveConfig(
  config: OcxConfig,
  policy: UsageLedgerRetention,
): void {
  config.usageLedgerRetention = {
    enabled: policy.enabled,
    maxBytes: policy.maxBytes,
  };
}

/** Bounded status projection for API/UI; missing ledger is reported as zero bytes. */
export function getUsageLedgerRetentionStatus(config?: OcxConfig): UsageLedgerRetentionStatus {
  const policy = readUsageLedgerRetentionFromConfig(config);
  let currentBytes = 0;
  try {
    currentBytes = statSync(usageLogPath()).size;
  } catch {
    currentBytes = 0;
  }
  return {
    ...policy,
    currentBytes,
    overLimit: policy.enabled && currentBytes > policy.maxBytes,
  };
}

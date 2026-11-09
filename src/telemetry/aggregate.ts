import type { OcxUsage } from "../types";
import { normalizeCostTokens } from "../usage/cost";
import { scanUsageLedgerCooperatively } from "../usage/ledger-scanner";
import { isKnownRequestFailureCause, type PersistedUsageEntry } from "../usage/log";
import { classifyRequestOutcome } from "../usage/request-outcome";
import { usageDisplayTotalTokens } from "../usage/totals";
import {
  TELEMETRY_MAX_MODELS,
  parseCalendarUtcDayMs,
  type TelemetryErrorsV1,
  type TelemetryFailureCause,
  type TelemetryModelFamily,
  type TelemetryModelRowV1,
  type TelemetryProviderKind,
  type TelemetryRequestsV1,
} from "./contract";

export interface DisjointTelemetryTokens {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface DailyTelemetryAggregate {
  day: string;
  activeMinutes: number;
  requests: TelemetryRequestsV1;
  models: TelemetryModelRowV1[];
  errors: TelemetryErrorsV1;
}

const ACCOUNT_SUFFIX_RE = /-(?:main|[po][0-9a-f]{6}|k[0-9a-f]{32})$/i;

const PRESET_TO_PROVIDER_KIND: Readonly<Record<string, TelemetryProviderKind>> = Object.freeze({
  openai: "openai",
  "openai-apikey": "openai",
  "azure-openai": "openai",
  chatgpt: "chatgpt",
  "openai-multi": "chatgpt",
  anthropic: "anthropic",
  "anthropic-apikey": "anthropic",
  "claude-subscription": "claude-subscription",
  "claude-cli": "claude-subscription",
  anthropic2: "claude-subscription",
  google: "google",
  "google-antigravity": "google",
  vertex: "vertex",
  "google-vertex": "vertex",
  xai: "xai",
  grok: "xai",
  deepseek: "deepseek",
  moonshot: "moonshot",
  kimi: "moonshot",
  "kimi-responses": "moonshot",
  "kimi-code": "moonshot",
  qwen: "qwen",
  "qwen-cloud": "qwen",
  alibaba: "qwen",
  "alibaba-token-plan": "qwen",
  "alibaba-token-plan-intl": "qwen",
  zai: "zai",
  "zhipu-bigmodel": "zai",
  "zhipu-bigmodel-coding": "zai",
  "zhipu-bigmodel-responses": "zai",
  minimax: "minimax",
  "minimax-cn": "minimax",
  mistral: "mistral",
  openrouter: "openrouter",
  groq: "groq",
  cerebras: "cerebras",
  together: "together",
  fireworks: "fireworks",
  firepass: "fireworks",
  cursor: "cursor",
  kiro: "kiro",
  copilot: "copilot",
  "github-copilot": "copilot",
  devin: "devin",
  ollama: "ollama",
  "ollama-cloud": "ollama",
  lmstudio: "lmstudio",
  "lm-studio": "lmstudio",
  "local-other": "local-other",
  vllm: "local-other",
  litellm: "local-other",
});

/**
 * Map a logged provider identifier to the closed vendor-level `TelemetryProviderKind` roster.
 * Custom/unknown provider keys never enter the payload; they map to `"other"`.
 */
export function classifyProviderKind(provider: string): TelemetryProviderKind {
  const trimmed = provider.trim().toLowerCase();
  if (!trimmed) return "other";
  const direct = PRESET_TO_PROVIDER_KIND[trimmed];
  if (direct) return direct;
  const stripped = trimmed.replace(ACCOUNT_SUFFIX_RE, "");
  return PRESET_TO_PROVIDER_KIND[stripped] ?? "other";
}

/**
 * Map a model identifier to the closed `TelemetryModelFamily` prefix roster.
 */
export function classifyModelFamily(model: string): TelemetryModelFamily {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return "other";
  const slash = trimmed.lastIndexOf("/");
  const tail = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).replace(/--[a-z0-9_-]+$/, "");
  if (!tail) return "other";
  if (tail.startsWith("gpt-6")) return "gpt-6";
  if (tail.startsWith("gpt-5")) return "gpt-5";
  if (tail.startsWith("gpt-4")) return "gpt-4";
  if (tail === "o-series" || /^o[134](?:$|[-._])/.test(tail)) return "o-series";
  if (tail.startsWith("codex")) return "codex";
  if (/^claude-(?:[\d.-]+-)?opus(?:$|[-._])/.test(tail) || tail === "claude-opus") return "claude-opus";
  if (/^claude-(?:[\d.-]+-)?sonnet(?:$|[-._])/.test(tail) || tail === "claude-sonnet") return "claude-sonnet";
  if (/^claude-(?:[\d.-]+-)?haiku(?:$|[-._])/.test(tail) || tail === "claude-haiku") return "claude-haiku";
  if (tail.startsWith("gemini-3")) return "gemini-3";
  if (tail.startsWith("gemini-2")) return "gemini-2";
  if (tail.startsWith("grok")) return "grok";
  if (tail.startsWith("deepseek")) return "deepseek";
  if (tail.startsWith("qwen") || tail.startsWith("qwq")) return "qwen";
  if (tail.startsWith("kimi") || tail.startsWith("moonshot")) return "kimi";
  if (tail.startsWith("glm") || tail.startsWith("chatglm")) return "glm";
  if (tail.startsWith("minimax") || tail.startsWith("abab")) return "minimax";
  if (
    tail.startsWith("mistral")
    || tail.startsWith("mixtral")
    || tail.startsWith("codestral")
    || tail.startsWith("pixtral")
    || tail.startsWith("ministral")
  ) {
    return "mistral";
  }
  if (tail.startsWith("llama") || tail.startsWith("meta-llama")) return "llama";
  return "other";
}

function nonNegInt(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Decompose `OcxUsage` into five disjoint token buckets whose sum equals `usageDisplayTotalTokens(usage)`:
 * - `inputTokens`: uncached input (`normalizeCostTokens`)
 * - `cacheReadTokens`
 * - `cacheWriteTokens`
 * - `outputTokens`: output minus reasoning
 * - `reasoningTokens`
 */
export function disjointTelemetryTokens(usage: OcxUsage | undefined): DisjointTelemetryTokens {
  if (!usage) {
    return {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
  }
  const normalized = normalizeCostTokens(usage);
  let inputTokens: number;
  let cacheReadTokens: number;
  let cacheWriteTokens: number;
  let totalOutput: number;
  if (normalized) {
    inputTokens = nonNegInt(normalized.input);
    cacheReadTokens = nonNegInt(normalized.cacheRead);
    cacheWriteTokens = nonNegInt(normalized.cacheWrite);
    totalOutput = nonNegInt(normalized.output);
  } else {
    const rawInput = nonNegInt(usage.inputTokens);
    cacheWriteTokens = Math.min(rawInput, nonNegInt(usage.cacheCreationInputTokens));
    cacheReadTokens = Math.min(
      rawInput - cacheWriteTokens,
      nonNegInt(usage.cacheReadInputTokens ?? usage.cachedInputTokens),
    );
    inputTokens = Math.max(0, rawInput - cacheReadTokens - cacheWriteTokens);
    totalOutput = nonNegInt(usage.outputTokens);
  }
  const reasoningTokens = Math.min(totalOutput, nonNegInt(usage.reasoningOutputTokens));
  const outputTokens = Math.max(0, totalOutput - reasoningTokens);
  const displayTotal = nonNegInt(usageDisplayTotalTokens(usage));
  const accounted = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens + reasoningTokens;
  if (displayTotal > accounted) {
    inputTokens += displayTotal - accounted;
  }
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
  };
}

export interface DailyTelemetryAccumulator {
  onEntry: (entry: PersistedUsageEntry) => void;
  finalize: () => DailyTelemetryAggregate;
}

/**
 * Streaming accumulator for one completed UTC day.
 *
 * Accumulates counters directly inside `onEntry` for entries falling inside `day`
 * and never retains `PersistedUsageEntry` rows in memory.
 */
export function createDailyTelemetryAccumulator(day: string): DailyTelemetryAccumulator {
  const dayStartMs = parseCalendarUtcDayMs(day);
  if (dayStartMs === null) {
    throw new Error(`Invalid UTC day: ${day}`);
  }
  const dayEndMs = dayStartMs + 86_400_000;
  const minutes = new Set<number>();
  const requests: TelemetryRequestsV1 = {
    completed: 0,
    failed: 0,
    incomplete: 0,
    aborted: 0,
  };
  const modelMap = new Map<string, TelemetryModelRowV1>();
  const errors: TelemetryErrorsV1 = {};

  const addModelAttribution = (provider: string, model: string, usage: OcxUsage | undefined) => {
    const providerKind = classifyProviderKind(provider);
    const modelFamily = classifyModelFamily(model);
    const key = `${providerKind}\0${modelFamily}`;
    let row = modelMap.get(key);
    if (!row) {
      row = {
        providerKind,
        modelFamily,
        requests: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      };
      modelMap.set(key, row);
    }
    row.requests += 1;
    const tokens = disjointTelemetryTokens(usage);
    row.inputTokens += tokens.inputTokens;
    row.cacheReadTokens += tokens.cacheReadTokens;
    row.cacheWriteTokens += tokens.cacheWriteTokens;
    row.outputTokens += tokens.outputTokens;
    row.reasoningTokens += tokens.reasoningTokens;
  };

  const onEntry = (entry: PersistedUsageEntry): void => {
    if (typeof entry.timestamp !== "number" || entry.timestamp < dayStartMs || entry.timestamp >= dayEndMs) {
      return;
    }
    minutes.add(Math.floor(entry.timestamp / 60_000));
    const outcome = classifyRequestOutcome(entry);
    requests[outcome] += 1;

    const cause = entry.failureCause ?? entry.attempts?.at(-1)?.failureCause;
    if (cause && isKnownRequestFailureCause(cause)) {
      errors[cause as TelemetryFailureCause] = (errors[cause as TelemetryFailureCause] ?? 0) + 1;
    }

    if (entry.provider === "combo" && entry.attempts && entry.attempts.length > 0) {
      for (const attempt of entry.attempts) {
        addModelAttribution(attempt.provider, attempt.model, attempt.usage);
      }
    } else {
      addModelAttribution(entry.provider, entry.model, entry.usage);
    }
  };

  const finalize = (): DailyTelemetryAggregate => {
    let models = [...modelMap.values()].sort((a, b) => {
      if (b.requests !== a.requests) return b.requests - a.requests;
      const aTokens = a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens + a.outputTokens + a.reasoningTokens;
      const bTokens = b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens + b.outputTokens + b.reasoningTokens;
      if (bTokens !== aTokens) return bTokens - aTokens;
      if (a.providerKind !== b.providerKind) return a.providerKind.localeCompare(b.providerKind);
      return a.modelFamily.localeCompare(b.modelFamily);
    });

    if (models.length > TELEMETRY_MAX_MODELS) {
      const kept = models.slice(0, TELEMETRY_MAX_MODELS - 1);
      const overflow = models.slice(TELEMETRY_MAX_MODELS - 1);
      let otherRow = kept.find(r => r.providerKind === "other" && r.modelFamily === "other");
      if (!otherRow) {
        otherRow = {
          providerKind: "other",
          modelFamily: "other",
          requests: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        };
        kept.push(otherRow);
      }
      for (const row of overflow) {
        otherRow.requests += row.requests;
        otherRow.inputTokens += row.inputTokens;
        otherRow.cacheReadTokens += row.cacheReadTokens;
        otherRow.cacheWriteTokens += row.cacheWriteTokens;
        otherRow.outputTokens += row.outputTokens;
        otherRow.reasoningTokens += row.reasoningTokens;
      }
      models = kept;
    }

    return {
      day,
      activeMinutes: Math.min(1440, minutes.size),
      requests: { ...requests },
      models,
      errors: { ...errors },
    };
  };

  return { onEntry, finalize };
}

export function aggregateTelemetryEntriesForDay(
  day: string,
  entries: Iterable<PersistedUsageEntry>,
): DailyTelemetryAggregate {
  const accumulator = createDailyTelemetryAccumulator(day);
  for (const entry of entries) {
    accumulator.onEntry(entry);
  }
  return accumulator.finalize();
}

export async function aggregateTelemetryForDay(
  day: string,
  options: { signal?: AbortSignal } = {},
): Promise<DailyTelemetryAggregate> {
  const accumulator = createDailyTelemetryAccumulator(day);
  await scanUsageLedgerCooperatively({
    signal: options.signal,
    onEntry: accumulator.onEntry,
  });
  return accumulator.finalize();
}

// Command Code config export.
import { existsSync } from "node:fs";
import type { ExportContext, ManagedContribution } from "./contracts";
import { normalizeExportModels, authoritativeContextWindow, singleFragment } from "./model-metadata";
import { OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";
import { serviceApiTokenFilePath } from "../../lib/service-secrets";
import { sanitizeCodexReasoningEfforts } from "../../reasoning-effort";

export interface CommandCodeModelEntry {
  reasoningEfforts?: string[];
  contextWindow?: number;
}

export interface CommandCodeProviderBlock {
  name: "OpenCodex";
  api: "openai-completions";
  baseURL: string;
  apiKey: string;
  models: Record<string, CommandCodeModelEntry>;
}

export interface CommandCodeGeneratedConfig {
  provider: Record<string, CommandCodeProviderBlock>;
}

/**
 * Spelling-independent identity of a routed selector.
 *
 * One provider model reaches this exporter under interchangeable spellings: the raw
 * selector keeps inner slashes (`command-code/deepseek/deepseek-v4.1-flash`, what
 * `/v1/models` publishes) while the Codex-facing form encodes them as dashes
 * (`command-code/deepseek-deepseek-v4.1-flash`, what `~/.codex/config.toml` stores and
 * what an operator typing `--model` copies). Command Code addresses models by exact key,
 * so a catalog that carries both spellings can resolve the active model against one and
 * miss it in the other.
 *
 * The slash is meaningful, not decoration: it separates the provider from the model id,
 * and a provider id never contains one. Splitting on the FIRST slash and normalizing the
 * remainder is therefore exact, and it is the same lossy-but-consistent relation the rest
 * of the codebase already uses for this pair (see `slugEquivalenceKey` in
 * src/providers/slug-codec.ts, which collapses `p/a/b` and `p/a-b` onto one key).
 * Keeping a single implementation of that rule here avoids inventing a second, divergent
 * notion of "same model".
 */
function canonicalSpellingOf(namespaced: string): string {
  const slash = namespaced.indexOf("/");
  if (slash <= 0) return namespaced;
  return namespaced.slice(0, slash) + "/" + namespaced.slice(slash + 1).replaceAll("/", "-");
}

export function buildCommandCodeClientConfig(ctx: ExportContext): CommandCodeGeneratedConfig {
  const models: Record<string, CommandCodeModelEntry> = {};
  // Fold interchangeable spellings of one model onto a single key. The first
  // occurrence wins; normalizeExportModels has already sorted, so the surviving key
  // is deterministic across runs.
  const emittedKeys = new Set<string>();
  for (const model of normalizeExportModels(ctx.models)) {
    const emittedKey = model.namespaced;
    const collisionKey = canonicalSpellingOf(model.namespaced);
    if (emittedKeys.has(collisionKey)) continue;
    emittedKeys.add(collisionKey);
    const entry: CommandCodeModelEntry = {};
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.contextWindow = context;
    }
    const efforts = sanitizeCodexReasoningEfforts(model.reasoningEfforts)
      ?.filter(effort => ["low", "medium", "high", "xhigh", "max"].includes(effort));
    if (efforts && efforts.length > 0) {
      entry.reasoningEfforts = efforts;
    }
    models[emittedKey] = entry;
  }
  const tokenPath = serviceApiTokenFilePath();
  const apiKey = existsSync(tokenPath) ? `!cat ${tokenPath}` : LOOPBACK_API_KEY_PLACEHOLDER;
  return {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        name: "OpenCodex",
        api: "openai-completions",
        baseURL: ctx.baseUrl.replace(/\/v1\/?$/, "") + "/v1",
        apiKey,
        models,
      },
    },
  };
}

export function summarizeCommandCode(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = Object.values((document as CommandCodeGeneratedConfig | undefined)?.provider?.[OPENCODE_PROVIDER_ID]?.models ?? {});
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

export function buildCommandCodeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildCommandCodeClientConfig(ctx);
  return singleFragment("commandcode", ["provider", OPENCODE_PROVIDER_ID], doc.provider[OPENCODE_PROVIDER_ID]);
}

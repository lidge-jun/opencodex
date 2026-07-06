/**
 * `ocx models` subcommand — list available models from configured providers.
 *
 * Usage:
 *   ocx models [--provider <name>] [--json]
 */
import { hasOwnProvider, loadConfig } from "../config";
import type { OcxConfig } from "../types";

interface ModelEntry {
  provider: string;
  model: string;
  isDefault: boolean;
  contextWindow: number | null;
  inputModalities: string[] | null;
  reasoningEfforts: string[] | null;
}

function collectModels(config: OcxConfig, providerFilter?: string): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const providers = providerFilter
    ? { [providerFilter]: config.providers[providerFilter] }
    : config.providers;

  for (const [provName, prov] of Object.entries(providers)) {
    if (!prov) continue;
    const seen = new Set<string>();
    const contextWindows = prov.modelContextWindows ?? {};
    const inputModalities = prov.modelInputModalities ?? {};
    const reasoningEfforts = prov.modelReasoningEfforts ?? {};
    const globalContext = prov.contextWindow ?? null;

    const addModel = (model: string, isDefault: boolean) => {
      if (seen.has(model)) return;
      seen.add(model);

      const noVision = prov.noVisionModels?.includes(model);
      const modalities = inputModalities[model] ?? (noVision ? ["text"] : null);
      const efforts = reasoningEfforts[model] ?? prov.reasoningEfforts ?? null;

      entries.push({
        provider: provName,
        model,
        isDefault,
        contextWindow: contextWindows[model] ?? globalContext,
        inputModalities: modalities,
        reasoningEfforts: efforts,
      });
    };

    // defaultModel first
    if (prov.defaultModel) addModel(prov.defaultModel, true);

    // models array
    if (prov.models) {
      for (const m of prov.models) addModel(m, m === prov.defaultModel);
    }
  }

  return entries;
}

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function consumeFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

export function handleModels(args: string[]): void {
  const restArgs = [...args];
  const wantsJson = consumeFlag(restArgs, "--json");
  const providerFilter = consumeFlagValue(restArgs, "--provider");

  if (restArgs.length > 0) {
    const unknown = restArgs.filter(a => a.startsWith("-"));
    if (unknown.length > 0) {
      console.error(`Unknown flag(s): ${unknown.join(", ")}`);
    } else {
      console.error(`Unexpected argument(s): ${restArgs.join(", ")}`);
    }
    console.error("Usage: ocx models [--provider <name>] [--json]");
    process.exit(1);
  }

  const config = loadConfig();

  if (providerFilter && !hasOwnProvider(config.providers, providerFilter)) {
    console.error(`Provider "${providerFilter}" is not configured. See: ocx provider list`);
    process.exit(1);
  }

  const models = collectModels(config, providerFilter ?? undefined);

  if (wantsJson) {
    console.log(JSON.stringify({
      models,
      note: "Static config models only. Providers with liveModels=true may have additional models at runtime.",
    }, null, 2));
    return;
  }

  if (models.length === 0) {
    console.log("No models found in configured providers.");
    if (!providerFilter) console.log("Providers may discover models dynamically at runtime (liveModels).");
    return;
  }

  // Group by provider
  const byProvider = new Map<string, ModelEntry[]>();
  for (const entry of models) {
    const list = byProvider.get(entry.provider) ?? [];
    list.push(entry);
    byProvider.set(entry.provider, list);
  }

  for (const [provName, provModels] of byProvider) {
    const isDefaultProv = provName === config.defaultProvider ? " (default provider)" : "";
    console.log(`${provName}${isDefaultProv}:`);
    for (const m of provModels) {
      const marker = m.isDefault ? " *" : "";
      const ctx = m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k)` : "";
      console.log(`  ${m.model}${marker}${ctx}`);
    }
    console.log();
  }

  console.log("* = default model for provider");
  console.log("Note: providers with liveModels may have additional models at runtime.");
}

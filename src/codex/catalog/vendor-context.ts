import { listModelMetadata, resolveMetadataProvider, type ModelMetadata } from "../../generated/model-metadata";
import { PROVIDER_REGISTRY } from "../../providers/registry";
import type { OcxProviderConfig } from "../../types";

/** A bundled model-window estimate, not evidence of the serving gateway's capacity. */
export interface VendorContextInference {
  source: "vendor" | "aggregator";
  provider: string;
  modelId: string;
  contextWindow: number;
}

// Capacity and price have different authorities: hosting vendors (Cerebras/Bedrock), Azure
// and the Codex subscription table must not replace the original vendor's API window.
const VENDORS = ["anthropic", "openai", "google", "moonshot", "minimax", "deepseek", "xai", "zai", "mistral", "xiaomi"];
const AGGREGATORS = ["openrouter", "opencode-go"];
// Snapshot names once, never consult the mutable registry after gather flight admission.
const BUILTIN_NAMES = new Set(PROVIDER_REGISTRY.map(entry => entry.id.toLowerCase()));
/**
 * Opt-in only (#1073): an id-only custom row keeps the conservative fallback unless the
 * operator sets `inferContextWindow: true`. Built-in names stay excluded even when set.
 */
export function canInferVendorContext(provider: string, config: Pick<OcxProviderConfig, "inferContextWindow"> | undefined): boolean {
  return config?.inferContextWindow === true
    && !BUILTIN_NAMES.has(provider.toLowerCase()) && !resolveMetadataProvider(provider);
}

const normalize = (id: string): string => id.toLowerCase().replaceAll(".", "-");
type Candidate = VendorContextInference | null;

/** Build a pure lookup; conflicting windows within one authority tier fail closed. */
export function createVendorContextLookup(
  vendors: readonly ModelMetadata[],
  aggregators: readonly ModelMetadata[],
): (id: string) => VendorContextInference | undefined {
  const build = (rows: readonly ModelMetadata[], source: VendorContextInference["source"]) => {
    const exact = new Map<string, Candidate>();
    const normalized = new Map<string, Candidate>();
    const add = (map: Map<string, Candidate>, id: string, value: VendorContextInference) => {
      if (!map.has(id)) map.set(id, value);
      else if (map.get(id)?.contextWindow !== value.contextWindow) map.set(id, null);
    };
    for (const row of rows) {
      const window = row.contextWindow;
      if (!Number.isSafeInteger(window) || window! <= 0 || row.id.startsWith("~")) continue;
      const value: VendorContextInference = { source, provider: row.provider, modelId: row.id, contextWindow: window! };
      const ids = source === "aggregator" ? [row.id, row.id.slice(row.id.lastIndexOf("/") + 1)] : [row.id];
      for (const id of ids) {
        if (!id) continue;
        add(exact, id, value);
        add(normalized, normalize(id), value);
      }
    }
    return { exact, normalized };
  };
  const tiers = [build(vendors, "vendor"), build(aggregators, "aggregator")];
  return rawId => {
    const id = rawId.trim();
    if (!id || id.startsWith("~")) return undefined;
    for (const tier of tiers) {
      // An exact spelling wins over its normalized alias. A conflicting key does not
      // fall through to a lower-authority source and accidentally regain a larger window.
      const map = tier.exact.has(id) ? tier.exact : tier.normalized;
      const key = map === tier.exact ? id : normalize(id);
      if (map.has(key)) {
        const value = map.get(key);
        return value ? { ...value } : undefined;
      }
    }
    return undefined;
  };
}

let lookup: ReturnType<typeof createVendorContextLookup> | undefined;
export function vendorContextInference(modelId: string): VendorContextInference | undefined {
  lookup ??= createVendorContextLookup(VENDORS.flatMap(listModelMetadata), AGGREGATORS.flatMap(listModelMetadata));
  return lookup(modelId);
}

export function vendorContextWindow(modelId: string): number | undefined {
  return vendorContextInference(modelId)?.contextWindow;
}

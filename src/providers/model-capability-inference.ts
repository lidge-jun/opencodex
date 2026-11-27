import { listModelMetadata, resolveMetadataProvider, type ModelMetadata } from "../generated/model-metadata";
import { modelRecordValue } from "../reasoning-effort";
import type { OcxConfig } from "../types";
import { PROVIDER_REGISTRY } from "./registry";

/**
 * Where an inferred capability came from. `registry` is a built-in original-vendor provider entry,
 * `vendor` / `aggregator` are bundled model metadata, `provider` is another configured provider's
 * explicit declaration for the same model id.
 */
export interface CapabilityInferenceBasis {
  source: "registry" | "vendor" | "provider" | "aggregator";
  provider: string;
  modelId: string;
}

export interface InferredCapability<T> {
  value: T;
  basis: CapabilityInferenceBasis;
}

export interface InferredModelCapabilities {
  contextWindow?: InferredCapability<number>;
  inputModalities?: InferredCapability<string[]>;
  reasoningEfforts?: InferredCapability<string[]>;
}

type Axis = keyof InferredModelCapabilities;
type AxisValue = number | string[];
interface Candidate { value: AxisValue; basis: CapabilityInferenceBasis }
type Tier = Map<string, Candidate | null>;

// Original vendors only: a hosting vendor or reseller entry is not evidence of the model's own
// capability. Mirrors the vendor list of `src/codex/catalog/vendor-context.ts`.
const VENDORS = new Set(["anthropic", "openai", "google", "moonshot", "minimax", "deepseek", "xai", "zai", "mistral", "xiaomi"]);
const AGGREGATORS = ["openrouter", "opencode-go"];
const MULTI_VENDOR_HOSTS = new Set(["google-vertex", "google-antigravity"]);

/** Same-model key: case, a `vendor/` prefix, dot-vs-hyphen spelling and a `[...]` suffix are ignored. */
export function capabilityInferenceKey(modelId: string): string {
  const bare = modelId.trim().replace(/\[[^\]]*\]$/, "");
  return bare.slice(bare.lastIndexOf("/") + 1).toLowerCase().replaceAll(".", "-");
}

const sameValue = (a: AxisValue, b: AxisValue): boolean => JSON.stringify(a) === JSON.stringify(b);

function addCandidate(tier: Tier, modelId: string, value: AxisValue | undefined, basis: Omit<CapabilityInferenceBasis, "modelId">): void {
  if (value === undefined || (Array.isArray(value) ? value.length === 0 : !(Number.isSafeInteger(value) && value > 0))) return;
  const key = capabilityInferenceKey(modelId);
  if (!key) return;
  const existing = tier.get(key);
  // Two sources in one tier that disagree answer nothing, and the lookup does not fall through to a
  // lower tier either: a weaker source must not win just because a stronger one is ambiguous.
  if (existing === undefined) tier.set(key, { value: Array.isArray(value) ? [...value] : value, basis: { ...basis, modelId } });
  else if (existing !== null && !sameValue(existing.value, value)) tier.set(key, null);
}

function metadataTier(rows: readonly ModelMetadata[], source: "vendor" | "aggregator", axis: Axis): Tier {
  const tier: Tier = new Map();
  for (const row of rows) {
    if (row.id.startsWith("~")) continue;
    const value = axis === "contextWindow" ? row.contextWindow : axis === "inputModalities" ? row.input : undefined;
    addCandidate(tier, row.id, value, { source, provider: row.provider });
  }
  return tier;
}

function registryTier(axis: Axis): Tier {
  const tier: Tier = new Map();
  for (const entry of PROVIDER_REGISTRY) {
    if (!VENDORS.has(entry.id) && !VENDORS.has(resolveMetadataProvider(entry.id) ?? "")) continue;
    // Multi-vendor hosts reachable through a vendor alias (Vertex, Antigravity) carry their own
    // ladders and windows for other vendors' models; they are hosts, not the model's vendor.
    if (MULTI_VENDOR_HOSTS.has(entry.id)) continue;
    const record = axis === "contextWindow" ? entry.modelContextWindows
      : axis === "inputModalities" ? entry.modelInputModalities : entry.modelReasoningEfforts;
    for (const [modelId, value] of Object.entries(record ?? {})) {
      addCandidate(tier, modelId, value as AxisValue, { source: "registry", provider: entry.id });
    }
  }
  return tier;
}

function configuredTier(config: OcxConfig | undefined, exclude: string | undefined, axis: Axis): Tier {
  const tier: Tier = new Map();
  for (const [name, provider] of Object.entries(config?.providers ?? {})) {
    if (name === exclude || provider.disabled === true) continue;
    const ids = new Set([
      ...Object.keys(provider.modelContextWindows ?? {}),
      ...Object.keys(provider.modelCapabilities ?? {}),
      ...Object.keys(provider.modelReasoningEfforts ?? {}),
    ]);
    for (const modelId of ids) {
      const value = axis === "contextWindow" ? modelRecordValue(provider.modelContextWindows, modelId)
        : axis === "inputModalities" ? provider.modelCapabilities?.[modelId]?.inputModalities
          : modelRecordValue(provider.modelReasoningEfforts, modelId);
      addCandidate(tier, modelId, value as AxisValue | undefined, { source: "provider", provider: name });
    }
  }
  return tier;
}

// Bundled tiers never change at runtime; build them once per axis.
const staticTiers = new Map<Axis, { registry: Tier; vendor: Tier; aggregator: Tier }>();
function staticTiersFor(axis: Axis) {
  let tiers = staticTiers.get(axis);
  if (!tiers) {
    tiers = {
      registry: registryTier(axis),
      vendor: metadataTier([...VENDORS].flatMap(listModelMetadata), "vendor", axis),
      aggregator: metadataTier(AGGREGATORS.flatMap(listModelMetadata), "aggregator", axis),
    };
    staticTiers.set(axis, tiers);
  }
  return tiers;
}

/**
 * Builds a same-name capability lookup for one configuration. Authority order per axis: built-in
 * original-vendor registry, bundled vendor metadata, other configured providers' explicit
 * declarations, bundled aggregator metadata. These are estimates of the model, not measurements of
 * the gateway serving it; callers label them `inferred` and never let them outrank a declaration
 * or a provider report.
 */
export function createModelCapabilityInference(config?: OcxConfig): (modelId: string, excludeProvider?: string) => InferredModelCapabilities {
  const configured = new Map<string, Map<Axis, Tier>>();
  const configuredFor = (exclude: string | undefined, axis: Axis): Tier => {
    const key = exclude ?? "";
    let byAxis = configured.get(key);
    if (!byAxis) configured.set(key, byAxis = new Map());
    let tier = byAxis.get(axis);
    if (!tier) byAxis.set(axis, tier = configuredTier(config, exclude, axis));
    return tier;
  };
  return (modelId, excludeProvider) => {
    const key = capabilityInferenceKey(modelId);
    const result: InferredModelCapabilities = {};
    if (!key) return result;
    for (const axis of ["contextWindow", "inputModalities", "reasoningEfforts"] as const) {
      const tiers = staticTiersFor(axis);
      for (const tier of [tiers.registry, tiers.vendor, configuredFor(excludeProvider, axis), tiers.aggregator]) {
        if (!tier.has(key)) continue;
        const found = tier.get(key);
        if (found) (result as Record<Axis, Candidate>)[axis] = { value: Array.isArray(found.value) ? [...found.value] : found.value, basis: { ...found.basis } };
        break;
      }
    }
    return result;
  };
}

export function resetModelCapabilityInferenceForTests(): void {
  staticTiers.clear();
}

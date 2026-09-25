/**
 * The `provider` block of `GET /api/protocols?provider=<name>`: which upstream wire one
 * provider receives and who decided it.
 *
 * SERVER SIDE (not a leaf): it reads the provider registry through
 * `captureRouteStaticPolicy`, the same resolver every ingress uses, so the answer is the
 * resolved static policy and never a second copy of the adapter rules. It is free of side
 * effects: no fetch, no model-cache refresh, no config write. Only the adapter id, its
 * provenance, the auth mode and model ids leave this module; no credential, base URL or header.
 *
 * Model overrides are resolved for a Responses client, the Codex default. A registry wire
 * default declared for another client API only shows up in that API's plan preview.
 */
import { PROVIDER_REGISTRY } from "../providers/registry";
import type { StaticPolicySource } from "../providers/resolved-model-policy";
import { captureRouteStaticPolicy } from "../router";
import { captureWireAdapterHardPins, type OcxConfig, type OcxProviderConfig } from "../types";
import { upstreamWireForAdapter } from "./contract";
import {
  PROTOCOL_DTO_LIMITS,
  PROTOCOL_PROVIDER_OVERRIDE_LIMIT,
  type ProtocolAdapterSource,
  type ProtocolProviderModelOverrideV1,
  type ProtocolProviderSummaryV1,
} from "./dto";

/** Upper bound on the model ids examined, so a provider with a huge static list stays cheap. */
const MODEL_SCAN_LIMIT = 1024;

/** Collapse the resolver's provenance vocabulary onto the four public decision sources. */
export function protocolAdapterSource(source: StaticPolicySource | undefined): ProtocolAdapterSource {
  switch (source) {
    case "hard-pin":
      return "hard-pin";
    case "operator":
    case "operator-capability":
      return "operator";
    case "registry":
      return "registry";
    default:
      return "provider-default";
  }
}

function usableModelId(model: unknown): model is string {
  return typeof model === "string" && model.length > 0 && model.length <= PROTOCOL_DTO_LIMITS.identifierLength
    && !/[\u0000-\u001f\u007f]/.test(model);
}

/**
 * Model ids whose wire could differ from the provider's: explicit overrides, registry wire
 * defaults, exact-id hard pins and the listed models. Prefix pins cannot be enumerated; a
 * listed model they match is still found.
 */
function candidateModelIds(name: string, provider: Readonly<OcxProviderConfig>): string[] {
  const registry = PROVIDER_REGISTRY.find(entry => entry.id === name);
  const ids = new Set<string>();
  const add = (model: unknown) => {
    if (ids.size < MODEL_SCAN_LIMIT && usableModelId(model)) ids.add(model);
  };
  for (const model of Object.keys(provider.modelAdapters ?? {})) add(model);
  for (const model of Object.keys(registry?.modelWireDefaults ?? {})) add(model);
  for (const model of Object.keys(captureWireAdapterHardPins(name))) add(model);
  add(provider.defaultModel);
  for (const model of provider.models ?? []) add(model);
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/**
 * Summarize one configured provider, or `undefined` when no provider has that name. The
 * provider-level adapter is resolved without a model; each override is resolved for its model.
 */
export function buildProtocolProviderSummary(config: Readonly<OcxConfig>, name: string): ProtocolProviderSummaryV1 | undefined {
  if (!Object.hasOwn(config.providers ?? {}, name)) return undefined;
  const provider = config.providers[name];
  if (!provider) return undefined;
  const base = captureRouteStaticPolicy(name, "", provider);
  const adapter = base.provider.adapter;
  const overrides: ProtocolProviderModelOverrideV1[] = [];
  let truncated = false;
  for (const model of candidateModelIds(name, provider)) {
    const policy = captureRouteStaticPolicy(name, model, provider);
    const source = protocolAdapterSource(policy.provenance.model.adapter);
    if (source === "provider-default" && policy.model.adapter === adapter) continue;
    if (overrides.length >= PROTOCOL_PROVIDER_OVERRIDE_LIMIT) {
      truncated = true;
      break;
    }
    overrides.push({ model, adapter: policy.model.adapter, source });
  }
  const authMode = base.provider.authMode;
  return {
    name,
    adapter,
    adapterSource: protocolAdapterSource(base.provenance.provider.adapter),
    authMode: typeof authMode === "string" && authMode.length > 0 ? authMode : null,
    upstream: upstreamWireForAdapter(adapter),
    modelOverrides: overrides,
    ...(truncated ? { modelOverridesTruncated: true as const } : {}),
  };
}

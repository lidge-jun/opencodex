import { knownModelIdsForProvider, previewRouteModel } from "../../router";
import { effectiveModelAliases } from "../../providers/default-aliases";
import type { ExportModel } from "../../clients/config-export/contracts";
import type { QualifiedAliasResolver } from "../../clients/config-export/model-id-mode";
import type { OcxConfig } from "../../types";

export function qualifiedAliasResolver(config: OcxConfig): QualifiedAliasResolver {
  const cache = new Map<string, Map<string, string>>();
  const aliasesOf = (providerName: string): Map<string, string> => {
    const cached = cache.get(providerName);
    if (cached) return cached;
    const provider = config.providers[providerName];
    const aliases = new Map<string, string>();
    if (provider) {
      const known = knownModelIdsForProvider(providerName, provider, config);
      for (const [id, { alias }] of effectiveModelAliases(config, provider, known)) aliases.set(id, alias);
    }
    cache.set(providerName, aliases);
    return aliases;
  };
  return (model: ExportModel) => {
    const provider = config.providers[model.provider];
    if (!provider || model.native) return undefined;
    const alias = aliasesOf(model.provider).get(model.id);
    if (alias === undefined) return undefined;
    const qualified = `${provider.alias || model.provider}/${alias}`;
    try {
      const route = previewRouteModel(config, qualified);
      return route.providerName === model.provider && route.modelId === model.id
        && route.routeReason === "explicit-provider-namespace" && route.routeKind === "explicit-provider"
        ? qualified : undefined;
    } catch {
      return undefined;
    }
  };
}

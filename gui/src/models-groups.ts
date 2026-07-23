/** Pure grouping for the Models page, including configured providers with zero model rows. */
import type { TKey } from "./i18n/shared";

/** Mirrors the management-API discovery DTO from `publicModelsDiscoveryStatus`. */
export interface ProviderDiscoverySummary {
  ok: boolean;
  kind: string;
  at?: number;
  httpStatus?: number;
  fallback?: string;
  detail?: string;
}

export interface ConfiguredProviderSummary {
  name: string;
  authMode?: string;
  disabled?: boolean;
  liveModels?: boolean;
  models?: string[];
  discovery?: ProviderDiscoverySummary | null;
}

export interface ProviderModelGroup<Row> {
  provider: string;
  rows: Row[];
  native: boolean;
  liveModels: boolean;
  configuredModels: string[];
  discovery: ProviderDiscoverySummary | null;
}

export function buildProviderModelGroups<Row extends { provider: string; native?: boolean }>(
  rows: Row[],
  providers: ConfiguredProviderSummary[],
): ProviderModelGroup<Row>[] {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.provider);
    if (bucket) bucket.push(row);
    else grouped.set(row.provider, [row]);
  }

  const providerByName = new Map(providers.map(provider => [provider.name, provider]));
  for (const provider of providers) {
    if (provider.disabled === true) {
      grouped.delete(provider.name);
      continue;
    }
    if (provider.authMode === "forward") continue;
    if (!grouped.has(provider.name)) grouped.set(provider.name, []);
  }

  return [...grouped.entries()]
    .map(([provider, providerRows]) => {
      const configured = providerByName.get(provider);
      return {
        provider,
        rows: providerRows,
        native: providerRows.length > 0 && providerRows.every(row => row.native === true),
        liveModels: configured?.liveModels !== false,
        configuredModels: configured?.models ?? [],
        discovery: configured?.discovery ?? null,
      };
    })
    .sort((a, b) => {
      if (a.native !== b.native) return a.native ? -1 : 1;
      return a.provider.localeCompare(b.provider);
    });
}

/** Short Models-page badge label for a failed discovery outcome. */
export function discoveryFailureBadgeLabel(
  discovery: ProviderDiscoverySummary | null | undefined,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
): string | null {
  if (!discovery || discovery.ok) return null;
  if (discovery.kind === "http" && typeof discovery.httpStatus === "number") {
    return t("models.discoveryFailedHttp", { status: discovery.httpStatus });
  }
  if (discovery.kind === "network") return t("models.discoveryFailedNetwork");
  if (discovery.kind === "policy") return t("models.discoveryFailedPolicy");
  if (discovery.kind === "malformed") return t("models.discoveryFailedMalformed");
  return t("models.discoveryFailed");
}

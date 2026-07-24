/** Pure grouping for the Models page, including configured providers with zero model rows. */
export type ProviderDiscoverySummary =
  | { status: "ok" }
  | { status: "failed"; reason: "http"; httpStatus: number }
  | {
      status: "failed";
      reason: "blocked" | "invalid_response" | "network" | "provider";
      httpStatus?: never;
    };

export interface ConfiguredProviderSummary {
  name: string;
  authMode?: string;
  disabled?: boolean;
  liveModels?: boolean;
  models?: string[];
  discovery?: ProviderDiscoverySummary;
}

export interface ProviderModelGroup<Row> {
  provider: string;
  rows: Row[];
  native: boolean;
  liveModels: boolean;
  configuredModels: string[];
  discovery?: ProviderDiscoverySummary;
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
        discovery: configured?.discovery,
      };
    })
    .sort((a, b) => {
      if (a.native !== b.native) return a.native ? -1 : 1;
      return a.provider.localeCompare(b.provider);
    });
}

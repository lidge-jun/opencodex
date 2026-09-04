export type ModelPickerOrderMode = "default" | "alphabetical" | "provider" | "most-used" | "custom";
export type SavedModelPickerOrderMode = Exclude<ModelPickerOrderMode, "default" | "custom">;

export interface ModelPickerUsage {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
}

function providerAndModel(slug: string): [string, string] {
  const slash = slug.indexOf("/");
  return slash < 0 ? ["", slug] : [slug.slice(0, slash), slug.slice(slash + 1)];
}

function compareProviderAndModel(a: string, b: string): number {
  const [aProvider, aModel] = providerAndModel(a);
  const [bProvider, bModel] = providerAndModel(b);
  return aProvider.localeCompare(bProvider) || aModel.localeCompare(bModel);
}

function usageBySlug(usage: readonly ModelPickerUsage[], models: readonly string[]): Map<string, number> {
  const requests = new Map<string, number>();
  const pickerModels = new Set(models);
  for (const row of usage) {
    const slug = row.model.includes("/") ? row.model : `${row.provider}/${row.model}`;
    const resolved = row.resolvedModel
      ? (row.resolvedModel.includes("/") ? row.resolvedModel : `${row.provider}/${row.resolvedModel}`)
      : undefined;
    const target = pickerModels.has(slug) ? slug : resolved && pickerModels.has(resolved) ? resolved : undefined;
    if (target) requests.set(target, (requests.get(target) ?? 0) + row.requests);
  }
  return requests;
}

export function modelPickerOrder(
  mode: Exclude<ModelPickerOrderMode, "custom">,
  models: readonly string[],
  usage: readonly ModelPickerUsage[] = [],
): string[] | null {
  if (mode === "default") return null;
  const unique = [...new Set(models)];
  if (mode === "alphabetical") {
    return unique.toSorted((a, b) => {
      const [, aModel] = providerAndModel(a);
      const [, bModel] = providerAndModel(b);
      return aModel.localeCompare(bModel) || compareProviderAndModel(a, b);
    });
  }
  if (mode === "provider") return unique.toSorted(compareProviderAndModel);

  const requests = usageBySlug(usage, unique);
  return unique.toSorted((a, b) => (requests.get(b) ?? 0) - (requests.get(a) ?? 0) || compareProviderAndModel(a, b));
}

export function modelPickerOrderMode(
  models: readonly string[],
  saved: readonly string[],
  savedMode?: SavedModelPickerOrderMode | null,
): ModelPickerOrderMode {
  if (saved.length === 0) return "default";
  const normalized = [...new Set(saved)];
  if (normalized.length !== models.length || normalized.some(model => !models.includes(model))) return "custom";
  if (savedMode) return savedMode;
  for (const mode of ["alphabetical", "provider"] as const) {
    const expected = modelPickerOrder(mode, models);
    if (expected?.every((model, index) => model === normalized[index])) return mode;
  }
  return "custom";
}

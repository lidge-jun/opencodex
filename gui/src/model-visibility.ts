export type ProviderModelMap = Record<string, string[]>;

export interface ModelVisibilityTarget { id: string; native?: boolean; }

export type ModelVisibilityScope = "models" | "provider";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error("invalid model list");
  }
  return [...new Set(value)];
}

export function parseSelectedModels(value: unknown): ProviderModelMap {
  if (!isRecord(value)) throw new Error("invalid selected models response");
  const selected = value.selected;
  if (!isRecord(selected)) throw new Error("invalid selected models response");
  return Object.fromEntries(
    Object.entries(selected).map(([provider, ids]) => [provider, uniqueStrings(ids)]),
  );
}

export async function fetchSelectedModels(
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelMap> {
  const response = await fetchImpl(`${apiBase}/api/selected-models`);
  if (!response.ok) throw new Error(`selected models HTTP ${response.status}`);
  return parseSelectedModels(await response.json());
}

export function modelIncluded(
  selected: ProviderModelMap,
  provider: string,
  modelId: string,
  native = false,
): boolean {
  if (native) return true;
  const allowlist = selected[provider];
  return !allowlist || allowlist.length === 0 || allowlist.includes(modelId);
}

export function modelVisible(
  selected: ProviderModelMap,
  provider: string,
  modelId: string,
  native: boolean,
  blocked: boolean,
): boolean {
  return modelIncluded(selected, provider, modelId, native) && !blocked;
}

export async function putModelVisibility(
  apiBase: string,
  scope: ModelVisibilityScope,
  provider: string,
  targets: ModelVisibilityTarget[],
  enabled: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(`${apiBase}/api/model-visibility`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, provider, targets, enabled }),
  });
}

export function shouldApplyLoadGeneration(request: number, current: number): boolean {
  return request === current;
}

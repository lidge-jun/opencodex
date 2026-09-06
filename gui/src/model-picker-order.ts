export type ModelPickerOrderMode = "default" | "alphabetical" | "provider" | "most-used" | "custom";
export type SavedModelPickerOrderMode = Exclude<ModelPickerOrderMode, "default" | "custom">;
export interface ModelPickerUsage {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
}
export interface PickerModelIdentity { provider: string; id: string; namespaced: string }
export interface PickerOrderSaved {
  pickerOrder: string[];
  pickerOrderMode: SavedModelPickerOrderMode | null;
}
export interface PickerOrderSettings extends PickerOrderSaved { pickerAvailable: string[] }

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === "string" && id.trim().length > 0);
}
function savedMode(value: unknown): value is SavedModelPickerOrderMode | null {
  return value === null || value === "alphabetical" || value === "provider" || value === "most-used";
}
export function isPickerOrderSaved(value: unknown): value is PickerOrderSaved {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return stringList(row.pickerOrder) && savedMode(row.pickerOrderMode);
}
export function isPickerOrderSettings(value: unknown): value is PickerOrderSettings {
  return isPickerOrderSaved(value) && stringList((value as PickerOrderSettings).pickerAvailable);
}
export function isModelPickerUsage(value: unknown): value is ModelPickerUsage[] {
  return Array.isArray(value) && value.every(row => row !== null && typeof row === "object"
    && typeof row.provider === "string" && typeof row.model === "string"
    && (row.resolvedModel === undefined || typeof row.resolvedModel === "string")
    && typeof row.requests === "number" && Number.isFinite(row.requests) && row.requests >= 0);
}
function parts(slug: string): [string, string] {
  const slash = slug.indexOf("/");
  return slash < 0 ? ["", slug] : [slug.slice(0, slash), slug.slice(slash + 1)];
}
// Fixed locale makes snapshots independent of the user's display language/OS locale.
const compare = (a: string, b: string) => a.localeCompare(b, "en");
function byProvider(a: string, b: string): number {
  const [ap, am] = parts(a), [bp, bm] = parts(b);
  return compare(ap, bp) || compare(am, bm);
}

export function modelPickerOrder(
  mode: Exclude<ModelPickerOrderMode, "custom">,
  models: readonly string[],
  usage: readonly ModelPickerUsage[] = [],
  identities: readonly PickerModelIdentity[] = [],
): string[] | null {
  if (mode === "default") return null;
  const unique = [...new Set(models)];
  if (mode === "alphabetical") return unique.sort((a, b) => compare(parts(a)[1], parts(b)[1]) || byProvider(a, b));
  if (mode === "provider") return unique.sort(byProvider);
  const candidates = new Set(unique);
  const raw = new Map<string, Set<string>>();
  const owners = new Map<string, Set<string>>();
  for (const row of identities) {
    if (!candidates.has(row.namespaced)) continue;
    const key = JSON.stringify([row.provider, row.id]);
    const values = raw.get(key) ?? new Set<string>();
    values.add(row.namespaced);
    raw.set(key, values);
    const sources = owners.get(row.namespaced) ?? new Set<string>();
    sources.add(key);
    owners.set(row.namespaced, sources);
  }
  const unambiguous = (slug: string): string | null => (owners.get(slug)?.size ?? 0) > 1 ? null : slug;
  const resolve = (provider: string, id: string): string | null | undefined => {
    const exact = raw.get(JSON.stringify([provider, id]));
    if (exact) return exact.size === 1 ? unambiguous([...exact][0]!) : null;
    // A raw upstream slash is not a namespace. Use the observed identity table above;
    // only fall back to an exact same-provider catalog id or an ordinary bare model id.
    if (id.startsWith(`${provider}/`) && candidates.has(id)) return unambiguous(id);
    const slug = `${provider}/${id}`;
    return !id.includes("/") && candidates.has(slug) ? unambiguous(slug) : undefined;
  };
  const counts = new Map<string, number>();
  for (const row of usage) {
    // Summary buckets are keyed by requested model. resolvedModel is only a
    // representative observation, not proof that every request used that target.
    const target = resolve(row.provider, row.model);
    if (target) counts.set(target, (counts.get(target) ?? 0) + row.requests);
  }
  return unique.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || byProvider(a, b));
}

export function modelPickerOrderMode(
  models: readonly string[], saved: readonly string[], mode?: SavedModelPickerOrderMode | null,
): ModelPickerOrderMode {
  if (saved.length === 0) return "default";
  // Existing complete/native orders are never silently replaced by a routed preset.
  if (saved.some(id => !id.includes("/"))) return "custom";
  if (mode === "alphabetical" || mode === "provider" || mode === "most-used") return mode;
  const candidates = new Set(models);
  if (new Set(saved).size !== saved.length || saved.length !== candidates.size
    || saved.some(id => !candidates.has(id))) return "custom";
  for (const preset of ["alphabetical", "provider"] as const) {
    const expected = modelPickerOrder(preset, models);
    if (expected !== null && expected.length === saved.length
      && expected.every((id, index) => id === saved[index])) return preset;
  }
  return "custom";
}

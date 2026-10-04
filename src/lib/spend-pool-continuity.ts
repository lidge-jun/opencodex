/** Explicit, salted pool identity evidence. Never infer ownership from a label prefix. */
export interface PoolBinding { readonly alias: string; readonly canonical: string }
export interface PoolContinuityRecord {
  readonly v: 1;
  readonly kind: "pool-continuity";
  readonly at: number;
  readonly bindings: readonly PoolBinding[];
}

const isAlias = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

/** Kept outside `spend`: older strict spend schemas must keep all configured ceilings. */
export function spendPoolAliasesError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "spendPoolAliases must be an object";
  if (Object.keys(value).length > 4_096) return "spendPoolAliases has too many entries";
  for (const [alias, provider] of Object.entries(value)) {
    if (!isAlias(alias) || typeof provider !== "string" || !provider.trim() || provider.length > 256) {
      return "spendPoolAliases requires exact 32-character salted pool aliases and nonempty provider IDs";
    }
  }
  return undefined;
}

export function parsePoolContinuityRecord(value: unknown): PoolContinuityRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || record.kind !== "pool-continuity"
    || typeof record.at !== "number" || !Number.isFinite(record.at) || record.at < 0
    || !Array.isArray(record.bindings) || record.bindings.length > 16_384) return undefined;
  const bindings: PoolBinding[] = [];
  const seen = new Set<string>();
  for (const entry of record.bindings) {
    if (!entry || typeof entry !== "object") return undefined;
    const { alias, canonical } = entry as Partial<PoolBinding>;
    if (!isAlias(alias) || !isAlias(canonical) || seen.has(alias)) return undefined;
    seen.add(alias);
    bindings.push({ alias, canonical });
  }
  return { v: 1, kind: "pool-continuity", at: record.at, bindings };
}

/** A directed union: links may merge proven groups, never split or erase accounted spend. */
export function createPoolContinuity() {
  let bindings = new Map<string, string>();
  const resolve = (alias: string, map = bindings): string => {
    const seen = new Set<string>();
    while (map.has(alias) && map.get(alias) !== alias) {
      if (seen.has(alias)) throw new Error("cyclic pool identity evidence");
      seen.add(alias);
      alias = map.get(alias)!;
    }
    return alias;
  };
  const merge = (proposed: Iterable<readonly [string, string]>): Map<string, string> | undefined => {
    const next = new Map(bindings);
    for (const [alias, canonical] of proposed) next.set(alias, canonical);
    try {
      // Validate the whole proposed graph, not an intermediate sorted prefix. A verified
      // A -> B -> C rename may repeat A -> C without splitting the existing A/B group.
      for (const alias of next.keys()) resolve(alias, next);
      for (const [alias, canonical] of bindings) {
        if (resolve(alias, next) !== resolve(canonical, next)) return undefined;
      }
      for (const alias of next.keys()) next.set(alias, resolve(alias, next));
    } catch { return undefined; }
    return next;
  };
  return {
    resolve: (alias: string): string => resolve(alias),
    known: (alias: string): boolean => bindings.has(alias),
    size: (): number => bindings.size,
    record: (at: number): PoolContinuityRecord => ({
      v: 1, kind: "pool-continuity", at,
      bindings: [...bindings].map(([alias, canonical]) => ({ alias, canonical })),
    }),
    restore(record: PoolContinuityRecord): boolean {
      const next = merge(record.bindings.map(({ alias, canonical }) => [alias, canonical] as const));
      if (!next) return false;
      bindings = next;
      return true;
    },
    prepare(config: unknown, requested: string | undefined, historical: ReadonlySet<string>,
      hash: (provider: string) => string, at: number, capacity: number): PoolContinuityRecord | false | undefined {
      if (spendPoolAliasesError(config)) return false;
      const next = merge(Object.entries(config ?? {}).map(([alias, provider]) => [alias, hash(provider as string)] as const));
      if (!next) return false;
      if (requested !== undefined && !next.has(requested) && !historical.has(requested)) next.set(requested, requested);
      if (next.size > Math.min(16_384, capacity)) return false;
      if (next.size === bindings.size && [...next].every(([key, value]) => bindings.get(key) === value)) return undefined;
      return { v: 1, kind: "pool-continuity", at,
        bindings: [...next].map(([alias, canonical]) => ({ alias, canonical })) };
    },
  };
}

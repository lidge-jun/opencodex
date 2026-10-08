import { hashSpendAlias, validatePoolAliasOwners } from "./spend-pool-alias-validation";
export { spendPoolAliasesError } from "./spend-pool-alias-validation";

/** Current config supplies a read-time graph; original counters never move between buckets. */
export function resolvePoolAliases(config: unknown, salt: string, providerIds: Iterable<string> = []) {
  const error = validatePoolAliasOwners(config, salt, providerIds);
  const bindings = new Map<string, string>();
  if (!error) for (const [alias, provider] of Object.entries(config ?? {})) {
    bindings.set(alias, hashSpendAlias(salt, "pool", provider as string));
  }
  const resolve = (original: string): string => {
    let alias = original;
    const seen = new Set<string>();
    while (bindings.has(alias) && bindings.get(alias) !== alias) {
      if (seen.has(alias)) throw new Error("cyclic pool alias mapping");
      seen.add(alias);
      alias = bindings.get(alias)!;
    }
    return alias;
  };
  let invalid = error !== undefined;
  if (!invalid) {
    try { for (const alias of bindings.keys()) resolve(alias); }
    catch { invalid = true; }
  }
  if (invalid) bindings.clear();
  return { valid: !invalid, resolve, known: (alias: string): boolean => bindings.has(alias) };
}

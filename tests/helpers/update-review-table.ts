// Shape shared by the update-lint review sidecars merged into the base tables.
export type HelperControlContract = readonly [file: string, context: string, call: string, count: number, contract: string];
export interface UpdateReviewTable {
  /** Reviewed static import/export statements per repository file (whitespace-compacted text). */
  readonly staticImports: Readonly<Record<string, readonly string[]>>;
  /** Reviewed deferred import() sites: "<file>:<function>:<enclosing declaration or assignment>". */
  readonly deferredImports: readonly string[];
  /** Exact primitive references: [key, reason]. */
  readonly primitive: readonly (readonly [string, string])[];
  /** Exact process/runtime references with occurrence counts: [key, reason, count]. */
  readonly process: readonly (readonly [string, string, number])[];
  /** Helper control-site contracts. */
  readonly contracts: readonly HelperControlContract[];
}

/** Merge static-import maps, refusing a file reviewed in two places. */
export function mergeStaticImports(...maps: Readonly<Record<string, readonly string[]>>[]): Readonly<Record<string, readonly string[]>> {
  const merged: Record<string, readonly string[]> = {};
  for (const map of maps) for (const [file, statements] of Object.entries(map)) {
    if (file in merged) throw new Error("update lint: static imports for " + file + " are reviewed in two tables");
    merged[file] = statements;
  }
  return merged;
}

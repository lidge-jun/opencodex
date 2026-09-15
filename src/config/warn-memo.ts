const warnedConfigFallbacks = new Set<string>();
const warnedInheritedFastWireConflicts = new Set<string>();
let lastWarningReconciledGeneration = 0;

export function reconcileConfigWarningMemos(generation: number): number {
  if (generation <= lastWarningReconciledGeneration) return 0;
  const removed = warnedConfigFallbacks.size + warnedInheritedFastWireConflicts.size;
  warnedConfigFallbacks.clear();
  warnedInheritedFastWireConflicts.clear();
  lastWarningReconciledGeneration = generation;
  return removed;
}

export function hasWarnedConfigFallback(configPath: string): boolean {
  return warnedConfigFallbacks.has(configPath);
}

export function markWarnedConfigFallback(configPath: string): void {
  warnedConfigFallbacks.add(configPath);
}

export function hasWarnedInheritedFastWireConflict(configPath: string): boolean {
  return warnedInheritedFastWireConflicts.has(configPath);
}

export function markWarnedInheritedFastWireConflict(configPath: string): void {
  warnedInheritedFastWireConflicts.add(configPath);
}

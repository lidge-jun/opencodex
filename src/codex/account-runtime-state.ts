import { captureConfigGeneration, type GenerationContext } from "../lib/state-store-sweeper";

const reauthAccounts = new Set<string>();
let lastReconciledGeneration = 0;
let liveAccountIds = new Set<string>();

export function markAccountNeedsReauth(id: string, writerGeneration = captureConfigGeneration()): void {
  if (writerGeneration < lastReconciledGeneration && !liveAccountIds.has(id)) return;
  reauthAccounts.add(id);
}

export function reconcileCodexReauthState(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const id of reauthAccounts) {
    if (context.codexAccountIds.has(id)) continue;
    reauthAccounts.delete(id);
    removed += 1;
  }
  liveAccountIds = new Set(context.codexAccountIds);
  lastReconciledGeneration = context.generation;
  return removed;
}

export function isAccountNeedsReauth(id: string): boolean {
  return reauthAccounts.has(id);
}

export function clearAccountNeedsReauth(id: string): void {
  reauthAccounts.delete(id);
}

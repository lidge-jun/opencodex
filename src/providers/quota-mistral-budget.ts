/**
 * Mistral budget windows the reset detector may keep while their percent is unknown.
 *
 * This lives beside the provider quota seam rather than in src/quota/: src/providers/quota.ts is
 * statically reachable from the core request path, and tests/usage/quota-reset-core-boundary.test.ts
 * keeps every src/quota module off that path. The seam calls this on every Mistral report, so it
 * must stay a plain import with no dependency on the reset subsystem.
 */
export function mistralUnknownBudgetWindows(
  quota: { unknownBudgetWindows?: ReadonlyArray<{ label: string; resetAt?: number }> },
): { window: string; resetAt: number }[] {
  return (quota.unknownBudgetWindows ?? []).flatMap(entry => {
    const match = /^(API budget|Vibe budget)(?: \((?:FREE|INDIVIDUAL|EDU|TEAM)\))?$/.exec(entry.label);
    return match && typeof entry.resetAt === "number" && Number.isFinite(entry.resetAt) && entry.resetAt > 0
      ? [{ window: `custom:${match[1]}`, resetAt: entry.resetAt }]
      : [];
  });
}

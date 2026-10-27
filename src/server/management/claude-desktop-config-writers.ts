import { adoptPersistedClaudeCode, deleteConfigTopLevelKey, mutatePersistedConfig } from "../../config";
import { getConfigDir as configRoot, withConfigDirHardeningSettled as settleConfigRoot } from "../../config/paths";
import type { OcxConfig } from "../../types";

/**
 * Mirror a durable desired-state transition onto the long-lived server snapshot.
 *
 * `setIntegrationEnabled` writes DISK only. The server reuses one `config` object
 * for every request, so leaving it stale makes the native GET report the opposite
 * of what was just persisted, and makes any later whole-snapshot save (the Desktop
 * profile PUT does exactly that) write the stale value back over the transition.
 * ON is the ABSENCE of the key, matching `setIntegrationEnabled`'s on-disk shape.
 */
export function mirrorDesiredEnabledOntoSnapshot(config: OcxConfig, client: "claude-desktop", enabled: boolean): void {
  const integrations = { ...(config.clientIntegrations ?? {}) };
  if (enabled) delete integrations[client];
  else integrations[client] = false;
  if (Object.keys(integrations).length === 0) deleteConfigTopLevelKey(config, "clientIntegrations");
  else config.clientIntegrations = integrations;
}

/**
 * Persist ONLY `claudeCode.desktopProfile`, field-scoped, against the CURRENT
 * on-disk config.
 *
 * `saveConfigPreservingClaudeCode(ctx.config)` writes the whole long-lived server
 * snapshot. On the apply path that snapshot still carries the `clientIntegrations`
 * it was loaded with, so a save right after `setIntegrationEnabled("claude-desktop",
 * true)` carried the stale OFF back over the enable and made the route cancel its
 * own apply. Mutating one field under the config-mutation lock cannot regress an
 * unrelated key another writer just committed.
 */
export async function persistDesktopProfileField(
  config: OcxConfig,
  desktopProfile: NonNullable<OcxConfig["claudeCode"]>["desktopProfile"],
  expectedProfile: NonNullable<OcxConfig["claudeCode"]>["desktopProfile"],
): Promise<{ ok: true } | { ok: false; reason: "missing" | "invalid" | "conflict" | "unavailable" }> {
  const outcome = await settleConfigRoot(configRoot(), () => {
    const outcome = mutatePersistedConfig(persisted => {
      if (JSON.stringify(persisted.claudeCode?.desktopProfile) !== JSON.stringify(expectedProfile)) {
        return { changed: false, value: null };
      }
      persisted.claudeCode = { ...(persisted.claudeCode ?? {}), desktopProfile };
      return { changed: true, value: structuredClone(persisted.claudeCode) };
    });
    if (outcome.status !== "unavailable" && outcome.value !== null) adoptPersistedClaudeCode(config, outcome.value);
    return outcome;
  }).catch(() => {
    return { status: "unavailable", reason: "unavailable" } as const;
  });
  // Only mirror into memory once the durable write actually landed; an
  // `unavailable` outcome must not leave the snapshot claiming a saved profile.
  if (outcome.status === "unavailable") return { ok: false, reason: outcome.reason };
  if (outcome.value === null) return { ok: false, reason: "conflict" };
  return { ok: true };
}

export async function persistDesktopModeField(
  config: OcxConfig,
  desktopMode: "first-party" | "gateway",
): Promise<{ ok: true } | { ok: false; reason: "missing" | "invalid" | "conflict" | "unavailable" }> {
  const { recordClaudeDesktopMode } = await import("../../claude/desktop-first-party");
  const outcome = await settleConfigRoot(configRoot(), () => {
    const outcome = mutatePersistedConfig(persisted => {
      const mutation = recordClaudeDesktopMode(persisted, desktopMode);
      return { changed: mutation.changed, value: structuredClone(persisted.claudeCode) };
    });
    if (outcome.status !== "unavailable") adoptPersistedClaudeCode(config, outcome.value);
    return outcome;
  }).catch(() => {
    return { status: "unavailable", reason: "unavailable" } as const;
  });
  if (outcome.status === "unavailable") return { ok: false, reason: outcome.reason };
  // First-party apply ends here — no profile-marker write follows — so without
  // adopting, live diverges from the armed baseline and a later whole-config
  // save reads that divergence as a pending mutation and stomps hand edits.
  return { ok: true };
}

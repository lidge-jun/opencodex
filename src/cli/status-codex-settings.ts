/**
 * The OCX-6 fields of `ocx status --json`: which Codex settings this machine applied, when, and
 * when its client runtime started.
 *
 * - `appliedCodexSettingsDigest` (any device): the digest of the values this machine applies. On a
 *   Remote Link Child that is its apply record (the Home's values its last sync wrote); on a Home or
 *   standalone install, its own projection, which is also exactly what it serves its Children. Null
 *   on a hub client and on a Child that has no apply record yet.
 * - `lastApplyAt` (Child): epoch ms of the last successful apply of a different Home settings
 *   document; null elsewhere.
 * - `runtimeStartedAt` (Child): epoch ms the live client runtime reports as its start; null when no
 *   client runtime answers.
 */
import type { LiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";

export interface CliAppliedCodexSettingsStatus {
  appliedCodexSettingsDigest: string | null;
  lastApplyAt: number | null;
  runtimeStartedAt: number | null;
}

export interface AppliedCodexSettingsStatusDeps {
  readStartedAt?: (live: LiveProxy) => Promise<number | null>;
}

export async function collectAppliedCodexSettingsStatus(
  config: OcxConfig,
  live: LiveProxy | null,
  deps: AppliedCodexSettingsStatusDeps = {},
): Promise<CliAppliedCodexSettingsStatus> {
  const { codexSettingsDigest, projectHomeCodexSettings } = await import("../link/codex-settings");
  if (config.runtimeRole !== "client") {
    return {
      appliedCodexSettingsDigest: codexSettingsDigest(projectHomeCodexSettings(config, "0.0.0").settings),
      lastApplyAt: null,
      runtimeStartedAt: null,
    };
  }
  const linkId = config.client?.transport === "link" ? config.client.link?.linkId : undefined;
  if (!linkId) return { appliedCodexSettingsDigest: null, lastApplyAt: null, runtimeStartedAt: null };
  const { readHomeCodexSettingsRecord } = await import("../client/link-home");
  const record = readHomeCodexSettingsRecord(linkId);
  const appliedAt = record ? Date.parse(record.appliedAt) : Number.NaN;
  let runtimeStartedAt: number | null = null;
  if (live?.role === "client") {
    const read = deps.readStartedAt ?? (async (target: LiveProxy) =>
      (await import("./link-apply-restart")).readClientRuntimeStartedAt(target));
    runtimeStartedAt = await read(live);
  }
  return {
    appliedCodexSettingsDigest: record ? codexSettingsDigest(record.document.settings) : null,
    lastApplyAt: Number.isFinite(appliedAt) ? appliedAt : null,
    runtimeStartedAt,
  };
}

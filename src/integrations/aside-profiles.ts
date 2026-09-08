import type { AsideProfile } from "../clients/aside-profiles";
import { asideHomeDir } from "../clients/config-export";
import { join } from "node:path";
import type { OwnedIntegrationRefreshOutcome } from "./owned-refresh";
import { readIntegrationState, type IntegrationState, type IntegrationStatus } from "./state";
import {
  applyIntegrationCoordinated, disableIntegrationCoordinated,
  overwriteIntegrationCoordinated, refreshIntegrationCoordinated,
} from "./writer";
import {
  asideProfileEnabled, asideProfileFailure, asideProfileScope, asideWriteInput,
  asideRootStore, createAsideProfileContext, persistAsidePolicy, runAsideProfileAction, selectAsideProfiles,
  type AsideProfileContext, type AsideProfilesInput, type AsideProfileWriteOutcome,
} from "./aside-profile-context";

export { AsideProfileError } from "./aside-profile-context";
export type { AsideProfilesInput, AsideProfileWriteOutcome } from "./aside-profile-context";

export interface AsideProfileState extends IntegrationStatus {
  profileId: number;
  name?: string;
  current: boolean;
  enabled: boolean;
  error?: string;
}

export interface AsideProfileList extends IntegrationStatus {
  profiles: AsideProfileState[];
  allEnabled: boolean;
  enabledCount: number;
  appliedCount: number;
  total: number;
  error?: string;
}

export interface AsideProfileMutationResult {
  ok: boolean;
  clientId: "aside";
  changed: boolean;
  state: IntegrationState;
  message: string;
  results: AsideProfileWriteOutcome[];
  /** Preserve the ordinary refusal serializer for a single selected profile. */
  result?: AsideProfileWriteOutcome;
}

function aggregateState(states: readonly IntegrationState[]): IntegrationState {
  if (states.includes("unsafe")) return "unsafe";
  if (states.includes("conflict")) return "conflict";
  if (states.every(state => state === "absent")) return "absent";
  return states.every(state => state === "current") ? "current" : "stale";
}

async function profileState(ctx: AsideProfileContext, profile: AsideProfile): Promise<AsideProfileState> {
  const metadata = {
    profileId: profile.id, ...(profile.name !== undefined ? { name: profile.name } : {}),
    current: profile.current, enabled: asideProfileEnabled(ctx, profile.id),
  };
  try {
    const scope = asideProfileScope(ctx, profile);
    const input = await asideWriteInput(ctx, scope);
    return { ...readIntegrationState(input), ...metadata };
  } catch (error) {
    return {
      clientId: "aside", ...metadata, state: "unsafe", installed: false,
      configPath: profile.configPath, reason: "unresolvable-path", snapshotCount: -1,
      retentionDegraded: true, error: asideProfileFailure(profile.id, error).message,
    };
  }
}

export async function listAsideProfileStates(input: AsideProfilesInput): Promise<AsideProfileList> {
  let ctx: AsideProfileContext;
  try { ctx = createAsideProfileContext(input); }
  catch (error) {
    return {
      clientId: "aside", profiles: [], total: 0, enabledCount: 0, appliedCount: 0, allEnabled: false,
      state: "unsafe", installed: false, configPath: join(asideHomeDir(input.env, input.home), "u"),
      snapshotCount: -1, retentionDegraded: true, reason: "unresolvable-path",
      error: asideProfileFailure(0, error).message,
    };
  }
  const profiles: AsideProfileState[] = [];
  for (const profile of ctx.profiles) profiles.push(await profileState(ctx, profile));
  const enabledCount = profiles.filter(profile => profile.enabled).length;
  const snapshotCount = profiles.some(profile => profile.snapshotCount < 0) ? -1
    : profiles.reduce((sum, profile) => sum + profile.snapshotCount, 0);
  return {
    clientId: "aside", profiles, total: profiles.length, enabledCount,
    allEnabled: profiles.length > 0 && enabledCount === profiles.length,
    appliedCount: profiles.filter(profile => profile.state === "current" || profile.state === "stale").length,
    state: aggregateState(profiles.map(profile => profile.state)),
    installed: profiles.some(profile => profile.installed),
    configPath: profiles.find(profile => profile.current)?.configPath ?? profiles[0]?.configPath ?? "",
    snapshotCount, retentionDegraded: profiles.some(profile => profile.retentionDegraded),
  };
}

export async function getAsideProfileState(input: AsideProfilesInput, id: number): Promise<AsideProfileState> {
  const ctx = createAsideProfileContext(input);
  return profileState(ctx, selectAsideProfiles(ctx, id)[0]!);
}

export function mutateAsideProfiles(
  input: AsideProfilesInput,
  change: { enabled: boolean; profileId?: number; overwriteConflict?: boolean },
): Promise<AsideProfileMutationResult> {
  return runAsideProfileAction<AsideProfileMutationResult>(input, change.profileId, `${change.enabled ? "enable" : "disable"}:${Boolean(change.overwriteConflict)}`, async (ctx, profiles) => {
    const refused = new Map<number, AsideProfileWriteOutcome>();
    for (const profile of profiles) {
      try { asideProfileScope(ctx, profile); }
      catch (error) { refused.set(profile.id, asideProfileFailure(profile.id, error)); }
    }
    // This await precedes model loading, writer preflight, snapshots and all client writes.
    await persistAsidePolicy(ctx, change);
    const results: AsideProfileWriteOutcome[] = [];
    for (const profile of profiles) {
      const refusal = refused.get(profile.id);
      if (refusal) { results.push(refusal); continue; }
      try {
        const scope = asideProfileScope(ctx, profile);
        const bound = await asideWriteInput(ctx, scope);
        const operation = !change.enabled ? disableIntegrationCoordinated
          : change.overwriteConflict ? overwriteIntegrationCoordinated : applyIntegrationCoordinated;
        results.push({ ...await operation(bound, { lockSeams: input.lockSeams }), profileId: profile.id });
      } catch (error) { results.push(asideProfileFailure(profile.id, error)); }
    }
    const ok = results.every(result => result.ok);
    return {
      ok, clientId: "aside", changed: results.some(result => result.ok && result.changed),
      state: aggregateState(results.map(result => result.state)),
      message: ok ? "Aside profile preferences applied" : "Aside preferences saved; some profiles could not be updated",
      results, ...(results.length === 1 ? { result: results[0] } : {}),
    };
  });
}

export function refreshAsideProfiles(input: AsideProfilesInput): Promise<Array<OwnedIntegrationRefreshOutcome & { profileId: number }>> {
  const policy = input.config.asideProfileSync;
  const selected = Object.values(policy?.profiles ?? {}).some(enabled => enabled === true);
  if (!selected && (policy?.allProfiles === false
    || (policy?.allProfiles !== true && !asideRootStore(input).readRecords().aside))) return Promise.resolve([]);
  return runAsideProfileAction(input, undefined, "refresh", async (ctx, profiles) => {
    const outcomes: Array<OwnedIntegrationRefreshOutcome & { profileId: number }> = [];
    for (const profile of profiles) {
      if (!asideProfileEnabled(ctx, profile.id)) continue;
      try {
        const scope = asideProfileScope(ctx, profile);
        const owned = scope.store.readRecords().aside !== undefined;
        const bound = await asideWriteInput(ctx, scope);
        // A surviving ownership record means a removed block stays removed.
        // A newly discovered, enabled profile may receive its first safe apply.
        const operation = owned ? refreshIntegrationCoordinated : applyIntegrationCoordinated;
        const result = await operation(bound, { lockSeams: input.lockSeams });
        outcomes.push({
          client: "aside", profileId: profile.id, ok: result.ok,
          ...(result.ok ? { changed: result.changed } : {}),
          ...(!result.ok || result.state === "absent" ? { reason: result.message } : {}),
          ...(!result.ok ? {
            refusalReason: result.reason, state: result.state,
            ...(result.snapshotPath ? { snapshotPath: result.snapshotPath } : {}),
            ...(result.residual ? { residual: true } : {}),
          } : {}),
        });
      } catch (error) {
        const failure = asideProfileFailure(profile.id, error);
        outcomes.push({ client: "aside", profileId: profile.id, ok: false, reason: failure.message,
          ...(!failure.ok ? { refusalReason: failure.reason, state: failure.state,
            ...(failure.snapshotPath ? { snapshotPath: failure.snapshotPath } : {}),
            ...(failure.residual ? { residual: true } : {}) } : {}),
        });
      }
    }
    return outcomes;
  });
}

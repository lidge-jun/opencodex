import type { AsideProfile } from "../clients/aside-profiles";
import { asideHomeDir } from "../clients/config-export";
import { join } from "node:path";
import type { OwnedIntegrationRefreshOutcome } from "./owned-refresh";
import type { JournalEntry } from "./journal";
import type { IntegrationStateStore } from "./store";
import { readIntegrationState, type IntegrationState, type IntegrationStatus } from "./state";
import {
  applyIntegrationCoordinated, disableIntegrationCoordinated,
  overwriteIntegrationCoordinated, refreshIntegrationCoordinated,
  type IntegrationWriteInput,
} from "./writer";
import {
  asideProfileEnabled, asideProfileFailure, asideProfileScope, asideWriteInput,
  asideRootStore, createAsideProfileContext, persistAsidePolicy, runAsideProfileAction, selectAsideProfiles,
  type AsideProfileContext, type AsideProfilesInput, type AsideProfileWriteOutcome,
} from "./aside-profile-context";
import { AsideProfileError as AsideProfileErrorClass } from "./aside-profile-context";
import {
  previewIntegration,
  type IntegrationMutationPlan,
  type IntegrationPlanOperation,
} from "./mutation-plan";

export { AsideProfileError } from "./aside-profile-context";
export type { AsideProfilesInput, AsideProfileWriteOutcome } from "./aside-profile-context";

/**
 * Plan one profile's change without performing it.
 *
 * A profile is the unit here because a fingerprint can only honestly describe one independently
 * changing file. The scope this builds is the same scope the mutation will use — that profile's
 * store, IO and resolved path pair — so the plan describes the thing that would actually happen
 * rather than an approximation of it.
 *
 * The roster comes from whatever the caller injected, so a preview inherits the caller's no-gather
 * guarantee instead of reaching for a second source of models.
 */
export async function previewAsideProfile(
  input: AsideProfilesInput,
  request: {
    profileId: number;
    operation: IntegrationPlanOperation;
    opId?: string;
    confirmDrift?: boolean;
    /** The row and store the route already selected; re-resolving could pick a different copy. */
    resolved?: { entry: JournalEntry; store: IntegrationStateStore };
  },
): Promise<IntegrationMutationPlan> {
  const ctx = createAsideProfileContext(input);
  const profile = selectAsideProfiles(ctx, request.profileId)[0];
  if (!profile) throw new AsideProfileErrorClass("aside_profile_not_found", 404, "That Aside profile is not available");
  const scope = asideProfileScope(ctx, profile);
  const bound = await asideWriteInput(ctx, scope);
  return previewIntegration(bound, {
    operation: request.operation,
    profileId: request.profileId,
    ...(request.opId === undefined ? {} : { opId: request.opId }),
    ...(request.confirmDrift === undefined ? {} : { confirmDrift: request.confirmDrift }),
    ...(request.resolved === undefined ? {} : { resolved: request.resolved }),
  });
}

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
  options?: {
    revalidate?: (prepared: IntegrationWriteInput) => Promise<AsideProfileWriteOutcome | null>;
    /**
     * Checked again immediately before the client document is written.
     *
     * Aside takes no writer lock, and the preference write sits between the first check and the
     * write it authorizes. Nothing stops the target file from being edited in that window, and the
     * writer's own comparison reads the file as it is now, so a confirmation about the earlier
     * file would otherwise still overwrite the later one.
     */
    revalidateBeforeWrite?: (prepared: IntegrationWriteInput) => Promise<AsideProfileWriteOutcome | null>;
  },
): Promise<AsideProfileMutationResult> {
  return runAsideProfileAction<AsideProfileMutationResult>(input, change.profileId, `${change.enabled ? "enable" : "disable"}:${Boolean(change.overwriteConflict)}`, async (ctx, profiles) => {
    const refused = new Map<number, AsideProfileWriteOutcome>();
    for (const profile of profiles) {
      try { asideProfileScope(ctx, profile); }
      catch (error) { refused.set(profile.id, asideProfileFailure(profile.id, error)); }
    }
    /*
     * The input each profile will be written from, prepared before the check and handed to it.
     *
     * A check that built its own view from the live configuration was answering about a different
     * input than the one that would be written: the context copies the configuration when it is
     * created, so live could be edited to something else and then back again while this action was
     * in flight, and a check reading live would agree with a plan this write never described.
     *
     * Only a checked change prepares early. Preparing resolves the roster, and an unchecked change
     * whose preference write fails must not have done any model work by then, which is a contract
     * of its own. There is nothing to bring forward when there is no check to read it.
     */
    const prepared = new Map<number, IntegrationWriteInput>();
    if (options?.revalidate) {
      /*
       * Refused before anything is prepared. Preparing resolves the roster, and a supported loader
       * reaches providers and can finalize an initial model selection, so a confirmation this
       * cannot check at all must not cause that work first. A confirmation describes one profile,
       * and HTTP refuses one that names none; guessing which prepared input a bindingless
       * confirmation meant would invent the thing the check exists to verify.
       */
      if (change.profileId === undefined) {
        throw new AsideProfileErrorClass("invalid_aside_profile", 400, "a confirmed change applies to one profile");
      }
      for (const profile of profiles) {
        if (refused.has(profile.id)) continue;
        try { prepared.set(profile.id, await asideWriteInput(ctx, asideProfileScope(ctx, profile))); }
        catch (error) { refused.set(profile.id, asideProfileFailure(profile.id, error)); }
      }
    }
    /*
     * A confirmation is checked HERE, not under the writer lock.
     *
     * The await below persists the user's Aside preference before any writer runs, so a check
     * that waited for the lock would fire after the thing it was meant to prevent. Profile and
     * path selection is frozen by this point, which is everything the check needs.
     */
    if (options?.revalidate) {
      const guarded = change.profileId === undefined ? undefined : prepared.get(change.profileId);
      // Nothing prepared is nothing to check and nothing to write; refusing keeps a binding from
      // being dropped on the way to a write that would then be unchecked.
      const stale: AsideProfileWriteOutcome | null = guarded === undefined
        ? refused.get(change.profileId ?? -1) ?? {
          ok: false, reason: "unsafe", state: "conflict", clientId: "aside",
          message: "that profile cannot be prepared for this change",
          profileId: change.profileId ?? profiles[0]?.id ?? 0,
        }
        : await options.revalidate(guarded);
      if (stale) {
        return {
          ok: false,
          clientId: "aside",
          changed: false,
          state: "conflict",
          message: "that confirmation no longer describes this profile",
          results: [stale],
          result: stale,
        };
      }
    }
    // This await precedes model loading, writer preflight, snapshots and all client writes.
    await persistAsidePolicy(ctx, change);
    const results: AsideProfileWriteOutcome[] = [];
    for (const profile of profiles) {
      const refusal = refused.get(profile.id);
      if (refusal) { results.push(refusal); continue; }
      try {
        // The prepared input when a check read one, so the write is the thing that was checked.
        const bound = prepared.get(profile.id) ?? await asideWriteInput(ctx, asideProfileScope(ctx, profile));
        const operation = !change.enabled ? disableIntegrationCoordinated
          : change.overwriteConflict ? overwriteIntegrationCoordinated : applyIntegrationCoordinated;
        results.push({
          ...await operation(bound, {
            lockSeams: input.lockSeams,
            ...(options?.revalidateBeforeWrite
              ? { revalidate: (frozen: IntegrationWriteInput) => options.revalidateBeforeWrite!(frozen) }
              : {}),
          }),
          profileId: profile.id,
        });
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

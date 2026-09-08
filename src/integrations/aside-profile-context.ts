import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { ClientPathError, type ExportModel } from "../clients/config-export";
import { assertAsideProfileBoundary, guardAsideProfileIO, listAsideProfiles, type AsideProfile } from "../clients/aside-profiles";
import type { OcxConfig } from "../types";
import { type IntegrationIO } from "./config-io";
import type { JournalEntry } from "./journal";
import { IntegrationMutationBusyError, runIntegrationMutationFlight } from "./mutation-flight";
import { fingerprint } from "./ownership";
import { createIntegrationStateStore, type IntegrationStateStore } from "./store";
import type { IntegrationWriteInput, WriteOutcome } from "./writer";
import type { IntegrationWriterLockSeams } from "./writer-lock";

export interface AsideProfilesInput {
  config: OcxConfig;
  models: readonly ExportModel[] | (() => Promise<readonly ExportModel[]>);
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  store?: IntegrationStateStore;
  io?: IntegrationIO;
  persistConfig?: (config: OcxConfig) => void | Promise<void>;
  lockSeams?: IntegrationWriterLockSeams;
}

export class AsideProfileError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "AsideProfileError";
  }
}

export type AsideProfilePolicy = NonNullable<OcxConfig["asideProfileSync"]>;
export type AsideProfileWriteOutcome = WriteOutcome & { profileId: number };
export interface AsideProfileScope {
  profile: AsideProfile;
  store: IntegrationStateStore;
  io: IntegrationIO;
  assertBoundary: () => void;
}
export interface AsideProfileContext {
  input: AsideProfilesInput;
  profiles: AsideProfile[];
  rootStore: IntegrationStateStore;
  legacyProfileId: number | null;
  defaultEnabled: boolean;
  models: () => Promise<readonly ExportModel[]>;
  scopes: Map<number, AsideProfileScope>;
}

function storeUnsafe(): never {
  throw new AsideProfileError("aside_profile_store_unsafe", 409, "Aside profile ownership storage cannot be accessed safely");
}

/** Allow aliases above the trusted anchor, never at or below it. */
function storeGuard(anchor: string, target: string): () => void {
  const base = resolve(anchor);
  const root = resolve(target);
  const rel = relative(base, root);
  if (rel.startsWith(`..${sep}`) || rel === ".." || resolve(base, rel) !== root) storeUnsafe();
  const identities = new Map<string, string>();
  const inspect = (path: string, directory: boolean): boolean => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink > 1)) storeUnsafe();
      if (directory) {
        const identity = `${realpathSync(path)}:${stat.dev}:${stat.ino}`;
        if (identities.has(path) && identities.get(path) !== identity) storeUnsafe();
        identities.set(path, identity);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !identities.has(path)) return false;
      storeUnsafe();
    }
  };
  return () => {
    let path = base;
    if (!inspect(path, true)) return;
    for (const part of rel ? rel.split(sep) : []) {
      path = join(path, part);
      if (!inspect(path, true)) return;
    }
    for (const name of ["records.json", "journal.jsonl", "maintenance.json"]) inspect(join(root, name), false);
    const snapshots = join(root, "snapshots");
    if (!inspect(snapshots, true)) return;
    const aside = join(snapshots, "aside");
    if (inspect(aside, true)) for (const name of readdirSync(aside)) inspect(join(aside, name), false);
  };
}

/** Store methods close over their original root; IO bookkeeping must bind to the guarded facade. */
function guardedStore(store: IntegrationStateStore, anchor: string): IntegrationStateStore {
  const guard = storeGuard(anchor, store.root);
  guard();
  return new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        guard();
        if (property === "readSnapshot") assertAsideSnapshotEntry(args[0] as JournalEntry);
        // Maintenance in this service is Aside-scoped, including a legacy shared store.
        if (property === "retryPendingPrunes") {
          if (store.readMaintenance().pruneFailures.aside) {
            if (store.pruneSnapshots("aside").ok) store.clearPruneFailure("aside");
          }
          return;
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

export function asideRootStore(input: AsideProfilesInput): IntegrationStateStore {
  const raw = input.store ?? createIntegrationStateStore();
  return guardedStore(raw, raw.root);
}

export function assertAsideSnapshotEntry(entry: JournalEntry): void {
  if (!entry || entry.clientId !== "aside" || typeof entry.opId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.opId) || !entry.snapshot
    || !["none", "stored", "expired"].includes(entry.snapshot.kind)
    || (entry.snapshot.kind === "stored" && entry.snapshot.relPath !== join("snapshots", "aside", entry.opId))) {
    throw new AsideProfileError("aside_operation_invalid", 409, "Aside operation snapshot metadata is invalid");
  }
}

export function createAsideProfileContext(input: AsideProfilesInput): AsideProfileContext {
  let profiles: AsideProfile[];
  try { profiles = listAsideProfiles(input.env, input.home); }
  catch (error) {
    if (error instanceof ClientPathError) throw new AsideProfileError("aside_profiles_unavailable", 409, error.message);
    throw new AsideProfileError("aside_profiles_unavailable", 409, "Aside profiles cannot be read");
  }
  const rootStore = asideRootStore(input);
  const record = rootStore.readRecords().aside;
  const matched = record?.clientId === "aside" ? profiles.find(profile => profile.configPath === record.configPath) : undefined;
  const pinned = input.config.asideProfileSync?.legacyProfileId;
  const newest = !record && pinned === undefined ? rootStore.listOperations("aside", 1)[0] : undefined;
  const legacyProfileId = pinned !== undefined ? pinned : record
    ? matched?.id ?? null
    : profiles.find(profile => profile.configPath === newest?.configPath)?.id ?? null;
  let loaded: Promise<readonly ExportModel[]> | undefined;
  return {
    input: { ...input, env: { ...(input.env ?? process.env) } }, profiles, rootStore, legacyProfileId, scopes: new Map(),
    defaultEnabled: input.config.asideProfileSync?.allProfiles ?? Boolean(matched),
    models: () => loaded ??= Promise.resolve().then(() => typeof input.models === "function" ? input.models() : input.models),
  };
}

export function selectAsideProfiles(ctx: AsideProfileContext, profileId?: number): AsideProfile[] {
  if (profileId === undefined) return ctx.profiles;
  if (!Number.isSafeInteger(profileId) || profileId < 0 || Object.is(profileId, -0)) {
    throw new AsideProfileError("invalid_aside_profile", 400, "Aside profile must be a nonnegative safe integer");
  }
  const profile = ctx.profiles.find(candidate => candidate.id === profileId);
  if (!profile) throw new AsideProfileError("aside_profile_not_found", 404, "Aside profile is not registered");
  return [profile];
}

export function asideProfileEnabled(ctx: AsideProfileContext, id: number): boolean {
  return ctx.input.config.asideProfileSync?.profiles?.[String(id)] ?? ctx.defaultEnabled;
}

export function asideProfileScope(ctx: AsideProfileContext, profile: AsideProfile): AsideProfileScope {
  try { return resolveScope(ctx, profile); }
  catch (error) {
    if (error instanceof ClientPathError) throw new AsideProfileError("aside_profile_unsafe", 409, error.message);
    throw error;
  }
}

function resolveScope(ctx: AsideProfileContext, profile: AsideProfile): AsideProfileScope {
  const cached = ctx.scopes.get(profile.id);
  if (cached) { cached.assertBoundary(); return cached; }
  assertAsideProfileBoundary(profile, ctx.profiles);
  const store = profile.id === ctx.legacyProfileId ? ctx.rootStore
    : guardedStore(createIntegrationStateStore(join(ctx.rootStore.root, "aside-profiles", String(profile.id))), ctx.rootStore.root);
  const assertBoundary = () => {
    assertAsideProfileBoundary(profile, ctx.profiles);
    const record = store.readRecords().aside;
    if (record && (record.clientId !== "aside" || record.configPath !== profile.configPath)) {
      throw new AsideProfileError("aside_profile_owner_mismatch", 409, "Aside ownership belongs to a different profile");
    }
  };
  assertBoundary();
  const baseIO = ctx.input.io ?? store.io();
  const guarded = guardAsideProfileIO(profile, {
    ...baseIO,
    appendJournal: entry => store.appendJournal(entry),
    putRecord: record => store.putRecord(record),
    dropRecord: clientId => store.dropRecord(clientId),
  }, ctx.profiles);
  const io: IntegrationIO = {
    ...guarded,
    writeText: (path, text) => { assertBoundary(); guarded.writeText(path, text); },
    removeFile: path => { assertBoundary(); guarded.removeFile(path); },
    mkdirp: path => { assertBoundary(); guarded.mkdirp(path); },
  };
  const scope = { profile, store, io, assertBoundary };
  ctx.scopes.set(profile.id, scope);
  return scope;
}

export async function asideWriteInput(ctx: AsideProfileContext, scope: AsideProfileScope): Promise<IntegrationWriteInput> {
  const models = await ctx.models();
  scope.assertBoundary();
  return {
    clientId: "aside", config: ctx.input.config, models, port: ctx.input.port,
    env: ctx.input.env, home: ctx.input.home, store: scope.store, io: scope.io,
    resolvedPaths: { configPath: scope.profile.configPath, detectDir: scope.profile.detectDir },
  };
}

/** Save intent first; an unsuccessful save must not leave even in-memory intent changed. */
export async function persistAsidePolicy(ctx: AsideProfileContext, change?: { enabled: boolean; profileId?: number }): Promise<void> {
  const { config, persistConfig } = ctx.input;
  if (!persistConfig) throw new AsideProfileError("aside_profile_persistence_required", 500, "Aside profile changes require configuration persistence");
  const previous = config.asideProfileSync;
  const policy: AsideProfilePolicy = {
    ...previous, allProfiles: ctx.defaultEnabled, legacyProfileId: ctx.legacyProfileId,
    profiles: { ...previous?.profiles },
  };
  if (change && change.profileId === undefined) {
    policy.allProfiles = change.enabled;
    policy.profiles = {};
  } else if (change) policy.profiles![String(change.profileId)] = change.enabled;
  config.asideProfileSync = policy;
  try { await persistConfig(config); }
  catch {
    if (previous === undefined) delete config.asideProfileSync;
    else config.asideProfileSync = previous;
    throw new AsideProfileError("aside_profile_persist_failed", 500, "Aside profile preferences could not be saved; no profile files were changed");
  }
  ctx.defaultEnabled = policy.allProfiles!;
}

export async function runAsideProfileAction<T>(
  input: AsideProfilesInput,
  profileId: number | undefined,
  semantics: string,
  action: (ctx: AsideProfileContext, profiles: AsideProfile[]) => Promise<T>,
): Promise<T> {
  const ctx = createAsideProfileContext(input);
  const profiles = selectAsideProfiles(ctx, profileId);
  const key = `aside:${fingerprint(`${ctx.rootStore.root}:${profiles.map(p => p.root).join(",")}`)}:${profiles.map(p => p.id).sort((a, b) => a - b).join(",")}:${semantics}:${crypto.randomUUID()}`;
  try {
    return await runIntegrationMutationFlight("aside", key, input.io?.now ?? Date.now, async () => {
      // Publish the flight before invoking user-supplied persistence callbacks.
      await Promise.resolve();
      return action(ctx, profiles);
    });
  } catch (error) {
    if (error instanceof IntegrationMutationBusyError) {
      throw new AsideProfileError("integration_mutation_busy", 409, "An Aside profile operation is already running");
    }
    if (error instanceof AsideProfileError) throw error;
    if (error instanceof ClientPathError) throw new AsideProfileError("aside_profile_unsafe", 409, error.message);
    throw new AsideProfileError("aside_profile_operation_failed", 500, "Aside profile operation could not be completed");
  }
}

export function asideProfileFailure(profileId: number, error: unknown): AsideProfileWriteOutcome {
  return {
    clientId: "aside", profileId, ok: false, reason: "unsafe", state: "unsafe",
    message: error instanceof AsideProfileError || error instanceof ClientPathError
      ? error.message : "Aside profile could not be updated safely",
  };
}

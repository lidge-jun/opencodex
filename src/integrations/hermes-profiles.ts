/**
 * Hermes profiles: where each Hermes bot keeps its own config.yaml.
 *
 * Hermes gives every profile its own home. The default profile is the home
 * OpenCodex has always written (`HERMES_HOME`, else `%LOCALAPPDATA%\hermes` on
 * Windows, else `~/.hermes`); a named profile is `<root>/profiles/<name>/`, and
 * Hermes selects it by running with `HERMES_HOME` pointed at that directory.
 *
 * The rules below mirror Hermes itself (NousResearch/hermes-agent
 * `hermes_constants.py`: `PROFILE_ID_RE`, `_PROFILE_IDENTITY_MARKERS`,
 * `profile_tombstone_path`, `_hermes_root_of`), so this lists exactly the
 * profiles `hermes profile list` shows and never a cache or log directory that
 * happens to sit under `profiles/`.
 *
 * Each named profile keeps its own ownership store under
 * `<integrations>/hermes-profiles/<name>/`, so its records, journal and snapshots
 * can never be confused with the default profile's.
 */
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hermesHomeDir } from "../clients/config-export";
import { createIntegrationStateStore, type IntegrationStateStore } from "./store";
import type { ResolvedIntegrationPaths } from "./registry";

export const HERMES_DEFAULT_PROFILE = "default";
/** Hermes `PROFILE_ID_RE`: the only names Hermes itself creates or lists. */
export const HERMES_PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Hermes `_PROFILE_IDENTITY_MARKERS`: a directory without one is not a profile. */
const IDENTITY_MARKERS = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"] as const;
const TOMBSTONE_DIR = ".deleted";
export const HERMES_PROFILE_STORE_DIR = "hermes-profiles";

export interface HermesProfile {
  /** `default`, or the directory name under `<root>/profiles`. */
  name: string;
  /** The HERMES_HOME Hermes runs this profile with. */
  home: string;
  configPath: string;
}

export class HermesProfileError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "HermesProfileError";
  }
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw new HermesProfileError("hermes_profiles_unavailable", 409, "Hermes profiles cannot be read");
  }
}

function isWithin(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function samePath(a: string, b: string): boolean {
  return relative(resolve(a), resolve(b)) === "";
}

/**
 * The Hermes root that holds `profiles/`, as Hermes `_hermes_root_of` derives it:
 * no override, or an override inside the platform home, means the platform home;
 * `<root>/profiles/<name>` means `<root>`; any other override is its own root.
 */
export function hermesRootDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const { HERMES_HOME: _ignored, ...withoutOverride } = env;
  const native = hermesHomeDir(withoutOverride, home);
  const override = env.HERMES_HOME?.trim();
  if (!override) return native;
  if (isWithin(native, override)) return native;
  return basename(dirname(override)) === "profiles" ? dirname(dirname(override)) : override;
}

function profileOf(name: string, profileHome: string): HermesProfile {
  return { name, home: profileHome, configPath: join(profileHome, "config.yaml") };
}

/**
 * The default profile first, then every live named profile, sorted by name.
 *
 * A named profile must be a real directory: a symbolic link or junction under
 * `profiles/` is skipped, because writing through it would edit a file outside
 * the Hermes root. A profile whose home IS the default home (HERMES_HOME pointed
 * at a profile) is listed once, as the default.
 */
export function listHermesProfiles(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): HermesProfile[] {
  const defaultHome = hermesHomeDir(env, home);
  const profiles = [profileOf(HERMES_DEFAULT_PROFILE, defaultHome)];
  const profilesDir = join(hermesRootDir(env, home), "profiles");
  const rootStat = lstatOrNull(profilesDir);
  if (!rootStat?.isDirectory()) return profiles;
  let names: string[];
  try { names = readdirSync(profilesDir); }
  catch { throw new HermesProfileError("hermes_profiles_unavailable", 409, "Hermes profiles cannot be read"); }
  for (const name of names.sort()) {
    if (name === HERMES_DEFAULT_PROFILE || !HERMES_PROFILE_ID_RE.test(name)) continue;
    const profileHome = join(profilesDir, name);
    const stat = lstatOrNull(profileHome);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    const hasIdentity = IDENTITY_MARKERS.some(marker => {
      const markerStat = lstatOrNull(join(profileHome, marker));
      return markerStat !== null && (markerStat.isFile() || markerStat.isSymbolicLink());
    });
    if (!hasIdentity || lstatOrNull(join(profilesDir, TOMBSTONE_DIR, name)) !== null) continue;
    if (samePath(profileHome, defaultHome)) continue;
    profiles.push(profileOf(name, profileHome));
  }
  return profiles;
}

/** An operator-selected profile, or a refusal that names why. */
export function resolveHermesProfile(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): HermesProfile {
  // The default profile is the home OpenCodex has always used; it never depends on its siblings.
  if (name === HERMES_DEFAULT_PROFILE) return profileOf(HERMES_DEFAULT_PROFILE, hermesHomeDir(env, home));
  if (!HERMES_PROFILE_ID_RE.test(name)) {
    throw new HermesProfileError("invalid_hermes_profile", 400, "Hermes profile names use lowercase letters, digits, '-' and '_'");
  }
  const profile = listHermesProfiles(env, home).find(candidate => candidate.name === name);
  if (!profile) throw new HermesProfileError("hermes_profile_not_found", 404, "Hermes profile is not present");
  return profile;
}

/** The environment Hermes runs this profile with. The default profile changes nothing. */
export function hermesProfileEnv(profile: HermesProfile, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return profile.name === HERMES_DEFAULT_PROFILE ? env : { ...env, HERMES_HOME: profile.home };
}

export function hermesProfilePaths(profile: HermesProfile): ResolvedIntegrationPaths {
  return { configPath: profile.configPath, detectDir: profile.home };
}

function unsafe(message: string): never {
  throw new HermesProfileError("hermes_profile_unsafe", 409, message);
}

/** `dev:ino` of a real directory, null when it does not exist; a link or junction is refused. */
function realDirectoryKey(path: string): string | null {
  const stat = lstatOrNull(path);
  if (stat === null) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) unsafe("A Hermes profile path is a link or not a directory");
  return `${stat.dev}:${stat.ino}`;
}

/**
 * Pin a named profile's directories and owner, and return the check that proves
 * they still hold.
 *
 * Discovery happens before the model roster loads, and the write happens after.
 * The check runs again immediately before the write: the `profiles` directory and
 * the profile home must be the same real directories (never a link or junction
 * swapped in meanwhile), the profile must not have been deleted, the ownership
 * store must not be a link, and an existing ownership record must name this
 * profile's config.yaml. The last rule matters when HERMES_HOME moves: a profile
 * of the same name under another Hermes root shares the store name, and must not
 * inherit or overwrite the original profile's ownership.
 */
export function hermesProfileBoundary(profile: HermesProfile, store: IntegrationStateStore): () => void {
  const profilesDir = dirname(profile.home);
  const pinned = [profilesDir, profile.home].map(path => ({ path, key: realDirectoryKey(path) }));
  if (pinned.some(entry => entry.key === null)) {
    throw new HermesProfileError("hermes_profile_not_found", 404, "Hermes profile is not present");
  }
  const check = () => {
    for (const { path, key } of pinned) {
      if (realDirectoryKey(path) !== key) unsafe("The Hermes profile directory changed while this change was prepared");
    }
    if (lstatOrNull(join(profilesDir, TOMBSTONE_DIR, profile.name)) !== null) {
      throw new HermesProfileError("hermes_profile_not_found", 404, "Hermes profile was deleted");
    }
    realDirectoryKey(dirname(store.root));
    realDirectoryKey(store.root);
    const owner = store.readRecords().hermes;
    if (owner && owner.configPath !== profile.configPath) {
      throw new HermesProfileError("hermes_profile_owner_mismatch", 409,
        "This profile's OpenCodex ownership names a Hermes file in another Hermes home; disconnect it there first");
    }
  };
  check();
  return check;
}

/**
 * The store a request uses for a named profile: every method first proves the pinned boundary
 * still holds, synchronously, at the moment it touches the store. A read that retries snapshot
 * maintenance, a journal tombstone, a prune and a writer commit are all covered the same way, so no
 * await between scope creation and use can leave a swapped directory unchecked.
 */
export function guardedHermesProfileStore(store: IntegrationStateStore, holds: () => void): IntegrationStateStore {
  const guarded: IntegrationStateStore = new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      // io() closes over the raw store; route its bookkeeping back through this facade.
      if (property === "io") {
        return () => {
          holds();
          return {
            ...target.io(),
            appendJournal: (entry: Parameters<IntegrationStateStore["appendJournal"]>[0]) => guarded.appendJournal(entry),
            putRecord: (record: Parameters<IntegrationStateStore["putRecord"]>[0]) => guarded.putRecord(record),
            dropRecord: (clientId: Parameters<IntegrationStateStore["dropRecord"]>[0]) => guarded.dropRecord(clientId),
          };
        };
      }
      return (...args: unknown[]) => {
        holds();
        return Reflect.apply(value, target, args);
      };
    },
  });
  return guarded;
}

/** A named profile's ownership store; the default profile keeps the root store. */
export function hermesProfileStore(root: IntegrationStateStore, name: string): IntegrationStateStore {
  if (name === HERMES_DEFAULT_PROFILE) return root;
  if (!HERMES_PROFILE_ID_RE.test(name)) {
    throw new HermesProfileError("invalid_hermes_profile", 400, "Hermes profile names use lowercase letters, digits, '-' and '_'");
  }
  return createIntegrationStateStore(join(root.root, HERMES_PROFILE_STORE_DIR, name));
}

/**
 * Every persisted named-profile store, whether or not the profile still exists.
 * Uninstall needs the orphans too: a deleted profile's record is still proof of
 * what we wrote.
 */
export function listHermesProfileStores(root: IntegrationStateStore): Array<{ name: string; store: IntegrationStateStore }> {
  const directory = join(root.root, HERMES_PROFILE_STORE_DIR);
  if (realDirectoryKey(directory) === null) return [];
  let names: string[];
  try { names = readdirSync(directory); }
  catch { throw new HermesProfileError("hermes_profile_store_unsafe", 409, "Hermes profile ownership storage cannot be read"); }
  return names.sort().map(name => {
    if (name === HERMES_DEFAULT_PROFILE || !HERMES_PROFILE_ID_RE.test(name)) {
      throw new HermesProfileError("hermes_profile_store_unsafe", 409, "Hermes profile ownership storage names an invalid profile");
    }
    realDirectoryKey(join(directory, name));
    return { name, store: createIntegrationStateStore(join(directory, name)) };
  });
}

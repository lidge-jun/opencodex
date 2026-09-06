import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { IntegrationIO } from "../integrations/config-io";
import { asideHomeDir, ClientPathError } from "./config-export";

export interface AsideProfile {
  id: number;
  name?: string;
  current: boolean;
  root: string;
  configPath: string;
  detectDir: string;
}

const MAX_PROFILES = 128;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_LEAF_LINKS = 40;

function refuse(message: string): never {
  // Never include manifest contents or underlying filesystem error messages.
  throw new ClientPathError(`Aside profile: ${message}`);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspect(path: string, follow = false): Stats | null {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return refuse("a filesystem boundary could not be inspected.");
  }
}

function canonical(path: string): string {
  try { return realpathSync.native(path); } catch {
    return refuse("a filesystem boundary could not be resolved.");
  }
}

/** Resolve a peer's leaf link even when its final model file does not exist yet. */
function leafDestination(path: string): string | null {
  const visited = new Set<string>();
  while (inspect(path)?.isSymbolicLink()) {
    if (visited.has(path) || visited.size >= MAX_LEAF_LINKS) refuse("an account catalog has a cyclic or excessive link chain.");
    visited.add(path);
    try { path = resolve(dirname(path), readlinkSync(path)); } catch {
      return refuse("an account catalog link could not be inspected.");
    }
  }
  if (!inspect(dirname(path), true)?.isDirectory()) return null;
  return join(canonical(dirname(path)), basename(path));
}

function readProfiles(root: string): AsideProfile[] {
  const rootStat = inspect(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    refuse("the configured root is missing or is not a safe directory.");
  }
  const manifest = join(root, "accounts.json");
  const manifestStat = inspect(manifest);
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()
    || manifestStat.size > MAX_MANIFEST_BYTES) {
    refuse("the account manifest is missing, unreadable or unsafe. Launch Aside to create it.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(manifest, "utf8")); } catch {
    return refuse("the account manifest is not readable JSON.");
  }
  if (!object(parsed) || !isId(parsed.currentAccountId)) {
    refuse("the account manifest has no valid current account ID.");
  }
  const currentId = parsed.currentAccountId;
  const accounts: unknown = Object.hasOwn(parsed, "accounts") ? parsed.accounts : [{ id: currentId }];
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > MAX_PROFILES) {
    refuse("the account manifest must contain between 1 and 128 accounts.");
  }
  const ids = new Set<number>();
  const profiles = accounts.map((account: unknown): AsideProfile => {
    if (!object(account) || !isId(account.id) || ids.has(account.id)) {
      return refuse("the account manifest contains an invalid or duplicate account ID.");
    }
    const current = account.id === currentId;
    if (Object.hasOwn(account, "current") && account.current !== current) {
      refuse("the account manifest has inconsistent current account metadata.");
    }
    ids.add(account.id);
    const detectDir = join(root, "u", String(account.id));
    return {
      id: account.id,
      ...(typeof account.name === "string" ? { name: account.name } : {}),
      current, root, detectDir, configPath: join(detectDir, "models.json"),
    };
  });
  if (!ids.has(currentId)) refuse("the current account is not registered in the account manifest.");
  return profiles;
}

/** Enumerate account catalogs; browser bindings and session data are never projected. */
export function listAsideProfiles(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): AsideProfile[] {
  const root = asideHomeDir(env, home);
  if (!isAbsolute(root)) refuse("the configured root must be absolute.");
  return readProfiles(root);
}

type DirectoryIdentity = { path: string; dev: number; ino: number };
type Boundary = Array<DirectoryIdentity | null>;

function sameIdentity(a: Pick<Stats, "dev" | "ino">, b: Pick<Stats, "dev" | "ino">): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function validatePaths(profile: AsideProfile): void {
  if (!isId(profile.id) || !isAbsolute(profile.root) || resolve(profile.root) !== profile.root
    || profile.detectDir !== join(profile.root, "u", String(profile.id))
    || profile.configPath !== join(profile.detectDir, "models.json")) {
    refuse("the selected account paths are invalid.");
  }
}

function registeredProfiles(profile: AsideProfile, profiles?: AsideProfile[]): AsideProfile[] {
  validatePaths(profile);
  const registered = profiles ?? readProfiles(profile.root);
  if (registered.length === 0 || registered.length > MAX_PROFILES) refuse("the account list is invalid.");
  const ids = new Set<number>();
  for (const peer of registered) {
    validatePaths(peer);
    if (peer.root !== profile.root || ids.has(peer.id)) refuse("the account list has conflicting paths.");
    ids.add(peer.id);
  }
  if (!ids.has(profile.id)) refuse("the selected account is not registered.");
  return registered;
}

function boundary(profile: AsideProfile, profiles: AsideProfile[], mutation: boolean): Boundary {
  const directories = [profile.root, join(profile.root, "u"), profile.detectDir];
  const identities: Boundary = [];
  let parent: string | undefined;
  let absent = false;
  for (const [index, directory] of directories.entries()) {
    const stats = absent ? null : inspect(directory);
    if (!stats) {
      if (index === 0 || mutation) refuse("the account directory is not installed; it will not be created.");
      absent = true;
      identities.push(null);
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) refuse("an account directory is a link or is unsafe.");
    const path = canonical(directory);
    // Aliases ABOVE the chosen root (notably macOS /var) are valid.
    const child = index === 1 ? "u" : String(profile.id);
    if (parent && path !== join(parent, child)) refuse("an account directory resolves outside its boundary.");
    identities.push({ path, dev: stats.dev, ino: stats.ino });
    parent = path;
  }
  if (absent) return identities;
  const leaf = inspect(profile.configPath);
  if (leaf && (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink > 1)) {
    refuse("the model catalog is a link, shared file or non-regular file.");
  }
  if (leaf && canonical(profile.configPath) !== join(parent!, "models.json")) {
    refuse("the model catalog resolves outside its account directory.");
  }
  const account = identities[2]!;
  for (const peer of profiles) {
    if (peer.id === profile.id) continue;
    // Follow peers only for identity comparison, never for content or writes.
    // This also detects a sibling symlink pointing BACK at this safe target.
    const peerDirectory = inspect(peer.detectDir, true);
    if (peerDirectory && sameIdentity(account, peerDirectory)) refuse("account directories share a target.");
    if (!peerDirectory?.isDirectory()) continue;
    if (inspect(peer.configPath)?.isSymbolicLink()
      && leafDestination(peer.configPath) === join(parent!, "models.json")) {
      refuse("account catalogs share a target.");
    }
    const peerLeaf = inspect(peer.configPath, true);
    if (leaf && peerLeaf && sameIdentity(leaf, peerLeaf)) refuse("account catalogs share a target.");
  }
  return identities;
}

/** Missing account directories are readable as not installed, but never writable. */
export function assertAsideProfileBoundary(profile: AsideProfile, profiles?: AsideProfile[], mutation = false): void {
  boundary(profile, registeredProfiles(profile, profiles), mutation);
}

/**
 * Pin directories for one status/write operation, retaining the caller's IO and store.
 * Rechecks complement atomic writes; they do not defeat a hostile same-user process
 * racing every filesystem syscall. Leaf inodes may change during our atomic writes.
 */
export function guardAsideProfileIO(profile: AsideProfile, io: IntegrationIO, profiles?: AsideProfile[]): IntegrationIO {
  const selected = { ...profile };
  const registered = registeredProfiles(selected, profiles).map(peer => ({ ...peer }));
  const captured = boundary(selected, registered, false);
  function check(path: string, directory: boolean, mutation: boolean): void {
    if (path !== (directory ? selected.detectDir : selected.configPath)) {
      refuse("IO attempted to access a different account path.");
    }
    const current = boundary(selected, registered, mutation);
    if (current.some((item, index) => {
      const prior = captured[index];
      return item === null || prior == null ? item !== prior : item.path !== prior.path || !sameIdentity(item, prior);
    })) refuse("the account directory changed after the operation began.");
  }
  return {
    readText: path => { check(path, false, false); return io.readText(path); },
    statKind: path => { check(path, path === selected.detectDir, false); return io.statKind(path); },
    writeText: (path, text) => { check(path, false, true); io.writeText(path, text); },
    removeFile: path => { check(path, false, true); io.removeFile(path); },
    mkdirp: path => { check(path, true, true); io.mkdirp(path); },
    now: () => io.now(),
    appendJournal: entry => io.appendJournal(entry),
    putRecord: record => io.putRecord(record),
    dropRecord: clientId => io.dropRecord(clientId),
  };
}

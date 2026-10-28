import { watch, lstatSync, readdirSync, type FSWatcher } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { getConfigDir } from "../config/paths";
import { readUnderCredentialPublicationFence } from "./publication-fence";
import { getCodexHome } from "../codex/paths";
import { readBounded, nativeProfileHomeId, countLocalNativeProfileSlots } from "../codex/native-profile-store";
import { countLocalOAuthCredentialSlots } from "../oauth/store";
import { inspectLocalCodexCredentialSlots } from "../codex/account-store";
import {
  claimCredentialObservation, generationToken, observationAlive, readCredentialGeneration,
  registerCredentialObserver, updateCredentialObservation,
} from "./generation";

/**
 * This installation's stored provider credentials, counted passively: OAuth accounts (with the
 * pre-multiauth backup), provider API-key slots including disabled and private references, Codex
 * pool records, native Codex auth and inactive native profiles. Link, management and incoming API
 * keys are not provider credentials and never count. Any unreadable or unfamiliar source throws,
 * so a caller omits the attestation instead of reporting zero.
 */
export type LocalCredentialSnapshot = { count: number; generation: string };
const RECONCILE_RETRIES = 20;
const RECONCILE_RETRY_MS = 100;
const FENCED_READ_ATTEMPTS = 40;
const FENCED_READ_RETRY_MS = 50;
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_BYTES = 4 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid credential object");
  return value as Record<string, unknown>;
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
function assertParents(path: string): void {
  for (let p = dirname(path); ; p = dirname(p)) {
    try { const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe credential parent"); }
    catch (error) { if (!missing(error)) throw error; }
    if (p === parse(p).root) break;
  }
}
export function scanLocalCredentials(accounts: readonly string[] = []): { count: number; vector: string; targets: string[] } {
  const home = getConfigDir();
  const codex = getCodexHome();
  const vector: string[] = [];
  const targets = new Set<string>();
  function bytes(path: string, limit = MAX_BYTES): Buffer | null {
    path = resolve(path);
    targets.add(path);
    assertParents(path);
    try {
      const before = lstatSync(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) throw new Error("Unsafe credential file");
      const raw = readBounded(path, limit);
      const after = lstatSync(path, { bigint: true });
      const identity = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
      if (identity(before) !== identity(after)) throw new Error("Credential changed while reading");
      vector.push(`${path}:${identity(after)}`);
      return raw;
    } catch (error) {
      if (!missing(error)) throw error;
      vector.push(`${path}:absent`);
      return null;
    }
  }
  function json(path: string): Record<string, unknown> | null {
    const raw = bytes(path);
    return raw === null ? null : object(JSON.parse(decoder.decode(raw)));
  }
  function emptyDirectory(path: string, child?: string): void {
    targets.add(path);
    assertParents(path);
    if (!exists(path)) { vector.push(`${path}:absent`); return; }
    const s = lstatSync(path, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe credential directory");
    const names = readdirSync(path);
    vector.push(`${path}:${s.dev}:${s.ino}:${JSON.stringify(names.sort())}`);
    if (child !== undefined) {
      if (names.some(name => name !== child)) throw new Error("Unknown staging home");
      emptyDirectory(join(path, child));
    } else if (names.length) throw new Error("Pending credential directory");
  }
  for (const [root, prefixes] of [
    [home, ["auth.json.ocx.", "codex-accounts.json.ocx.", "config.json.ocx."]],
    [codex, ["auth.json.ocx."]],
  ] as const) {
    targets.add(join(root, "auth.json"));
    if (exists(root) && readdirSync(root).some(name => prefixes.some(prefix => name.startsWith(prefix)))) {
      throw new Error("Retained credential write residue");
    }
  }
  let count = countLocalOAuthCredentialSlots(json(join(home, "auth.json")))
    + countLocalOAuthCredentialSlots(json(join(home, "auth.json.pre-multiauth")));
  const configuredAccounts = new Set<string>();
  const config = json(join(home, "config.json"));
  if (config !== null) {
    const providers = object(config.providers ?? {});
    for (const row of Object.values(providers)) {
      const provider = object(row);
      const pool = provider.apiKeyPool ?? [];
      if (!Array.isArray(pool)) throw new Error("Invalid provider pool");
      const keys: string[] = [];
      const ids = new Set<string>();
      for (const value of pool) {
        const entry = object(value);
        if (typeof entry.id !== "string" || ids.has(entry.id) || typeof entry.key !== "string" || !entry.key) {
          throw new Error("Invalid provider key slot");
        }
        ids.add(entry.id);
        keys.push(entry.key);
      }
      if (provider.apiKey !== undefined) {
        if (typeof provider.apiKey !== "string") throw new Error("Invalid provider key");
        if (provider.apiKey && !keys.includes(provider.apiKey)) keys.push(provider.apiKey);
      }
      count += keys.length;
      for (const key of keys) {
        for (const prefix of ["keychain:", "gcp-sa:"]) if (key.startsWith(prefix)) {
          const account = key.slice(prefix.length);
          if (!account.trim()) throw new Error("Invalid private key reference");
          configuredAccounts.add(account);
        }
      }
    }
  }
  count += accounts.filter(a => !configuredAccounts.has(a)).length;
  const pool = inspectLocalCodexCredentialSlots(json(join(home, "codex-accounts.json")));
  count += pool.count;
  for (const path of pool.sourcePaths) if (json(path) === null) throw new Error("Missing source-backed credential");

  const tomlBytes = bytes(join(codex, "config.toml"), 1024 * 1024);
  const toml = tomlBytes === null ? {} : object(Bun.TOML.parse(decoder.decode(tomlBytes)));
  if (toml.cli_auth_credentials_store !== undefined && toml.cli_auth_credentials_store !== "file") {
    throw new Error("Native credential store is not file-backed");
  }
  for (const profile of Object.values(object(toml.profiles ?? {}))) {
    const mode = object(profile).cli_auth_credentials_store;
    if (mode !== undefined && mode !== "file") throw new Error("Profile credential store is not file-backed");
  }
  const auth = json(join(codex, "auth.json"));
  let main = 0;
  if (auth !== null) {
    if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) main = 1;
    if (auth.tokens !== undefined && auth.tokens !== null) {
      const tokens = object(auth.tokens);
      if (![tokens.access_token, tokens.refresh_token, tokens.id_token].some(v => typeof v === "string" && v)) {
        throw new Error("Invalid native token envelope");
      }
      main = 1;
    }
    if (!main) throw new Error("Unsupported native auth envelope");
  }
  const shared = join(codex, ".opencodex-native-main-profiles");
  const homeId = nativeProfileHomeId(codex);
  emptyDirectory(join(home, "native-main-profiles"));
  emptyDirectory(join(home, "native-main-profile-staging"), homeId);
  for (const suffix of ["journal", "recovery-block"]) {
    if (bytes(join(shared, `${homeId}.${suffix}.json`)) !== null) throw new Error("Pending native profile transaction");
  }
  const stages = json(join(shared, `${homeId}.stages.json`));
  if (stages !== null && (stages.version !== 1 || stages.homeId !== homeId
    || !Number.isSafeInteger(stages.revision) || Number(stages.revision) < 0
    || !Array.isArray(stages.stages) || stages.stages.length !== 0)) throw new Error("Pending native stage registry");
  const vault = json(join(shared, `${homeId}.vault.json`));
  const profiles = countLocalNativeProfileSlots(vault, homeId);
  if (profiles.active && !main) throw new Error("Active native profile has no readable auth");
  count += main + profiles.inactive;
  if (exists(shared)) {
    if (!lstatSync(shared).isDirectory() || lstatSync(shared).isSymbolicLink()) throw new Error("Unsafe native vault");
    const expected = new Set([`${homeId}.vault.json`, `${homeId}.stages.json`]);
    if (readdirSync(shared).some(name => !expected.has(name))) throw new Error("Unknown native profile metadata");
  }
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid credential count");
  return { count, vector: JSON.stringify(vector.sort()), targets: [...targets].sort() };
}
function snapshotOnce(home: string): LocalCredentialSnapshot | undefined {
  try {
    const before = readCredentialGeneration(home);
    if (!before?.coverage || before.pending.length || !observationAlive(before, home)) return undefined;
    const snapshot = scanLocalCredentials(before.keyAccounts);
    const after = readCredentialGeneration(home);
    if (!after?.coverage || after.pending.length || !observationAlive(after, home)
      || generationToken(before) !== generationToken(after)
      || before.coverage.owner !== after.coverage.owner
      || before.coverage.vector !== snapshot.vector || after.coverage.vector !== snapshot.vector) return undefined;
    return { count: snapshot.count, generation: generationToken(after) };
  } catch { return undefined; }
}

/**
 * The attestation for "ocx status --json". Each attempt holds the publication fence shared across
 * both generation reads and the scan, so no instrumented write can land in between; while a
 * publication holds it, retry briefly, then omit rather than attest a snapshot that could race.
 */
export async function collectLocalCredentials(): Promise<LocalCredentialSnapshot | undefined> {
  const home = getConfigDir();
  for (let attempt = 0; attempt < FENCED_READ_ATTEMPTS; attempt += 1) {
    const read = readUnderCredentialPublicationFence(home, () => snapshotOnce(home));
    if (read.kind === "read") return read.value;
    if (read.kind === "unavailable") return undefined;
    await new Promise(resolve => setTimeout(resolve, FENCED_READ_RETRY_MS));
  }
  return undefined;
}
export function startLocalCredentialObservation(): { stop(): void; reconcile(): void } {
  const home = getConfigDir();
  let watchers: FSWatcher[] = [];
  let owner: string | undefined;
  let releaseLease = () => {};
  let failed = false;
  let unregister = () => {};
  const fail = () => {
    if (failed) return;
    failed = true;
    if (retry) clearTimeout(retry);
    unregister();
    releaseLease();
    for (const watcher of watchers) watcher.close();
    if (owner) {
      try { updateCredentialObservation(home, owner, null); }
      catch { /* The kernel lease is already closed; a busy metadata writer cannot keep evidence alive. */ }
    }
  };
  const install = (targets: string[]) => {
    const watched = new Map<string, Set<string>>();
    for (const target of targets) {
      for (let path = target; dirname(path) !== path; path = dirname(path)) {
        const parent = dirname(path);
        if (!exists(parent)) continue;
        assertParents(path);
        const names = watched.get(parent) ?? new Set<string>();
        names.add(path.slice(parent.length + (parent.endsWith("/") || parent.endsWith("\\") ? 0 : 1)));
        watched.set(parent, names);
      }
    }
    const next: FSWatcher[] = [];
    try {
      for (const [parent, names] of watched) {
        const watcher = watch(parent, { persistent: false }, (_event, name) => {
          if (name === null) { fail(); return; }
          if (names.has(String(name)) || /^(auth|config|codex-accounts)\.json\.ocx\./.test(String(name))) reconcile();
        });
        watcher.on("error", fail);
        next.push(watcher);
      }
    } catch (error) { for (const watcher of next) watcher.close(); throw error; }
    const previous = watchers;
    watchers = next;
    for (const watcher of previous) watcher.close();
  };
  const observe = (keys: readonly string[]) => {
    const before = scanLocalCredentials(keys);
    install(before.targets);
    const after = scanLocalCredentials(keys);
    if (before.vector !== after.vector || JSON.stringify(before.targets) !== JSON.stringify(after.targets)) {
      throw new Error("Credential coverage changed during observer installation");
    }
    if (failed) throw new Error("Credential observation lost");
    return after.vector;
  };
  let retries = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const reconcile = () => {
    if (failed || !owner) return;
    try { updateCredentialObservation(home, owner, observe); retries = 0; }
    catch {
      // A peer holding the config lock only delays this; the stale vector withholds attestation meanwhile.
      if (++retries > RECONCILE_RETRIES) { fail(); return; }
      retry ??= setTimeout(() => { retry = undefined; reconcile(); }, RECONCILE_RETRY_MS);
      (retry as { unref?: () => void }).unref?.();
    }
  };
  try {
    const claim = claimCredentialObservation(home, observe);
    owner = claim.owner;
    releaseLease = claim.close;
    unregister = registerCredentialObserver(home, reconcile);
    return { stop: fail, reconcile };
  } catch (error) { fail(); throw error; }
}

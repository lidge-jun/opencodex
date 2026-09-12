import { randomUUID } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile, getConfigDir, getConfigPath, mutatePersistedConfig, readConfigDiagnostics, withConfigMutationLockSync } from "../config";
import { readAlivePid, readRuntimePort } from "../config/process-state";
import { getCodexHome } from "./paths";
import { advanceCodexCredentialMutationEpoch } from "./credential-mutation-epoch";
import { assertPlainLocalPath, ORCA_ACCOUNT_DIRECTORY, parseOrcaAuth, readBoundedLocalFile, readOrcaAuthSource, sameLocalPath } from "./orca-auth-source";

export class OrcaImportError extends Error {
  constructor(message: string) { super(message); this.name = "OrcaImportError"; }
}

export interface OrcaImportResult {
  mode: "preview" | "apply";
  discovered: number;
  eligible: number;
  imported: number;
  duplicates: number;
  invalid: number;
}

function optionalFile(path: string): string | undefined {
  try { return readBoundedLocalFile(path, 4 * 1024 * 1024); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new OrcaImportError("A target or main credential file is unreadable; import refused.");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OrcaImportError("Invalid existing account state; import refused.");
  return value as Record<string, unknown>;
}

function assertStopped(): void {
  let running = readAlivePid() !== null;
  const runtime = readRuntimePort();
  if (runtime) {
    try { process.kill(runtime.pid, 0); running = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") running = true; }
  }
  if (running) throw new OrcaImportError("Stop the opencodex proxy before applying an Orca import.");
}

function prepare(sourceDir: string, registryPath: string) {
  const configRaw = optionalFile(getConfigPath());
  if (!configRaw || readConfigDiagnostics().source !== "file") {
    throw new OrcaImportError("Initialize a valid opencodex configuration before importing.");
  }
  const config = object(JSON.parse(configRaw));
  const accounts = config.codexAccounts ?? [];
  if (!Array.isArray(accounts)) throw new OrcaImportError("Invalid existing account configuration.");
  const identities = new Set<string>();
  const configuredIds = new Set<string>();
  for (const entry of accounts) {
    const row = object(entry);
    if (typeof row.id === "string") configuredIds.add(row.id);
    if (row.chatgptAccountId !== undefined && typeof row.chatgptAccountId !== "string") throw new OrcaImportError("Invalid existing account identity.");
    if (typeof row.chatgptAccountId === "string" && row.chatgptAccountId) identities.add(row.chatgptAccountId);
  }
  const reservedIdentities = new Set(identities);
  const storedIdentityCounts = new Map<string, number>();
  const recoverable = new Map<string, { id: string; credential: Record<string, unknown> }>();
  const storePath = join(getConfigDir(), "codex-accounts.json");
  const storeRaw = optionalFile(storePath);
  const store = storeRaw === undefined ? {} : object(JSON.parse(storeRaw));
  for (const [id, entry] of Object.entries(store)) {
    const record = object(entry);
    // Retain orphan and tombstoned records; a credential is still evidence of identity.
    if (record.credential === undefined && typeof record.generation === "number") continue;
    const credential = object(record.credential ?? record);
    if (typeof credential.chatgptAccountId !== "string" || !credential.chatgptAccountId
      || typeof credential.accessToken !== "string" || typeof credential.refreshToken !== "string"
      || typeof credential.expiresAt !== "number") throw new OrcaImportError("Invalid existing credential store.");
    identities.add(credential.chatgptAccountId);
    storedIdentityCounts.set(credential.chatgptAccountId, (storedIdentityCounts.get(credential.chatgptAccountId) ?? 0) + 1);
    // A process can die after the credential rename but before config registration. Only
    // the untouched initial record emitted by this importer may finish that registration.
    // Older, validated, replaced, tombstoned, or independently owned orphans remain blockers.
    if (id.startsWith("orca-") && ORCA_ACCOUNT_DIRECTORY.test(id.slice(5)) && !configuredIds.has(id)
      && record.generation === 1 && record.codexValidationPending === true
      && record.deletedAt === undefined && record.replacedAt === undefined
      && record.lastCodexValidatedAt === undefined && record.lastCodexValidationStatus === undefined
      && record.lastCodexValidationError === undefined && record.lastCodexValidationTerminal === undefined
      && credential.refreshToken === "" && typeof credential.sourceAuthPath === "string"
      && typeof credential.sourceSubject === "string" && credential.sourceSubject) {
      recoverable.set(credential.chatgptAccountId, { id, credential });
    }
  }
  const mainRaw = optionalFile(join(getCodexHome(), "auth.json"));
  if (mainRaw !== undefined) {
    const main = object(JSON.parse(mainRaw));
    if (main.tokens !== undefined) {
      const identity = parseOrcaAuth(mainRaw, false).chatgptAccountId;
      identities.add(identity);
      reservedIdentities.add(identity);
    }
    else if (typeof main.OPENAI_API_KEY !== "string") throw new OrcaImportError("Main Codex identity is unknown; import refused.");
  }
  const root = assertPlainLocalPath(resolve(sourceDir));
  const directory = assertPlainLocalPath(join(root, "codex-accounts"));
  if (!lstatSync(directory).isDirectory()) throw new OrcaImportError("Invalid Orca data directory.");
  const registryRaw = readBoundedLocalFile(resolve(registryPath), 32 * 1024 * 1024);
  const registry = object(JSON.parse(registryRaw));
  const registered = object(registry.settings).codexManagedAccounts;
  if (!Array.isArray(registered) || registered.length > 1024) {
    throw new OrcaImportError("Invalid Orca account registry or account limit exceeded.");
  }
  const result: OrcaImportResult = { mode: "preview", discovered: registered.length, eligible: 0, imported: 0, duplicates: 0, invalid: 0 };
  const candidates: { credential: ReturnType<typeof readOrcaAuthSource>; recoverId?: string }[] = [];
  const sourceIds = new Set<string>();
  for (const entry of registered) {
    try {
      const row = object(entry);
      if (typeof row.id !== "string" || !ORCA_ACCOUNT_DIRECTORY.test(row.id)
        || typeof row.managedHomePath !== "string"
        || (row.managedHomeRuntime !== undefined && row.managedHomeRuntime !== "host")) {
        throw new Error("Unsupported Orca account entry.");
      }
      const home = join(directory, row.id, "home");
      if (!sameLocalPath(assertPlainLocalPath(row.managedHomePath), assertPlainLocalPath(home))) {
        throw new Error("Orca account home does not match the source directory.");
      }
      if (sourceIds.has(row.id)) { result.duplicates++; continue; }
      sourceIds.add(row.id);
      const credential = readOrcaAuthSource(join(home, "auth.json"));
      let recoverId: string | undefined;
      if (identities.has(credential.chatgptAccountId)) {
        const orphan = recoverable.get(credential.chatgptAccountId);
        if (orphan && !reservedIdentities.has(credential.chatgptAccountId)
          && storedIdentityCounts.get(credential.chatgptAccountId) === 1
          && sameLocalPath(orphan.credential.sourceAuthPath as string, credential.sourceAuthPath)
          && orphan.credential.sourceSubject === credential.sourceSubject) {
          recoverId = orphan.id;
          recoverable.delete(credential.chatgptAccountId);
        } else { result.duplicates++; continue; }
      }
      identities.add(credential.chatgptAccountId);
      candidates.push({ credential, recoverId });
      result.eligible++;
    } catch { result.invalid++; }
  }
  return { configRaw, registryRaw, storeRaw, storePath, store, candidates, result };

}

/** Offline, explicit-source import. The returned report deliberately contains no identities or paths. */
export function importOrcaAccounts(options: { sourceDir: string; registryPath: string; apply?: boolean }): OrcaImportResult {
  try {
    if (!options.apply) return prepare(options.sourceDir, options.registryPath).result;
    assertStopped();
    return withConfigMutationLockSync(() => {
      assertStopped();
      const state = prepare(options.sourceDir, options.registryPath);
      state.result.mode = "apply";
      if (!state.candidates.length) return state.result;
      const writesCredentials = state.candidates.some(candidate => candidate.recoverId === undefined);
      const additions = state.candidates.map(({ credential, recoverId }) => {
        let id = recoverId;
        if (id === undefined) {
          do { id = `orca-${randomUUID()}`; } while (state.store[id]);
          state.store[id] = { credential, generation: 1, codexValidationPending: true };
        }
        return { id, email: "", alias: "Orca account", isMain: false, chatgptAccountId: credential.chatgptAccountId };
      });
      // Re-read registry and sources immediately before publishing either target file.
      if (readBoundedLocalFile(resolve(options.registryPath), 32 * 1024 * 1024) !== state.registryRaw) {
        throw new OrcaImportError("Orca registry changed during import; retry.");
      }
      for (const { credential } of state.candidates) {
        if (JSON.stringify(readOrcaAuthSource(credential.sourceAuthPath)) !== JSON.stringify(credential)) {
          throw new OrcaImportError("Orca credentials changed during import; retry.");
        }
      }
      assertStopped();
      if (optionalFile(getConfigPath()) !== state.configRaw || optionalFile(state.storePath) !== state.storeRaw) {
        throw new OrcaImportError("Target accounts changed during import; retry.");
      }
      if (writesCredentials) atomicWriteFile(state.storePath, JSON.stringify(state.store, null, 2) + "\n");
      try {
        const outcome = mutatePersistedConfig(config => {
          if (optionalFile(getConfigPath()) !== state.configRaw) throw new OrcaImportError("Target configuration changed; retry.");
          config.codexAccounts = [...(config.codexAccounts ?? []), ...additions];
          return { changed: true, value: undefined };
        });
        if (outcome.status !== "committed") throw new OrcaImportError("Target configuration could not be committed.");
      } catch (error) {
        if (writesCredentials) {
          if (state.storeRaw === undefined) unlinkSync(state.storePath);
          else atomicWriteFile(state.storePath, state.storeRaw);
        }
        throw error;
      }
      advanceCodexCredentialMutationEpoch();
      state.result.imported = additions.length;
      return state.result;
    });
  } catch (error) {
    if (error instanceof OrcaImportError) throw error;
    throw new OrcaImportError("Orca import could not complete; verify source and target local account files.");
  }
}

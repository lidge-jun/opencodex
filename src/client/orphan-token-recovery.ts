import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, getConfigPath, readConfigDiagnostics, withConfigMutationLockSync } from "../config";
import { readConfigGenerationInCurrentMutationTransaction } from "../config/mutation-lock";
import { withConfigDirHardeningSettled } from "../config/paths";
import { readAlivePid, readRuntimePort } from "../config/process-state";
import { readDesktopDisconnectReceipt } from "../claude/desktop-remote-store";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { readServiceApiTokenState, serviceApiTokenFingerprint } from "../lib/service-secrets";
import { createLocalAttestationChallenge, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER, verifyLocalAttestationProof } from "../lib/local-management-attestation";
import { LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION } from "../lib/local-provider-reload-contract";
import { loopbackFamilyAvailability } from "../lib/loopback-family";
import { acquireOwnershipMutationLease } from "../service/ownership-mutation-lease.mjs";
import { serviceStatePaths } from "../service/state";
import { classifyHealthz, DEFAULT_PROBE_TIMEOUT_MS, loopbackProbeHosts, observeProxyLiveness, probeEndpointLiveness, probeHostname, proveLiveProxyOwnedByHome, START_OWNERSHIP_LIVENESS, type LiveProxy } from "../server/proxy-liveness";
import { directLocalHttpFetch } from "../server/direct-local-http";
import { configuredApiAuthToken, isApiAuthRequired } from "../server/auth-cors";
import { defaultProbeRunner, defaultRawProbeRunner, inspectServiceManagerInstallation, type ProbeDeps } from "../service-manager-probe";
import { endpointsToProve, everyEndpointProvenDownAsync } from "../cli/uninstall-plan";
import { withClientLifecycle, type ClientLifecycleLockDeps } from "./lifecycle-lock";
import { pendingClientConnectMayOwnToken, readClientConnectionState } from "./state";

export interface OrphanTokenRecoveryDeps {
  lifecycleLockDeps?: ClientLifecycleLockDeps;
  acquireLease?: () => { release(): void };
  /** Test seam: production uses the attested runtime and tri-state endpoint probes below. */
  runtimeSafe?: () => Promise<boolean>;
  /** Test seam: production checks installed and indeterminate service definitions. */
  inspectServiceManager?: typeof inspectServiceManagerInstallation;
  /** Exercise Windows handle ordering on other platforms; never set by the CLI. */
  windowsMoveForTest?: boolean;
  onWindowsHandlesClosed?: (fds: readonly number[]) => void;
}

function assertDisconnected(): void {
  if (readClientConnectionState().kind !== "disconnected") throw new Error("orphan recovery refused: client state is not disconnected");
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source === "fallback") throw new Error("orphan recovery refused: admission configuration is unverified; repair the configuration before retrying");
  if (diagnostics.config.runtimeRole === "hub") throw new Error("orphan recovery refused: this is a Hub; manage its admission secret through the Hub service instead");
  const runtime = readRuntimePort();
  if (isApiAuthRequired(diagnostics.config) || (runtime?.hostname && isApiAuthRequired({ hostname: runtime.hostname }))
    || configuredApiAuthToken() || process.env.OCX_API_TOKEN_FILE?.trim()) {
    throw new Error("orphan recovery refused: this installation may use an admission secret; inspect its bind and token configuration before retrying");
  }
  const token = readServiceApiTokenState();
  if (token.kind === "present" && diagnostics.config.apiKeys?.some(entry =>
    [entry.key, entry.pendingRotation?.key].some(value => value && serviceApiTokenFingerprint(value.trim()) === token.fingerprint))) {
    throw new Error("orphan recovery refused: the token matches a configured admission secret; inspect the API keys before retrying");
  }
  if (pendingClientConnectMayOwnToken()) throw new Error("orphan recovery refused: client connect is pending");
  const receipt = readDesktopDisconnectReceipt();
  if (receipt.kind === "unsafe" || (receipt.kind === "valid" && receipt.value.phase !== "complete")) {
    throw new Error("orphan recovery refused: disconnect is pending or unsafe");
  }
}

function assertNoServiceAdmission(inspect: typeof inspectServiceManagerInstallation): void {
  let service;
  try { service = inspect(); }
  catch { throw new Error("orphan recovery refused: service admission use is unverified; inspect the service configuration before retrying"); }
  if (service.kind !== "absent") {
    throw new Error("orphan recovery refused: an installed or unverified service may use the admission secret; inspect 'ocx service status' and remove or migrate the service before retrying");
  }
}

/** Unlike generic discovery, failure to launch a manager probe cannot prove token ownership absent. */
export function inspectOrphanServiceAdmission(deps: ProbeDeps = {}): ReturnType<typeof inspectServiceManagerInstallation> {
  const run = deps.run ?? defaultProbeRunner;
  const runRaw = deps.runRaw ?? defaultRawProbeRunner;
  return inspectServiceManagerInstallation({ ...deps,
    run: (...args) => { const result = run(...args); if (result.spawnFailed) throw new Error("service manager unavailable"); return result; },
    runRaw: (...args) => { const result = runRaw(...args); if (result.spawnFailed) throw new Error("service manager unavailable"); return result; },
  });
}

function configWitness(): { generation: number; digest: string | null } {
  let digest: string | null;
  try { digest = createHash("sha256").update(readFileSync(getConfigPath())).digest("hex"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    digest = null;
  }
  return { generation: readConfigGenerationInCurrentMutationTransaction().value, digest };
}

/** No null liveness result is treated as evidence of absence. The caller holds the start lease. */
async function runtimeIsSafe(): Promise<boolean> {
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source === "fallback") return false;
  const runtime = readRuntimePort();
  const observation = await observeProxyLiveness(START_OWNERSHIP_LIVENESS);
  const endpoints = endpointsToProve(runtime, diagnostics.config);
  if (observation.kind === "unknown") return false;
  if (observation.kind === "absent") return readAlivePid() === null && everyEndpointProvenDownAsync(endpoints, probeEndpointLiveness);
  const live = observation.live;
  if (!live) return false;
  if (live.role === "client" || !runtime || !runtime.hostname?.trim() || runtime.siblingOfPort !== undefined) return false;
  const observed = { ...live, hostname: live.probeHostname ?? live.hostname };
  if (await proveLiveProxyOwnedByHome(observed, START_OWNERSHIP_LIVENESS) !== "proven") return false;
  if (!await proveStandalone(observed, runtime)) return false;
  for (const host of loopbackProbeHosts(live.hostname)) {
    if (host === probeHostname(observed.hostname) || loopbackFamilyAvailability(host) === "unavailable") continue;
    const answer = await classifyHealthz(`http://${host}:${live.port}/healthz`, directLocalHttpFetch, START_OWNERSHIP_LIVENESS.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    if (answer === "unknown" || (answer === "live" && !await proveStandalone({ ...observed, hostname: host }, runtime))) return false;
  }
  const otherEndpoints = endpoints.filter(endpoint => endpoint.port !== live.port || probeHostname(endpoint.hostname) !== probeHostname(live.hostname));
  return otherEndpoints.length === 0 || everyEndpointProvenDownAsync(otherEndpoints, probeEndpointLiveness);
}

/** The client listener omits this standalone-only capability, including on legacy health bodies. */
async function proveStandalone(live: LiveProxy, runtime: NonNullable<ReturnType<typeof readRuntimePort>>): Promise<boolean> {
  if (live.pid === null || runtime.pid !== live.pid || runtime.port !== live.port || !runtime.attestationSecret) return false;
  try {
    const challenge = createLocalAttestationChallenge();
    const response = await directLocalHttpFetch(`http://${probeHostname(live.hostname)}:${live.port}/healthz`, {
      headers: { [LOCAL_ATTESTATION_CHALLENGE_HEADER]: challenge }, signal: AbortSignal.timeout(START_OWNERSHIP_LIVENESS.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    const body = await response.json() as { service?: unknown; pid?: unknown; port?: unknown; role?: unknown; providerReloadCapability?: unknown };
    return response.ok && body.service === "opencodex" && body.pid === live.pid && body.port === live.port
      && body.role !== "client" && body.providerReloadCapability === LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION
      && verifyLocalAttestationProof(runtime.attestationSecret, challenge, live.pid, live.port, response.headers.get(LOCAL_ATTESTATION_PROOF_HEADER))
      && JSON.stringify(readRuntimePort()) === JSON.stringify(runtime);
  } catch { return false; }
}

type OpenSource = { path: string; name: string; fd: number | null; dev: number; ino: number; hash: string };
type Sources = { home: string; dev: number; ino: number; entries: { path: string; name: string; source: OpenSource | null }[] };

function fingerprint(fd: number): string {
  // Read by descriptor with a hard cap even if a non-cooperating writer grows the file.
  const bytes = Buffer.alloc(4097);
  try {
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, used);
      if (count === 0) break;
      used += count;
    }
    if (used > 4096 || fstatSync(fd).size > 4096) throw new Error("orphan recovery refused: unsafe token file");
    return createHash("sha256").update(bytes.subarray(0, used)).digest("hex");
  } finally { bytes.fill(0); }
}

function openSource(path: string, name: string): OpenSource | null {
  let entry;
  try { entry = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (entry.isFile() && !entry.isSymbolicLink() && entry.nlink > 1) {
    // An interrupted Windows recovery leaves its identity pin linked to the original.
    throw new Error(`orphan recovery refused: unsafe token file (another hard link exists; an interrupted earlier recovery may have left a .${name}.identity pin in an orphaned-token-* backup folder. Remove such a pin only if it is a hard link of this token file and keep any other pin, then inspect any remaining hard links to this file before retrying)`);
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 4096
    || (process.platform !== "win32" && entry.uid !== process.getuid?.())) throw new Error("orphan recovery refused: unsafe token file");
  const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new Error("orphan recovery refused: token file changed");
    }
    return { path, name, fd, dev: opened.dev, ino: opened.ino, hash: fingerprint(fd) };
  } catch (error) { closeSync(fd); throw error; }
}

function readSources(): Sources {
  const home = getConfigDir();
  assertNotRealHomeUnderTest(home);
  const dirStat = lstatSync(home);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (process.platform !== "win32" && dirStat.uid !== process.getuid?.())) {
    throw new Error("orphan recovery refused: unsafe config directory");
  }
  const entries: Sources["entries"] = [];
  try {
    for (const name of ["service-api-token", "service-api-token.prev"]) {
      const path = join(home, name);
      entries.push({ path, name, source: openSource(path, name) });
    }
    if (!entries.some(entry => entry.source)) throw new Error("orphan recovery refused: no token files found");
    return { home, dev: dirStat.dev, ino: dirStat.ino, entries };
  } catch (error) {
    for (const entry of entries) if (entry.source?.fd != null) closeSync(entry.source.fd);
    throw error;
  }
}

function verifyPinnedFile(path: string, source: OpenSource): void {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 2 || entry.dev !== source.dev || entry.ino !== source.ino) {
    throw new Error("orphan recovery refused: token identity witness changed");
  }
  const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 2 || opened.dev !== source.dev || opened.ino !== source.ino || fingerprint(fd) !== source.hash) {
      throw new Error("orphan recovery refused: token identity witness changed");
    }
  } finally { closeSync(fd); }
}

/** Best effort: drop a pin only while another name still holds the original token. */
function releasePins(pins: Map<string, string>): void {
  for (const pin of pins.values()) {
    try { if (lstatSync(pin).nlink > 1) unlinkSync(pin); } catch { /* the refusal below still names the folder */ }
  }
}

function moveToPrivateBackup(sources: Sources, deps: OrphanTokenRecoveryDeps): { backupDir: string; files: string[] } {
  const home = getConfigDir();
  let backupDir: string | undefined;
  const pins = new Map<string, string>();
  try {
    const homeStat = lstatSync(home);
    if (home !== sources.home || !homeStat.isDirectory() || homeStat.isSymbolicLink()
      || homeStat.dev !== sources.dev || homeStat.ino !== sources.ino) throw new Error("orphan recovery refused: config directory changed");
    // Reopen and compare both names, including absence, after the asynchronous liveness probe.
    for (const entry of sources.entries) {
      const now = openSource(entry.path, entry.name);
      try {
        if (Boolean(now) !== Boolean(entry.source) || (now && entry.source
          && (now.dev !== entry.source.dev || now.ino !== entry.source.ino || now.hash !== entry.source.hash))) {
          throw new Error("orphan recovery refused: token file changed");
        }
      } finally { if (now?.fd != null) closeSync(now.fd); }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupDir = mkdtempSync(join(home, `orphaned-token-${stamp}-`));
    if (process.platform === "win32") hardenSecretDir(backupDir, { required: true });
    else chmodSync(backupDir, 0o700);
    const windowsMove = process.platform === "win32" || deps.windowsMoveForTest === true;
    if (windowsMove) {
      // A private hard link keeps each original file identity allocated after its Windows handle
      // closes. Thus the rename cannot substitute a recycled file ID without detection.
      for (const { source } of sources.entries) {
        if (!source || source.fd === null) continue;
        const pin = join(backupDir, `.${source.name}.identity`);
        linkSync(source.path, pin);
        pins.set(source.name, pin);
        if (process.platform === "win32") hardenSecretPath(pin, { required: true });
        const pinned = lstatSync(pin);
        const original = fstatSync(source.fd);
        if (!pinned.isFile() || pinned.nlink !== 2 || pinned.dev !== source.dev || pinned.ino !== source.ino
          || original.dev !== source.dev || original.ino !== source.ino || original.nlink !== 2) {
          throw new Error("orphan recovery refused: token file changed before move");
        }
        verifyPinnedFile(pin, source);
      }
      const closed: number[] = [];
      for (const { source } of sources.entries) {
        if (source?.fd == null) continue;
        closeSync(source.fd);
        closed.push(source.fd);
        source.fd = null;
      }
      deps.onWindowsHandlesClosed?.(closed);
    }
    for (const { source } of sources.entries) {
      if (!source) continue;
      if (process.platform !== "win32" && source.fd !== null) fchmodSync(source.fd, 0o600);
      const current = lstatSync(source.path);
      if (!current.isFile() || current.nlink !== (windowsMove ? 2 : 1) || current.dev !== source.dev || current.ino !== source.ino) {
        throw new Error("orphan recovery refused: token file changed");
      }
      const destination = join(backupDir, source.name);
      renameSync(source.path, destination);
      const moved = lstatSync(destination);
      if (!moved.isFile() || moved.dev !== source.dev || moved.ino !== source.ino) throw new Error("orphan recovery refused: token file changed during move");
      const pin = pins.get(source.name);
      if (pin) {
        const witness = lstatSync(pin);
        if (!witness.isFile() || witness.dev !== source.dev || witness.ino !== source.ino || witness.nlink !== 2 || moved.nlink !== 2) {
          throw new Error("orphan recovery refused: token identity witness changed");
        }
        verifyPinnedFile(destination, source);
        unlinkSync(pin);
        pins.delete(source.name);
      }
      if (process.platform === "win32") hardenSecretPath(destination, { required: true });
      const verified = openSource(destination, source.name);
      try {
        if (!verified || verified.dev !== source.dev || verified.ino !== source.ino || verified.hash !== source.hash) {
          throw new Error("orphan recovery refused: token file changed during move");
        }
      } finally { if (verified?.fd != null) closeSync(verified.fd); }
    }
    return { backupDir, files: sources.entries.filter(entry => entry.source).map(entry => entry.name) };
  } catch (error) {
    if (backupDir) {
      releasePins(pins);
      throw new Error(`orphan recovery incomplete; inspect private backup at ${JSON.stringify(backupDir)} before retrying`, { cause: error });
    }
    throw error;
  }
}

/** Preserve explicitly selected orphan candidates without asserting they belong to a link. */
export async function recoverOrphanedTokens(deps: OrphanTokenRecoveryDeps = {}): Promise<{ backupDir: string; files: string[] }> {
  const lease = (deps.acquireLease ?? (() => acquireOwnershipMutationLease(serviceStatePaths())))();
  try {
    return await withClientLifecycle(async () => {
      const prepared = withConfigMutationLockSync(() => {
        assertDisconnected();
        return { witness: configWitness(), runtime: JSON.stringify(readRuntimePort()), pid: readAlivePid(), sources: readSources() };
      });
      try {
        assertNoServiceAdmission(deps.inspectServiceManager ?? inspectOrphanServiceAdmission);
        if (!await (deps.runtimeSafe ?? runtimeIsSafe)()) throw new Error("orphan recovery refused: client runtime is live or runtime state is unverified");
        return await withConfigDirHardeningSettled(getConfigDir(), () => {
          assertNoServiceAdmission(deps.inspectServiceManager ?? inspectOrphanServiceAdmission);
          return withConfigMutationLockSync(() => {
            assertDisconnected();
            if (JSON.stringify(configWitness()) !== JSON.stringify(prepared.witness)) throw new Error("orphan recovery refused: config changed during liveness check");
            if (JSON.stringify(readRuntimePort()) !== prepared.runtime || readAlivePid() !== prepared.pid) throw new Error("orphan recovery refused: runtime changed during liveness check");
            return moveToPrivateBackup(prepared.sources, deps);
          });
        });
      } finally {
        for (const entry of prepared.sources.entries) if (entry.source?.fd != null) closeSync(entry.source.fd);
      }
    }, deps.lifecycleLockDeps);
  } finally { lease.release(); }
}

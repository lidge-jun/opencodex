import type { CodexCliApplyResult } from "./cli-update-apply";
import type { CodexCliUpdateJobDto } from "./cli-update-job";

export const CODEX_CLI_JOB_REASONS: ReadonlySet<string> = new Set(["invalid_plan_id", "windows_inspection_deferred", "windows_apply_disabled", "cancelled", "mutation_evidence_unverified",
  "installation_prefix_changed", "installation_prefix_unsupported", "installation_lease_unavailable", "installation_busy", "plan_refused", "plan_changed", "target_artifacts_unverified",
  "installation_changed", "installation_paths_untrusted", "staging_path_untrusted", "npm_unavailable", "blocked_process_state_unknown", "blocked_active_session",
  "installer_state_unknown", "version_process_state_unknown", "version_readback_unverified", "verified_target",
  "original_install_unchanged", "installation_readback_unverified", "installer_or_readback_error",
  "preparation_failed", "job_result_unknown", "not_managed", "installed_version_unverified",
  "install_content_unverified", "target_unresolved", "already_current", "target_not_newer"]);
export const CODEX_CLI_JOB_CLEANUP_ERRORS: ReadonlySet<string> = new Set(["lease_release_unverified", "lease_release_exception", "staging_cleanup_failed"]);

export class CodexCliJobStoreBusyError extends Error {
  constructor() { super("job_store_busy"); }
}
/** Durable ledger bounds and names shared by the POSIX and Windows store backends. */
export const CODEX_CLI_JOB_STORE_DIR = "codex-cli-update-jobs";
export const CODEX_CLI_JOB_STORE_FILE = "jobs.json";
export const CODEX_CLI_JOB_STORE_LOCK = "admission.lock";
export const CODEX_CLI_JOB_STORE_MAX_BYTES = 256 * 1024;
export class CodexCliJobResultPersistenceError extends Error {
  constructor(readonly result: CodexCliApplyResult) { super("job_result_persistence_failed"); }
}
export function normalizeCodexCliJobResult(result: CodexCliApplyResult): CodexCliApplyResult {
  const cleanup = Array.isArray(result.cleanupErrors) ? result.cleanupErrors : [];
  const safe = CODEX_CLI_JOB_REASONS.has(result.reason)
    && ["applied", "not_applied", "refused", "ambiguous"].includes(result.outcome)
    && typeof result.leaseRetained === "boolean" && Array.isArray(result.cleanupErrors)
    && cleanup.length <= 8 && cleanup.every(error => CODEX_CLI_JOB_CLEANUP_ERRORS.has(error));
  return safe ? result : { ...result, outcome: "ambiguous", reason: "job_result_unknown", leaseRetained: true,
    cleanupErrors: cleanup.filter(error => CODEX_CLI_JOB_CLEANUP_ERRORS.has(error)).slice(0, 8) };
}
export async function retryCodexCliJobStoreOperation<T>(operation: () => T,
  delay: (milliseconds: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  persistence = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const transientIo = persistence && ["EIO", "ENOSPC", "EBUSY", "EAGAIN", "EINTR", "EMFILE", "ENFILE"]
        .includes((error as NodeJS.ErrnoException)?.code ?? "");
      if (attempt === 7 || (!(error instanceof CodexCliJobStoreBusyError) && !transientIo)) throw error;
      await delay(25);
    }
  }
}
interface JobWork {
  begin(): number | Promise<number>;
  finish(revision: number, result: CodexCliApplyResult): CodexCliUpdateJobDto | null | Promise<CodexCliUpdateJobDto | null>;
  read(): CodexCliUpdateJobDto | null | Promise<CodexCliUpdateJobDto | null>;
  release(): void | Promise<void>;
}
/** Execution and persistence are separate ownership phases. */
export async function runCodexCliUpdateJobWork(run: () => Promise<CodexCliApplyResult>, work: JobWork): Promise<CodexCliUpdateJobDto | null> {
  let released = false;
  try {
    let revision: number;
    try { revision = await retryCodexCliJobStoreOperation(async () => work.begin()); }
    catch {
      await work.release(); released = true;
      try { return await work.read(); }
      catch (error) {
        const code = error instanceof Error ? error.message : "";
        throw new Error(["unsafe_store", "invalid_store", "unsupported_store"].includes(code) ? code : "job_state_unavailable");
      }
    }
    let result: CodexCliApplyResult;
    try { result = await run(); }
    catch {
      result = { outcome: "ambiguous", reason: "job_result_unknown", planId: "",
        installedVersion: null, targetVersion: null, installerExitCode: null, leaseRetained: true,
        verificationPid: null, cleanupErrors: [] };
    }
    try {
      return await retryCodexCliJobStoreOperation(async () => (await work.finish(revision, result)) ?? (await work.read()), undefined, true);
    } catch { throw new CodexCliJobResultPersistenceError(result); }
  } finally { if (!released) await work.release(); }
}

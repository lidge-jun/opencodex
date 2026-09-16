import { loadConfig } from "../../config";
import { shouldSyncCodexOnStart } from "../desired-state";
import { withCatalogWriteSerialization } from "../catalog-write-serialization";
import { restoreCodexCatalogWithPermit } from "../catalog/sync";
import { withCodexWriteLock, CodexWriteLockSkipped } from "../codex-write-lock";
import { inspectNativeCodexOwnership } from "../../integrations/native/ownership-preflight";
import { resolveCodexHistoryTransition } from "../history-transition";
import {
  captureCodexPreImages,
  codexWriteCoordinationEligibility,
  CodexPartialWriteError,
  CodexWriteConflictError,
  DEFAULT_INJECT_LOCK_TIMEOUT_MS,
  recordCodexNativeTransactionProvenance,
  restoreCodexPreImages,
} from "../inject-coordination";
import { readIntegrationRecord } from "../integration-record";
import { classifyNativeRoutedResidue } from "../native-residue";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../user-identity";
import {
  journaledInjectedCatalogPath,
  removeJournal,
  restoreJournalState,
} from "../journal";
import {
  preflightCodexHistoryInjection,
  syncCodexHistoryProvider,
  type CodexHistoryFailureReason,
} from "../history-provider";
import {
  describeHistoryJobFailure,
  deriveCodexHistoryOperation,
  resolveCodexHistoryJobTarget,
  runCodexHistoryJob,
  type CodexHistoryJobOutcome,
} from "../history-job";
import {
  DEFAULT_CATALOG_PATH,
  getCodexHome,
  tomlString,
} from "../paths";
import { shouldInjectApiAuthHeader } from "../loopback-target";
import { currentExternalCodexModelProvider } from "./config-toml";
import { removeCodexConfig } from "./remove";

class CodexRestoreRefusal extends Error {
  constructor(readonly config: CodexRestoreConfigResult) {
    super(config.message);
  }
}

let beforeRestoreConfigForTests: ((kind: string) => void) | undefined;
export function setBeforeRestoreConfigForTests(hook: typeof beforeRestoreConfigForTests): void {
  beforeRestoreConfigForTests = hook;
}

export type CodexRestoreArtifactState = "ok" | "skipped" | "failed";

export interface CodexRestoreConfigResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  action: "journal-restored" | "owned-fields-stripped" | "external-provider-preserved" | "failed";
  message: string;
}

export interface CodexRestoreCatalogResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  removed: number;
  kept: number;
  path: string | null;
  message: string;
}

export interface CodexRestoreHistoryResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  reason?: CodexHistoryFailureReason;
  rows: number;
  files: number;
  ejectedRows: number;
  message: string;
}

export interface CodexNativeRestoreResult {
  success: boolean;
  message: string;
  externalProvider?: string;
  /**
   * Set when the restore refused at the Codex history preflight (#4718).
   *
   * The preflight runs before the config half, so a refusal leaves config, catalog,
   * history and provenance exactly as they were. That is a different outcome from a
   * restore that ran and failed, and callers that decide whether an obligation was
   * discharged need to tell them apart. Reading the artifact states alone cannot: a
   * refusal reports every artifact as `skipped`, which is also what an ownership refusal
   * and a desired-state skip report. Matching the human-readable message instead would
   * make a safety decision depend on prose.
   */
  historyPreflightRefusal?: string;
  artifacts: {
    config: CodexRestoreConfigResult;
    catalog: CodexRestoreCatalogResult;
    history: CodexRestoreHistoryResult;
  };
}

function failedHistoryRestore(
  reason?: CodexHistoryFailureReason,
  detail?: string,
  progress: { rows?: number; files?: number } = {},
): CodexRestoreHistoryResult {
  const rows = progress.rows ?? 0;
  const files = progress.files ?? 0;
  const changed = rows > 0 || files > 0;
  return {
    state: "failed",
    changed,
    ...(reason ? { reason } : {}),
    rows,
    files,
    ejectedRows: 0,
    message: reason === "permission"
      ? changed
        ? "Codex resume history changed but did NOT converge because permission was denied while finalizing the backup manifest; the manifest was retained for review and safe retry."
        : "Codex resume history could NOT be restored because permission was denied."
      : reason === "busy"
        ? changed
          ? "Codex resume history changed but did NOT converge because backup-manifest finalization remained busy; the manifest was retained for review and safe retry."
          : detail ?? "Codex resume history could NOT be restored — the Codex app appears to be holding the history database."
        : reason === "integrity"
          ? changed
            ? "Codex resume history changed but did NOT converge because the backup or target changed; the manifest was retained for review and safe retry."
            : "Codex resume history could NOT be restored because the backup or restore target failed integrity checks; unverified provider metadata was left unchanged."
        : detail
          ? `Codex resume history could NOT be restored: ${detail}`
          : "Codex resume history could NOT be restored; the reason was not recorded. Run 'ocx doctor'.",
  };
}

/**
 * Restore failure wording for a Worker outcome.
 *
 * Only a genuine busy result blames the Codex app. An unsafe-path refusal, an
 * unavailable coordinator database, a permission denial, or a dead/timed-out
 * worker is a different problem; the old collapse made every one of those read
 * as "the Codex app is holding the database" (issue #1191). `busy` and
 * `permission` keep the restore-specific sentence built by
 * `failedHistoryRestore`; every other reason reuses the single formatter so
 * the two modules cannot drift apart.
 */
export function failedHistoryRestoreFromOutcome(
  outcome: Extract<CodexHistoryJobOutcome, { kind: "blocked" | "failed" }>,
): CodexRestoreHistoryResult {
  if (outcome.kind === "blocked" && outcome.reason === "busy") return failedHistoryRestore("busy");
  if (outcome.kind === "failed" && outcome.historyFailureReason === "busy") {
    return failedHistoryRestore(
      "busy",
      describeHistoryJobFailure(outcome, "restore"),
      { rows: outcome.rows, files: outcome.files },
    );
  }
  if (outcome.kind === "failed" && outcome.historyFailureReason === "permission") {
    return failedHistoryRestore("permission", undefined, { rows: outcome.rows, files: outcome.files });
  }
  if (outcome.kind === "failed" && outcome.historyFailureReason === "integrity") {
    return failedHistoryRestore("integrity", undefined, { rows: outcome.rows, files: outcome.files });
  }
  return failedHistoryRestore(undefined, describeHistoryJobFailure(outcome, "restore"));
}

function externalProviderRestoreResult(activeProvider: string): CodexNativeRestoreResult {
  const message = `External Codex provider ${tomlString(activeProvider)} preserved; no native restore was needed.`;
  return {
    success: true,
    message,
    externalProvider: activeProvider,
    artifacts: {
      config: { state: "skipped", changed: false, action: "external-provider-preserved", message },
      catalog: { state: "skipped", changed: false, removed: 0, kept: 0, path: null, message },
      history: { state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0, message },
    },
  };
}

/** A foreign service claim is an authority boundary, including explicit CLI restore. */
function foreignOwnershipRestoreRefusal(message: string): CodexNativeRestoreResult {
  return {
    success: false,
    message: `Codex native restore refused: ${message}`,
    artifacts: {
      config: { state: "skipped", changed: false, action: "failed", message },
      catalog: { state: "skipped", changed: false, removed: 0, kept: 0, path: null, message },
      history: { state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0, message },
    },
  };
}

function desiredEnabledRestoreSkip(): CodexNativeRestoreResult {
  const message = "Codex integration was re-enabled; native restore was skipped.";
  return skippedRestoreEnvelope(true, message);
}

/**
 * A schema-complete all-skipped envelope for outcomes decided before any
 * restore machinery runs. Every `restore --json` path must stay shape-stable
 * with `CodexNativeRestoreResult`; consumers never special-case early exits.
 */
export function skippedRestoreEnvelope(success: boolean, message: string): CodexNativeRestoreResult {
  return {
    success,
    message,
    artifacts: {
      config: { state: "skipped", changed: false, action: "owned-fields-stripped", message },
      catalog: { state: "skipped", changed: false, removed: 0, kept: 0, path: null, message },
      history: { state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0, message },
    },
  };
}

/** Config was attempted and failed; downstream artifacts were never attempted. */
function failedConfigRestoreEnvelope(config: CodexRestoreConfigResult): CodexNativeRestoreResult {
  const result = skippedRestoreEnvelope(false, config.message);
  result.artifacts.config = config;
  return result;
}

/**
 * The history preflight refused, so nothing was attempted at all (#4718).
 *
 * The message is unchanged from what this path has always printed; the structured reason
 * is added beside it so a caller can act on the refusal without reading the prose.
 */
function historyPreflightRefusalEnvelope(historyError: string): CodexNativeRestoreResult {
  const result = skippedRestoreEnvelope(
    false,
    `Native restore refused: ${historyError}. Config, catalog, history and provenance were preserved.`,
  );
  result.historyPreflightRefusal = historyError;
  return result;
}

/** The config/profile half of a native restore, reported as one artifact. */
function restoreCodexConfigInline(kind = "sync"): CodexRestoreConfigResult {
  const preImages = captureCodexPreImages();
  const result = restoreCodexConfigInlineImpl(kind);
  if (result.state === "failed") {
    const compensated = restoreCodexPreImages(preImages);
    if (!compensated.complete) throw new CodexPartialWriteError(compensated.unrestored);
  }
  return result;
}

function restoreCodexConfigInlineImpl(kind: string): CodexRestoreConfigResult {
  try {
    beforeRestoreConfigForTests?.(kind);
    const historyError = preflightCodexHistoryInjection(false, false);
    if (historyError) return { state: "failed", changed: false, action: "failed", message: `Codex configuration and journal preserved: ${historyError}.` };
    const journal = restoreJournalState();
    if (journal.unverified) {
      return {
        state: "failed", changed: false, action: "failed",
        message: "Codex journal recovery was not verified; current configuration files and the journal were preserved.",
      };
    }
    const restored = journal.configRestored
      ? { success: true, message: "Codex config restored from opencodex journal." }
      : removeCodexConfig({ preserveProfile: journal.profileRestored || journal.profileChanged });
    if (restored.success) {
      // A successful journal/fallback write can race native history migration too.
      // Refuse here while preimage compensation and the remove transaction can roll back.
      const finalHistoryError = preflightCodexHistoryInjection(false, false);
      if (finalHistoryError) return { state: "failed", changed: false, action: "failed", message: `Codex configuration and journal preserved: ${finalHistoryError}.` };
    }
    return restored.success
      ? {
          state: "ok",
          changed: journal.configRestored || journal.profileRestored || journal.profileChanged || restored.message.startsWith("Removed"),
          action: journal.configRestored ? "journal-restored" : "owned-fields-stripped",
          message: restored.message,
        }
      : { state: "failed", changed: false, action: "failed", message: restored.message };
  } catch (error) {
    return { state: "failed", changed: false, action: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/** The catalog half, always inside its own K acquisition. */
/**
 * The catalog half, always inside its own K acquisition.
 *
 * `journaledCatalogPath` must be captured by the CALLER, before the config half runs: a
 * successful journal restore deletes the journal, and a config restore can remove
 * `model_catalog_json`. Reading it here would be too late in both cases (#1798).
 */
function restoreCodexCatalogArtifact(
  revalidateDesiredState: boolean,
  journaledCatalogPath: string | null,
): CodexRestoreCatalogResult {
  const owningCodexHome = getCodexHome();
  try {
    const restored = withCatalogWriteSerialization(owningCodexHome, permit =>
      revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())
        ? null
        : restoreCodexCatalogWithPermit(permit, owningCodexHome, journaledCatalogPath));
    return restored.kind === "completed" && restored.value !== null
      ? { state: "ok", changed: restored.value.removed > 0, ...restored.value, message: "Codex catalog restored." }
      : restored.kind === "completed"
        ? {
            state: "skipped", changed: false, removed: 0, kept: 0, path: null,
            message: "Codex integration was re-enabled; native catalog restoration was skipped.",
          }
        : {
            state: "failed", changed: false, removed: 0, kept: 0, path: DEFAULT_CATALOG_PATH,
            message: `Codex catalog could not be restored: ${restored.reason}.`,
          };
  } catch (error) {
    return {
      state: "failed", changed: false, removed: 0, kept: 0, path: DEFAULT_CATALOG_PATH,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Restore native Codex, running history in a Worker under H.
 *
 * On a coordinated home the config/profile restore happens INSIDE the Codex
 * write lock, publishing a `remove` transition — the same serialization inject
 * uses. Without it, an older restore could overwrite a config a concurrent
 * enable had just written under the lock, and then honestly report success
 * while desired intent said ON. The desired-state re-read under the lock turns
 * that lost race into the discriminated `desired_enabled` skip.
 */
export async function restoreNativeCodexAsync(
  options: { revalidateDesiredState?: boolean } = {},
): Promise<CodexNativeRestoreResult> {
  try {
    return await restoreNativeCodexAsyncImpl(options);
  } catch (error) {
    if (!(error instanceof CodexRestoreRefusal)) throw error;
    return failedConfigRestoreEnvelope(error.config);
  }
}

async function restoreNativeCodexAsyncImpl(
  options: { revalidateDesiredState?: boolean },
): Promise<CodexNativeRestoreResult> {
  const activeProvider = currentExternalCodexModelProvider();
  if (activeProvider) {
    // External-provider courtesy: only the stale journal is removed. The
    // history worker must not launch — it would turn a read-mostly courtesy
    // result into a history mutation on a home we do not own.
    removeJournal();
    return externalProviderRestoreResult(activeProvider);
  }

  // `restore` normally honours a human request even when an unrelated
  // service-manager probe is unavailable. A recorded FOREIGN home is not an
  // unrelated probe: it is positive evidence another installation owns these
  // native artifacts, so do not create profile/claim locks before refusing.
  if (options.revalidateDesiredState) {
    const ownership = inspectNativeCodexOwnership();
    if (ownership.ownership === "foreign") return foreignOwnershipRestoreRefusal(ownership.reason);
    if (shouldSyncCodexOnStart(loadConfig())) return desiredEnabledRestoreSkip();
  }

  const historyError = preflightCodexHistoryInjection(false, false);
  if (historyError) return historyPreflightRefusalEnvelope(historyError);

  const eligibility = codexWriteCoordinationEligibility({
    coordinatorPath: () =>
      resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), getCodexHome()),
    residue: () => classifyNativeRoutedResidue(),
    integrationRecord: () => readIntegrationRecord(),
  });

  // Captured before the config half: a successful journal restore DELETES the journal, and
  // restoring the config can drop `model_catalog_json`. Either one would hide the routed
  // catalog we actually wrote (#1798).
  const journaledCatalogPath = journaledInjectedCatalogPath();
  let config: CodexRestoreConfigResult;
  let transitionReceipt: { nativeGeneration: number; currentTxId: string } | undefined;

  if (eligibility.kind === "coordinated" || eligibility.kind === "adopt") {
    // The restore has no candidate bytes to witness; freshness comes from the
    // filesystem reads and the desired-state re-read performed under the lock.
    const witness = { authoritySnapshotId: "codex-native-restore" };
    const coordinated = await withCodexWriteLock(
      {
        timeoutMs: DEFAULT_INJECT_LOCK_TIMEOUT_MS,
        ...(eligibility.kind === "adopt" ? { adoption: { direction: "remove" as const } } : {}),
        admitted: witness,
        readAdmissionUnderLock: () => witness,
      },
      (ctx) => {
        if (options.revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
          throw new CodexWriteLockSkipped("desired_enabled");
        }
        const published = ctx.coordinator.beginTransition(
          {
            nativeGeneration: ctx.expectation.nativeBefore,
            currentTxId: ctx.currentTxId,
          },
          {
            txId: ctx.expectation.txId,
            direction: "remove",
            authoritySnapshotId: ctx.admission.authoritySnapshotId,
            nextRetryAt: new Date().toISOString(),
          },
        );
        if (published.kind !== "updated") {
          throw new CodexWriteConflictError(
            `The Codex transition could not be published: ${published.kind}.`,
          );
        }
        const preImages = captureCodexPreImages();
        let restored: CodexRestoreConfigResult;
        try {
          restored = restoreCodexConfigInline(eligibility.kind);
          // Throw inside N so the published remove transition rolls back too.
          if (restored.state === "failed") throw new CodexRestoreRefusal(restored);
        } catch (error) {
          const compensated = restoreCodexPreImages(preImages);
          if (!compensated.complete) throw new CodexPartialWriteError(compensated.unrestored);
          throw error;
        }
        return {
          config: restored,
          preImages,
          receipt: {
            nativeGeneration: ctx.expectation.nativeAfter,
            currentTxId: ctx.expectation.txId,
          },
        };
      },
    );
    if (coordinated.status === "skipped") return desiredEnabledRestoreSkip();
    if (coordinated.status !== "acquired") {
      config = {
        state: "failed",
        changed: false,
        action: "failed",
        message: coordinated.status === "busy"
          ? `Another process is writing Codex configuration right now (waited ${coordinated.waitedMs}ms). Retry shortly.`
          : `Codex configuration was not restored: ${coordinated.message}`,
      };
    } else {
      recordCodexNativeTransactionProvenance(
        coordinated.value.preImages,
        coordinated.value.receipt.currentTxId,
      );
      config = coordinated.value.config;
      transitionReceipt = coordinated.value.receipt;
    }
  } else {
    // Legacy-uncoordinated (or unresolvable) homes keep the unserialized path
    // they have always had; restore is the escape hatch and must not strand
    // them. The plain re-read still honors an intervening re-enable.
    if (options.revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
      return desiredEnabledRestoreSkip();
    }
    config = restoreCodexConfigInline(eligibility.kind);
  }

  if (config.state === "failed") return failedConfigRestoreEnvelope(config);
  const catalog = restoreCodexCatalogArtifact(options.revalidateDesiredState === true, journaledCatalogPath);
  const outcome = await runCodexHistoryJob({
    ...resolveCodexHistoryJobTarget(),
    ...(options.revalidateDesiredState ? { expectedDesiredEnabled: false } : {}),
    operation: deriveCodexHistoryOperation({ direction: "restore", resumeHistory: true, legacyMode: false }),
  });
  if (transitionReceipt) {
    resolveCodexHistoryTransition(transitionReceipt, outcome);
  }
  const history: CodexRestoreHistoryResult = outcome.kind === "converged"
    ? {
        state: "ok", changed: outcome.rows > 0 || outcome.files > 0, rows: outcome.rows, files: outcome.files, ejectedRows: 0,
        message: outcome.rows > 0
          ? `Resume history metadata restored from opencodex backup (${outcome.rows} thread(s)); original providers preserved.`
          : "No backed-up resume-history metadata was pending; untracked routed history was left unchanged.",
      }
    : outcome.kind === "skipped"
      ? { state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0, message: "Codex resume history was skipped." }
      : outcome.kind === "blocked" && (outcome.reason === "desired_disabled" || outcome.reason === "desired_enabled")
        ? {
            state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0,
            message: outcome.reason === "desired_disabled"
              ? "Codex integration was disabled; history restoration was skipped."
              : "Codex integration was enabled; history restoration was skipped.",
          }
      : outcome.kind === "blocked" || outcome.kind === "failed"
        ? failedHistoryRestoreFromOutcome(outcome)
        : failedHistoryRestore();
  const base = catalog.removed > 0
    ? `${config.message} Catalog restored to ${catalog.kept} native model(s) (dropped ${catalog.removed} proxy-routed).`
    : config.message;
  const success = catalog.state !== "failed"
    && history.state !== "failed";
  return {
    success,
    message: `${base}${history.state === "failed" ? ` ⚠️ ${history.message}` : ""}`,
    artifacts: { config, catalog, history },
  };
}

export function restoreNativeCodex(options: { skipHistory?: boolean; revalidateDesiredState?: boolean } = {}): CodexNativeRestoreResult {
  const activeProvider = currentExternalCodexModelProvider();
  if (activeProvider) {
    removeJournal();
    return externalProviderRestoreResult(activeProvider);
  }
  if (options.revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
    return desiredEnabledRestoreSkip();
  }
  const historyError = preflightCodexHistoryInjection(false, false);
  if (historyError) return historyPreflightRefusalEnvelope(historyError);
  // Captured before the config half: a successful journal restore DELETES the journal, and
  // restoring the config can drop `model_catalog_json`. Either one would hide the routed
  // catalog we actually wrote (#1798).
  const journaledCatalogPath = journaledInjectedCatalogPath();
  const config = restoreCodexConfigInline();
  if (config.state === "failed") return failedConfigRestoreEnvelope(config);
  const catalog = restoreCodexCatalogArtifact(options.revalidateDesiredState === true, journaledCatalogPath);
  // Design B (loopback) steady state: threads are already tagged openai, so prove the
  // no-op with a readonly probe instead of write-opening a DB the Codex app may hold
  // (Windows: WAL writer lock -> seconds of stalling + a false warning on every stop).
  // Legacy (non-loopback) installs keep the unconditional write-open restore.
  let skipWhenProvablyNoop = false;
  try {
    skipWhenProvablyNoop = !shouldInjectApiAuthHeader(loadConfig());
  } catch {
    /* unreadable config: keep the conservative write-open restore */
  }
  // `skipHistory` is how the async wrapper takes this work for itself: the
  // native files come down here, and history runs in the Worker under H.
  const rawHistory = options.skipHistory
    ? { rows: 0, files: 0 }
    : syncCodexHistoryProvider("openai", undefined, undefined, {
        skipWhenProvablyNoop,
      });
  const history: CodexRestoreHistoryResult = options.skipHistory
    ? { state: "skipped", changed: false, rows: 0, files: 0, ejectedRows: 0, message: "History restoration runs asynchronously." }
    : rawHistory.failed
      ? failedHistoryRestore(rawHistory.failureReason, undefined, rawHistory)
      : {
          state: "ok",
          changed: rawHistory.rows > 0 || rawHistory.files > 0 || (rawHistory.ejectedRows ?? 0) > 0,
          rows: rawHistory.rows,
          files: rawHistory.files,
          ejectedRows: rawHistory.ejectedRows ?? 0,
          message: rawHistory.rows > 0
            ? `Resume history metadata restored from opencodex backup (${rawHistory.rows} thread(s)); original providers preserved.`
            : "No backed-up resume-history metadata was pending; untracked routed history was left unchanged.",
        };
  const message = catalog.removed > 0
    ? `${config.message} Catalog restored to ${catalog.kept} native model(s) (dropped ${catalog.removed} proxy-routed).`
    : config.message;
  return {
    success: catalog.state !== "failed" && history.state !== "failed",
    message,
    artifacts: { config, catalog, history },
  };
}

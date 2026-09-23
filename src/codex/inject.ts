import { existsSync, readFileSync } from "node:fs";
import {
  atomicWriteFile,
  loadConfig,
  observeConfigGeneration,
  readConfigAdmissionSnapshot,
  withConfigMutationLockSync,
} from "../config";
import { CodexWriteLockSkipped, withCodexWriteLock } from "./codex-write-lock";
import {
  localClientSkipMessage,
  localClientSkipReason,
  shouldSyncCodexOnStart,
} from "./desired-state";
import { resolveCodexHistoryTransition } from "./history-transition";
import {
  buildInjectWitness,
  captureCodexPreImages,
  codexInjectLockOutcome,
  codexWriteCoordinationEligibility,
  CodexPartialWriteError,
  CodexWriteConflictError,
  DEFAULT_INJECT_LOCK_TIMEOUT_MS,
  recomputeInjectWitness,
  recordCodexNativeTransactionProvenance,
  restoreCodexPreImages,
} from "./inject-coordination";
import { readIntegrationRecord } from "./integration-record";
import { classifyNativeRoutedResidue } from "./native-residue";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "./user-identity";
import {
  hasUnverifiedJournalBaseline,
  markJournalInjectedState,
  journaledInjectedOpenaiBaseUrl,
  journaledInjectedRealtimeWsBaseUrl,
  removeJournal,
  writeJournal,
} from "./journal";
import { HISTORY_RELABEL_STANDS_DOWN } from "./history-provider";
import {
  describeHistoryJobFailure,
  deriveCodexHistoryOperation,
  resolveCodexHistoryJobTarget,
  runCodexHistoryJob,
  type CodexHistoryJobOutcome,
} from "./history-job";
import {
  REALTIME_WS_BASE_URL_KEY,
  hasInjectedCodexRouting,
  hasInjectedOpenaiBaseUrl,
  rootTomlString,
} from "./injected-marker";
import {
  CODEX_CONFIG_PATH,
  CODEX_PROFILE_PATH,
  getCodexHome,
  tomlString,
} from "./paths";
import type { OcxConfig } from "../types";
import {
  configuredManagedSubagentDefaults,
  standaloneCodexRoutingTarget,
  validateCodexRoutingTarget,
  type CodexRoutingTarget,
} from "./inject/routing-target";
import {
  externalCodexModelProvider,
} from "./inject/config-toml";
import { prepareInjectedV1SurfaceReconcile } from "./inject/multi-agent-v2";
import {
  deriveCodexInjectionPlan,
  type CodexInjectionPlanContext,
  type CodexInjectionPlanOk,
} from "./inject/plan";

export { effectiveLoopbackListenerPort, isLoopbackHostname, shouldInjectApiAuthHeader } from "./loopback-target";

// Ownership predicates live in `./injected-marker` so `journal.ts` can reach them
// without importing this module back. Re-exported for existing external callers.
export { hasInjectedCodexRouting, hasInjectedOpenaiBaseUrl };

/**
 * Design B (2026-07-06): loopback installs no longer re-tag the provider. Instead of
 * `model_provider = "opencodex"` + a `[model_providers.opencodex]` table, we set the official
 * built-in override `openai_base_url` (codex-rs config_toml.rs) so codex's own `openai`
 * provider points at the proxy. Threads keep `model_provider = "openai"`, so history never
 * needs remapping or restore. Non-loopback binds keep the legacy table injection because the
 * built-in provider cannot carry the `x-opencodex-api-key` env header.
 */

export interface InjectCodexOptions {
  /**
   * Absolute or CODEX_HOME-relative catalog path to advertise to Codex. Pass `null` only when the
   * opencodex catalog could not be materialized; Codex will then keep its native catalog instead of
   * failing on a missing model_catalog_json file.
   */
  catalogPath?: string | null;
  /**
   * How long to wait for the Codex write lock before reporting contention.
   *
   * Bounded by default so a stuck holder cannot wedge `ocx start`; an explicit
   * caller that is willing to wait can raise it.
   */
  lockTimeoutMs?: number;
  /**
   * Validate the same config transformations and write-coordination eligibility without
   * changing the journal, config, profile, catalog, cache, or history. Sync uses this before
   * provider discovery so a deterministic config refusal cannot degrade an existing catalog.
   */
  validateOnly?: boolean;
  /** Explicit remote routing target. Absence preserves byte-compatible standalone output. */
  routingTarget?: CodexRoutingTarget;
  journalOwner?: { kind: "process" } | { kind: "client"; apiKeyId: string };
  /** Synchronous read-only client ownership guard, evaluated at the artifact commit boundary. */
  beforeClientWrite?: () => void;
}

function runClientWriteGuard(guard: InjectCodexOptions["beforeClientWrite"]): void {
  const result: unknown = guard?.();
  if (result !== null && (typeof result === "object" || typeof result === "function")
    && typeof (result as { then?: unknown }).then === "function") {
    // Reject async guards without leaving their eventual rejection unhandled.
    void Promise.resolve(result).catch(() => {});
    throw new Error("Connected client write guard must be synchronous");
  }
}


export interface CodexInjectResult {
  success: boolean;
  message: string;
  /**
   * Structured read-only history preflight refusal; never parsed from display text.
   *
   * On the apply direction this reports that the conversation-history relabel unit stood
   * down while the config was still written, so a caller must not read it as a failure.
   * The restore and remove directions still refuse outright and say so in `message`.
   */
  historyPreflightFailureReason?: string;
  status?: "skipped";
  /** Busy write lock, emitted by `codexInjectLockOutcome` and undeclared here until #4809. */
  retryable?: boolean;
  /** `hub-gated` is the hub-role gate (#4236), distinct from the user's own OFF switch. */
  skippedReason?: "desired_disabled" | "desired_enabled" | "hub-gated";
  nativeSubagentDefaultsWarning?: string;
}

class CodexHistoryPreflightRefusal extends Error {}

/**
 * A refusal raised inside the write boundary. The caller's catch has already
 * restored the captured preimages — a landed v1-surface reconcile included —
 * so the carried result is returned verbatim by the outer wrapper.
 */
class CodexInjectRefusal extends Error {
  constructor(readonly result: CodexInjectResult) {
    super(result.message);
    this.name = "CodexInjectRefusal";
  }
}

let historyArtifactStageForTests: ((stage: string) => void) | undefined;
export function setHistoryArtifactStageForTests(hook: typeof historyArtifactStageForTests): void {
  historyArtifactStageForTests = hook;
}
let beforeHistoryArtifactCommitForTests: ((kind: string) => void) | undefined;
export function setBeforeHistoryArtifactCommitForTests(hook: typeof beforeHistoryArtifactCommitForTests): void {
  beforeHistoryArtifactCommitForTests = hook;
}
let publishCurrentTxIdForTests: (() => string) | undefined;
/** Test seam: supply a stale coordinator predecessor after the v1 toggle has run. */
export function setInjectPublishCurrentTxIdForTests(hook: typeof publishCurrentTxIdForTests): void {
  publishCurrentTxIdForTests = hook;
}

export async function injectCodexConfig(
  port: number,
  config?: OcxConfig,
  options: InjectCodexOptions = {},
): Promise<CodexInjectResult> {
  try { return await injectCodexConfigImpl(port, config, options); }
  catch (error) {
    if (error instanceof CodexHistoryPreflightRefusal) return { success: false, historyPreflightFailureReason: error.message, message: `Codex config injection refused: ${error.message}. Existing configuration and history were preserved.` };
    if (error instanceof CodexInjectRefusal) return error.result;
    throw error;
  }
}

async function injectCodexConfigImpl(
  port: number,
  config?: OcxConfig,
  options: InjectCodexOptions = {},
): Promise<CodexInjectResult> {
  // Point Codex at the unauthenticated loopback listener when it is enabled (#1102).
  //
  // Resolved here rather than at the call sites because every caller already passes the proxy
  // port and the config together: startup sync, `ocx sync`, and the ensure path would each
  // need the same two-line change, and a caller that missed it would silently emit a base_url
  // requiring a credential the directly-spawned app-server does not have.
  //
  // The listener port is fixed in config, never OS-assigned, so this value survives restarts
  // and matches what an already-running app-server read at startup.
  let routingTarget: CodexRoutingTarget;
  try {
    routingTarget = options.routingTarget
      ? validateCodexRoutingTarget(options.routingTarget)
      : standaloneCodexRoutingTarget(port, config);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Invalid Codex routing target" };
  }
  if (!existsSync(CODEX_CONFIG_PATH)) {
    return {
      success: false,
      message: `Codex config not found at ${CODEX_CONFIG_PATH}. Is Codex installed?`,
    };
  }

  const rawContent = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  const activeProvider = externalCodexModelProvider(rawContent);
  if (activeProvider) {
    // A launcher may have journaled before the provider manager took ownership. Never let shutdown
    // replay that stale snapshot over externally managed config.
    if (!options.validateOnly) {
      if (options.beforeClientWrite) {
        withConfigMutationLockSync(() => {
          runClientWriteGuard(options.beforeClientWrite);
          removeJournal();
        });
      } else removeJournal();
    }
    const nativeSubagentDefaultsWarning = configuredManagedSubagentDefaults(
      config,
    )
      ? `Native Codex sub-agent defaults were not injected: external model_provider ${tomlString(activeProvider)} owns config.toml.`
      : undefined;
    return {
      success: true,
      ...(nativeSubagentDefaultsWarning
        ? { nativeSubagentDefaultsWarning }
        : {}),
      message:
        `⚠️ Codex routing NOT injected: config.toml selects the external model_provider ${tomlString(activeProvider)}.\n` +
        `  OpenCodex preserves external provider configuration so existing ${tomlString(activeProvider)} session history stays visible.\n` +
        `  Configure that provider for Responses passthrough at ${routingTarget.baseUrl}` +
        `${routingTarget.requiresAdmissionToken ? ` with x-opencodex-api-key from ${routingTarget.tokenEnv}` : ""}.\n` +
        `  For direct injection, switch to the built-in openai provider, remove any user-owned root openai_base_url, and rerun 'ocx start'.`,
    };
  }

  /*
   * The v1-surface reconcile mutates config.toml through the native
   * `codex features` transition, so it runs INSIDE the coordinated write
   * boundary below — under the same lock and preimage as the artifact commit.
   * Run here, a later ambiguous-baseline, journal, or lock refusal left
   * config.toml changed while the rest of the injection failed, and a
   * competing writer could land between the transition and the commit.
   * Its dependencies are resolved now because the commit callback is
   * synchronous and cannot await them there.
   */
  const v1Reconcile = await prepareInjectedV1SurfaceReconcile(config, options);

  /*
   * The plan against the admitted input. When the reconcile transitions the
   * file under the lock, the committed bytes are re-derived from the
   * post-transition input by reconcileAndDerivePlan. Admission compares the
   * original candidate for stale input; publication fingerprints the rederived
   * candidate so the transition describes the bytes actually committed.
   */
  const planContext: CodexInjectionPlanContext = {
    config,
    routingTarget,
    catalogPathOption: options.catalogPath,
    journalReadOnly: !!options.beforeClientWrite,
  };
  const admittedPlan = deriveCodexInjectionPlan(rawContent, planContext);
  if (admittedPlan.kind === "refused") {
    return {
      success: false,
      ...(admittedPlan.historyPreflightFailureReason
        ? { historyPreflightFailureReason: admittedPlan.historyPreflightFailureReason }
        : {}),
      message: admittedPlan.message,
    };
  }

  /*
   * The admission witness hashes the planned bytes before the native toggle.
   * Its evidence is re-read under the lock to reject stale input. Publication
   * uses a separate witness after the toggle, if the plan was rederived;
   * ownership rides along as recorded context because it is not re-observed
   * there — see `write-coordination.ts`.
   */
  const persisted = readConfigAdmissionSnapshot();
  const persistedIdentity =
    persisted.kind === "read" ? persisted.contentSha256 : "unreadable";
  const observedGeneration = observeConfigGeneration();
  const generation =
    observedGeneration.kind === "ready"
      ? { present: true, value: observedGeneration.generation.value }
      : { present: false, value: 0 };
  const witness = buildInjectWitness(
    admittedPlan.candidate,
    rawContent,
    persistedIdentity,
    generation,
    "unknown",
  );

  /*
   * THE COORDINATED SECTION.
   *
   * This is the write lock's first production caller. Everything above is
   * classification and pure transformation; everything from here to the end of
   * the callback replaces files, and two processes doing it at once is the
   * interruption hazard this substrate exists to close.
   *
   * The witness hashes the bytes about to be written rather than the inputs that
   * produced them, so two operations intending different output cannot share an
   * id no matter which input differed.
   */
  /*
   * Eligibility BEFORE acquisition, never "try and fall back".
   *
   * A home routed before this substrate existed cannot have its first
   * coordinator row created — the guard that refuses is correct — and that
   * describes every pre-substrate install. Attempting the lock there would enter
   * a refusal path on the entire installed base, so the decision happens first
   * and those homes keep the write sequence they have always used.
   */
  const eligibility = codexWriteCoordinationEligibility({
    coordinatorPath: () =>
      resolveCodexCoordinatorDatabasePath(
        resolveEffectiveUserIdentity(),
        getCodexHome(),
      ),
    residue: () => classifyNativeRoutedResidue(),
    integrationRecord: () => readIntegrationRecord(),
  });
  if (eligibility.kind === "refused") {
    return {
      success: false,
      message: `Codex configuration was not written: ${eligibility.reason}.`,
    };
  }

  const journalBaselineIsNative = (nativeInput: string): boolean => {
    // Value evidence survives an app rewrite that removes the ownership comments.
    const journaledBaseUrl = journaledInjectedOpenaiBaseUrl({ readOnly: true });
    const journaledRealtimeWsBaseUrl = journaledInjectedRealtimeWsBaseUrl({ readOnly: true });
    const looksInjectedByValue =
      (journaledBaseUrl !== null && rootTomlString(nativeInput, "openai_base_url") === journaledBaseUrl)
      || (journaledRealtimeWsBaseUrl !== null
        && rootTomlString(nativeInput, REALTIME_WS_BASE_URL_KEY) === journaledRealtimeWsBaseUrl);
    return !hasInjectedCodexRouting(nativeInput) && !looksInjectedByValue;
  };
  const readCurrentProfile = (): string | null => existsSync(CODEX_PROFILE_PATH)
    ? readFileSync(CODEX_PROFILE_PATH, "utf-8")
    : null;
  const unverifiedJournalMessage = "Codex configuration was not written: the journal has no verified baseline for the current config/profile. Current files and the journal were preserved.";
  // When the reconcile will rewrite config.toml under the lock, the baseline it
  // must be journaled against does not exist yet — this check runs inside the
  // boundary on the post-transition plan instead. Otherwise the admitted bytes
  // are final and the early refusal saves acquiring the lock just to say no.
  if (v1Reconcile?.enabledAtPrepare !== true
    && !journalBaselineIsNative(rawContent)
    && hasUnverifiedJournalBaseline(admittedPlan.baselineContent, readCurrentProfile())) {
    return {
      success: false,
      message: unverifiedJournalMessage,
    };
  }

  if (options.validateOnly) {
    return {
      success: true,
      ...(admittedPlan.historyRelabelRefusal ? { historyPreflightFailureReason: admittedPlan.historyRelabelRefusal } : {}),
      message: "Codex config injection preflight passed; no files were changed.",
    };
  }

  /*
   * Re-observed inside the artifact transaction. A store that migrates to
   * paginated history mid-write can retire the relabel unit while its
   * already-admitted candidate leaves existing provider references resolvable.
   */
  const observeHistoryRefusalOrThrow = (plan: CodexInjectionPlanOk): string | null => {
    if (plan.historyRelabelRefusal) return plan.historyRelabelRefusal;
    const observed = plan.historyPreflight();
    if (observed && observed !== HISTORY_RELABEL_STANDS_DOWN) throw new CodexHistoryPreflightRefusal(observed);
    return observed;
  };

  /*
   * The half of the injection that only exists inside the write boundary: the
   * v1-surface reconcile first, then the plan re-derived from whatever bytes
   * the transition left so the committed file cannot re-enable the flag the
   * reconcile just turned off. Every refusal here is thrown as
   * CodexInjectRefusal so the caller's catch restores the preimage — the flag
   * flip included — before the result is reported.
   */
  const reconcileAndDerivePlan = (): { plan: CodexInjectionPlanOk; nativeInput: string } => {
    let nativeInput = rawContent;
    let plan = admittedPlan;
    if (v1Reconcile) {
      const reconciled = v1Reconcile.run();
      if (!reconciled.ok) {
        throw new CodexInjectRefusal({ success: false, message: reconciled.message });
      }
      nativeInput = reconciled.content;
      if (reconciled.content !== rawContent) {
        const rederived = deriveCodexInjectionPlan(reconciled.content, planContext);
        if (rederived.kind === "refused") {
          throw new CodexInjectRefusal({
            success: false,
            ...(rederived.historyPreflightFailureReason
              ? { historyPreflightFailureReason: rederived.historyPreflightFailureReason }
              : {}),
            message: rederived.message,
          });
        }
        plan = rederived;
      }
      // Seam for the mutual-exclusion regression: the feature transition has
      // landed and the artifact commit has not — the window a competing writer
      // must be unable to enter.
      historyArtifactStageForTests?.("after-v1-reconcile");
    }
    if (!journalBaselineIsNative(nativeInput)
      && hasUnverifiedJournalBaseline(plan.baselineContent, readCurrentProfile())) {
      throw new CodexInjectRefusal({ success: false, message: unverifiedJournalMessage });
    }
    return { plan, nativeInput };
  };

  const applyNativeArtifacts = (plan: CodexInjectionPlanOk, nativeInput: string): void => {
    beforeHistoryArtifactCommitForTests?.(eligibility.kind);
    plan.historyRelabelRefusal = observeHistoryRefusalOrThrow(plan);
    historyArtifactStageForTests?.("after-preflight");
    writeJournal({
      currentStateIsNative: journalBaselineIsNative(nativeInput),
      configContent: plan.baselineContent,
      owner: options.journalOwner,
    });
    // A native snapshot may have been refreshed above. An older hashless routed snapshot
    // must not gain the new injection's hash and later overwrite preserved user edits.
    if (hasUnverifiedJournalBaseline(plan.baselineContent, readCurrentProfile())) throw new Error(unverifiedJournalMessage);
    atomicWriteFile(CODEX_CONFIG_PATH, plan.content);
    historyArtifactStageForTests?.("after-config");
    atomicWriteFile(CODEX_PROFILE_PATH, plan.profileContent);
    markJournalInjectedState(plan.content, plan.profileContent, {
      // A root override is ours whenever we wrote one and no user-owned value won. That is
      // loopback Design B, the client-compaction form, and a table form that retained the
      // root line for paginated history. Journaling it matters because the marker comment
      // is not durable: the Codex app can reserialize config.toml and drop comments, and
      // restore then has only the journaled value to distinguish our line from a user's.
      // Other table forms record null.
      injectedOpenaiBaseUrl: (plan.providerTableMode && !plan.keepRootOverrideAlongsideTable) || plan.keptUserBaseUrl
        ? null
        : rootTomlString(plan.content, "openai_base_url"),
      // The sideband override is ours only when we wrote it this pass (never in legacy mode,
      // never when the user owns either key).
      injectedRealtimeWsBaseUrl: plan.providerTableMode || plan.keptUserBaseUrl || plan.keptUserRealtimeWsBaseUrl
        ? null
        : rootTomlString(plan.content, REALTIME_WS_BASE_URL_KEY),
      // This is the catalog artifact selected for this injection, even when config.toml
      // already points at that path and therefore needs no textual rewrite.
      injectedCatalogPath: plan.catalogPath,
    });
    historyArtifactStageForTests?.("after-artifacts");
    // Detect migration throughout the artifact transaction, not just at entry.
    plan.historyRelabelRefusal = observeHistoryRefusalOrThrow(plan);
  };

  /*
   * Set only on the coordinated path: the generation/txId the transition just
   * committed. The terminal history update CASes against this, so a job that
   * was overtaken cannot overwrite the winner. Stays undefined for a
   * legacy-uncoordinated home, which publishes no transition to resolve.
   */
  let transitionReceipt: { nativeGeneration: number; currentTxId: string } | undefined;

  /*
   * The plan the committed write actually used: the admitted plan, or the
   * re-derivation from the post-reconcile bytes when the feature transition
   * rewrote config.toml under the lock. Every reader below the boundary takes
   * this plan so the report describes the bytes that were committed.
   */
  let effectivePlan: CodexInjectionPlanOk = admittedPlan;

  if (eligibility.kind === "legacy-uncoordinated") {
    const applyLegacy = (): CodexInjectResult | undefined => {
      const legacyGateSnapshot = loadConfig();
      if (!shouldSyncCodexOnStart(legacyGateSnapshot)) {
        return {
          success: true,
          status: "skipped",
          skippedReason: localClientSkipReason(legacyGateSnapshot),
          message: localClientSkipMessage(
            legacyGateSnapshot,
            "Codex integration is OFF; no Codex config, catalog, cache, or history was changed.",
            "No Codex config, catalog, cache, or history was changed.",
          ),
        };
      }
      runClientWriteGuard(options.beforeClientWrite);
      /*
       * One preimage covers the reconcile and the artifact commit together: a
       * refusal after the feature transition hands back the exact bytes the
       * home started with, flag included.
       */
      const preImages = captureCodexPreImages();
      try {
        const resolved = reconcileAndDerivePlan();
        applyNativeArtifacts(resolved.plan, resolved.nativeInput);
        effectivePlan = resolved.plan;
      } catch (error) {
        const restored = restoreCodexPreImages(preImages);
        if (!restored.complete) throw new CodexPartialWriteError(restored.unrestored);
        throw error;
      }
      return undefined;
    };
    // Only connected guarded writes add C here. A concurrent disconnect claim
    // either follows this commit or is observed by the guard before any write.
    const skipped = options.beforeClientWrite
      ? withConfigMutationLockSync(applyLegacy)
      : applyLegacy();
    if (skipped) return skipped;
  } else {
    let coordinatedPreImages: ReturnType<typeof captureCodexPreImages> | undefined;
    const coordinated = await withCodexWriteLock(
      {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_INJECT_LOCK_TIMEOUT_MS,
        ...(eligibility.kind === "adopt" ? { adoption: { direction: "apply" as const } } : {}),
        onPostCallbackFailure: () => {
          if (!coordinatedPreImages) throw new Error("Codex injection preimages were not captured.");
          const restored = restoreCodexPreImages(coordinatedPreImages);
          if (!restored.complete) throw new CodexPartialWriteError(restored.unrestored);
        },
        admitted: { authoritySnapshotId: witness.comparisonId },
        readAdmissionUnderLock: () => ({
          authoritySnapshotId: recomputeInjectWitness({
            candidate: witness.candidate,
            canonicalTargets: witness.evidence.canonicalTargets,
            persistedIdentity,
            generation,
            observedOwnership: witness.observedOwnership,
          }).comparisonId,
        }),
      },
      (ctx) => {
        const gateSnapshot = loadConfig();
        if (!shouldSyncCodexOnStart(gateSnapshot)) {
          // Carry WHY under the lock: "the hub does not write its own clients" and "the user
          // turned Codex off" produce the same no-write and must not produce the same sentence.
          throw new CodexWriteLockSkipped(localClientSkipReason(gateSnapshot));
        }
        // N and C are held here. Reject stale client work before publishing a
        // transition or capturing preimages; rejection must not compensate over
        // a disconnect's restored files.
        runClientWriteGuard(options.beforeClientWrite);
        /*
         * Exact pre-images, captured under the lock and used for compensation.
         *
         * A rolled-back coordinator row is not a rolled-back filesystem: each
         * `atomicWriteFile` is atomic alone, never across the three together, so a
         * failure partway leaves earlier replacements in place. `restoreJournalState`
         * cannot be the undo — it restores whichever journal occupies the path,
         * which need not be the one this operation wrote.
         *
         * The capture precedes the v1-surface reconcile on purpose: one verified
         * preimage covers the feature transition and the artifact commit, so a
         * later refusal restores the flag the transition flipped along with the
         * files the commit replaced.
         */
        const preImages = captureCodexPreImages();
        coordinatedPreImages = preImages;
        let resolved: { plan: CodexInjectionPlanOk; nativeInput: string };
        try {
          resolved = reconcileAndDerivePlan();
          // The admission id compared pre-toggle bytes. Once the native toggle
          // has run, publish the rederived candidate and its actual input as the
          // committed-byte witness before writing the remaining artifacts.
          const committedWitness = buildInjectWitness(
            resolved.plan.candidate,
            resolved.nativeInput,
            persistedIdentity,
            generation,
            witness.observedOwnership,
          );
          const published = ctx.coordinator.beginTransition(
            {
              nativeGeneration: ctx.expectation.nativeBefore,
              currentTxId: publishCurrentTxIdForTests?.() ?? ctx.currentTxId,
            },
            {
              txId: ctx.expectation.txId,
              direction: "apply",
              authoritySnapshotId: committedWitness.comparisonId,
              nextRetryAt: new Date().toISOString(),
            },
          );
          if (published.kind !== "updated") {
            throw new CodexWriteConflictError(
              `The Codex transition could not be published: ${published.kind}.`,
            );
          }
          applyNativeArtifacts(resolved.plan, resolved.nativeInput);
        } catch (error) {
          // Compensate, then ALWAYS throw. Returning a partial result would let the
          // lock commit a row describing an apply that did not finish.
          const restored = restoreCodexPreImages(preImages);
          if (!restored.complete) {
            throw new CodexPartialWriteError(restored.unrestored);
          }
          throw error;
        }
        return {
          kind: "applied" as const,
          preImages,
          plan: resolved.plan,
          /*
           * The receipt the terminal update matches on. The transition commits
           * when the callback returns, so this pair is what the post-job
           * `updateCodexHistoryTransition` CASes against — an overtaken job
           * cannot overwrite a winner.
           */
          receipt: {
            nativeGeneration: ctx.expectation.nativeAfter,
            currentTxId: ctx.expectation.txId,
          },
        };
      },
    );

    if (coordinated.status !== "acquired") {
      return codexInjectLockOutcome(coordinated);
    }
    effectivePlan = coordinated.value.plan;
    recordCodexNativeTransactionProvenance(
      coordinated.value.preImages,
      coordinated.value.receipt.currentTxId,
    );
    transitionReceipt = coordinated.value.receipt;
  }
  // Legacy mode still forward-tags history so re-tagged threads stay listable. Design B needs
  // the opposite: a one-time migration of previously re-tagged threads BACK to openai (restore
  // machinery; cheap no-op when there is nothing to migrate). The client-compaction opt-in keeps
  // the root override alongside its table precisely so it does NOT have to touch history: an
  // existing `openai`-tagged thread still reaches this proxy through the built-in entry. So it
  // skips this unit, and future-only means what it says — no provider metadata is rewritten and
  // no `ocx1:` payload is touched.
  // History runs in a Worker under H, not on this thread.
  //
  // The three surfaces it touches — the SQLite rows, the backup manifest, and the
  // rollout files — do not share a transaction, so a busy timeout only ever
  // serialized one of them and an opposite-direction process could overtake
  // through the other two. The operation is derived from admitted intent here and
  // handed down fixed; the Worker never takes a direction from its caller.
  // A stood-down relabel unit spawns no Worker: the preflight it would run first has
  // already refused, and the config half is committed either way.
  historyArtifactStageForTests?.("before-history-worker");
  const historyOutcome: CodexHistoryJobOutcome = effectivePlan.historyRelabelRefusal
    ? { kind: "skipped" }
    : await runCodexHistoryJob({
      ...resolveCodexHistoryJobTarget(),
      expectedDesiredEnabled: true,
      operation: deriveCodexHistoryOperation({
        direction: "apply",
        resumeHistory: config?.syncResumeHistory !== false && !effectivePlan.keepRootOverrideAlongsideTable,
        legacyMode: effectivePlan.providerTableMode,
      }),
    });
  // A blocked or failed unit is reported, not silently counted as zero work:
  // `failed` is what makes the caller's message say so.
  const history: { rows: number; files: number; failed?: true } =
    historyOutcome.kind === "converged"
      ? { rows: historyOutcome.rows, files: historyOutcome.files }
      : historyOutcome.kind === "skipped"
        ? { rows: 0, files: 0 }
        : { rows: 0, files: 0, failed: true };

  /*
   * Resolve the transition this job belongs to, on the coordinated path only.
   *
   * `updateCodexHistoryTransition` had no production caller since it was
   * written, so every completed or skipped job left the row permanently
   * `pending` — the transition was published and never resolved. This is the
   * first time the durable row reflects what actually happened. The CAS on the
   * receipt means an overtaken job's late write loses and is not overwritten.
   */
  if (transitionReceipt) {
    resolveCodexHistoryTransition(transitionReceipt, historyOutcome);
  }

  const catalogMessage = effectivePlan.catalogPath
    ? `  Codex model catalog: ${effectivePlan.catalogPath}\n`
    : `  Codex model catalog not injected because no opencodex catalog file exists yet.\n`;
  const ejected = (history as { ejectedRows?: number }).ejectedRows ?? 0;
  const migratedRows = (history.rows ?? 0) + ejected;
  const historyMessage =
    effectivePlan.keepRootOverrideAlongsideTable
      ? (effectivePlan.keptUserBaseUrl
        ? `  Codex resume history: left unchanged; threads already tagged openai follow your configured root openai_base_url.\n`
        : `  Codex resume history: left unchanged; existing threads keep reaching the proxy through the retained openai_base_url override.\n`)
      : effectivePlan.historyRelabelRefusal
      ? `  ⚠️ Codex resume history: left to Codex's native writer (${effectivePlan.historyRelabelRefusal}); existing threads keep the provider they are tagged with. Routing and the model catalog were still installed, so new threads reach the proxy.\n`
      : config?.syncResumeHistory === false
      ? `  Codex resume history: left unchanged (syncResumeHistory=false).\n`
      : history.failed
        ? formatApplyHistoryFailure(historyOutcome, effectivePlan.providerTableMode)
        : effectivePlan.providerTableMode
          ? `  Codex resume history: ${history.rows} thread(s) made visible for opencodex; originals backed up for restore.\n`
          : migratedRows > 0
            ? `  Codex resume history: restored original provider metadata for ${migratedRows} manifest-backed thread(s) (one-time).\n`
            : `  Codex resume history: no backed-up metadata pending; untracked routed history left unchanged.\n`;
  // A user-owned root openai_base_url means we did NOT install root routing — say so honestly
  // instead of claiming the proxy route is active (catalog/fast_mode were still written).
  //
  // The client-compaction form writes a provider table as well, so "nothing was injected" would
  // misdescribe the file it just produced: new threads do use the injected table. Report that
  // mixed result on its own terms, and never tell the operator to delete a setting of theirs.
  // Ownership alone says nothing about destination: their line may already target this proxy.
  if (effectivePlan.keptUserBaseUrl && effectivePlan.keepRootOverrideAlongsideTable) {
    return {
      success: true,
      ...(effectivePlan.nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning: effectivePlan.nativeSubagentDefaultsWarning } : {}),
      ...(effectivePlan.historyRelabelRefusal ? { historyPreflightFailureReason: effectivePlan.historyRelabelRefusal } : {}),
      message:
        `Injected opencodex as default provider into Codex config (client-side compaction mode; ChatGPT auth remains required).\n` +
        `  Your root openai_base_url was left exactly as you set it, so opencodex did not add its own.\n` +
        catalogMessage +
        historyMessage +
        effectivePlan.managedDefaultsMessage +
        `  New threads use the injected opencodex provider and route through the proxy.\n` +
        `  Threads already tagged openai resolve through Codex's built-in provider, which your root openai_base_url points at.\n` +
        `  No root URL change is required to enable client-side compaction for new threads.\n` +
        `  Fallback: codex --profile opencodex (same behavior)`,
    };
  }
  if (effectivePlan.keptUserBaseUrl) {
    return {
      success: true,
      ...(effectivePlan.nativeSubagentDefaultsWarning
        ? { nativeSubagentDefaultsWarning: effectivePlan.nativeSubagentDefaultsWarning }
        : {}),
      ...(effectivePlan.historyRelabelRefusal ? { historyPreflightFailureReason: effectivePlan.historyRelabelRefusal } : {}),
      message:
        `⚠️ Codex routing NOT injected: your config already sets a root openai_base_url, and opencodex never overwrites a user-owned override.\n` +
        catalogMessage +
        historyMessage +
        effectivePlan.managedDefaultsMessage +
        `  To route plain codex through the proxy, remove your openai_base_url line from ~/.codex/config.toml and rerun 'ocx start'.\n` +
        `  Reference config: ${CODEX_PROFILE_PATH}`,
    };
  }
  const headline = routingTarget.desktopAuthless === true
    ? `Injected opencodex as default provider into Codex config (authless Desktop mode: requires_openai_auth = false).\n`
    : routingTarget.clientCompaction === true
      ? `Injected opencodex as default provider into Codex config (client-side compaction mode; ChatGPT auth remains required).\n`
    : effectivePlan.providerTableMode
      ? `Injected opencodex as default provider into Codex config.\n`
      : `Pointed Codex's built-in openai provider at the opencodex proxy (openai_base_url + realtime sideband override).\n`;
  return {
    success: true,
    ...(effectivePlan.nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning: effectivePlan.nativeSubagentDefaultsWarning } : {}),
    ...(effectivePlan.historyRelabelRefusal ? { historyPreflightFailureReason: effectivePlan.historyRelabelRefusal } : {}),
    message:
      headline +
      catalogMessage +
      historyMessage +
      effectivePlan.managedDefaultsMessage +
      `  All models now route through opencodex proxy (like OpenRouter).\n` +
      `  OpenAI models (gpt-5.5, etc.) are passed through to OpenAI.\n` +
      `  Custom models route to their configured providers.\n` +
      (effectivePlan.providerTableMode
        ? `  Fallback: codex --profile opencodex (same behavior)`
        : `  Fallback reference: ${CODEX_PROFILE_PATH}`),
  };
}

export function getCodexConfigPath(): string {
  return CODEX_CONFIG_PATH;
}

/**
 * Frame one failed apply history job honestly.
 *
 * A genuine lock keeps the established deferred/SKIPPED wording; any other
 * reason names itself instead of blaming the Codex app/IDE.
 */
export function formatApplyHistoryFailure(outcome: CodexHistoryJobOutcome, legacyMode: boolean): string {
  // A busy database is a deferral no matter which half observed it: the lock
  // contended (blocked/busy), or the worker acquired the lock and then found
  // SQLite busy (failed with a busy history reason). Only those keep the
  // deferred headline; every other failure is a real "NOT changed".
  const busy =
    (outcome.kind === "blocked" && outcome.reason === "busy") ||
    (outcome.kind === "failed" && outcome.historyFailureReason === "busy");
  const partiallyChanged = outcome.kind === "failed"
    && ((outcome.rows ?? 0) > 0 || (outcome.files ?? 0) > 0);
  const headline = partiallyChanged
    ? "Codex resume history changed but did not converge"
    : legacyMode
      ? "Codex resume history sync SKIPPED"
      : busy
      ? "Codex resume history metadata restore deferred"
      : "Codex resume history NOT changed";
  return `  ⚠️ ${headline}: ${describeHistoryJobFailure(outcome, "apply", legacyMode)}\n`;
}

export {
  providerBaseHost,
  standaloneCodexRoutingTarget,
} from "./inject/routing-target";
export type { CodexRoutingTarget } from "./inject/routing-target";

export {
  applyEol,
  buildOpenaiBaseUrlLine,
  buildProfileFile,
  buildProviderTableBlock,
  buildRealtimeWsBaseUrlLine,
  chooseCatalogPathForInjection,
  currentExternalCodexModelProvider,
  dominantEol,
  externalCodexModelProvider,
  setRootOpenaiBaseUrl,
  setRootRealtimeWsBaseUrl,
  stripInjectedOpenaiBaseUrl,
  stripRootContextWindowOverrides,
} from "./inject/config-toml";

export {
  classifyCodexRouting,
  getCodexRoutingKind,
  isCodexRoutingInjected,
} from "./inject/routing-classify";
export type { CodexRoutingKind } from "./inject/routing-classify";

export {
  removeCodexConfig,
  stripOpencodexConfig,
} from "./inject/remove";

export type {
  CodexNativeRestoreResult,
  CodexRestoreArtifactState,
  CodexRestoreCatalogResult,
  CodexRestoreConfigResult,
  CodexRestoreHistoryResult,
} from "./inject/restore";
export {
  failedHistoryRestoreFromOutcome,
  restoreNativeCodex,
  restoreNativeCodexAsync,
  setBeforeRestoreConfigForTests,
  skippedRestoreEnvelope,
} from "./inject/restore";

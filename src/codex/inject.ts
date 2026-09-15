import { existsSync, readFileSync } from "node:fs";
import {
  atomicWriteFile,
  loadConfig,
  observeConfigGeneration,
  readConfigAdmissionSnapshot,
  websocketsEnabled,
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
import { preflightCodexHistoryInjection } from "./history-provider";
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
  stripJournaledOpenaiBaseUrl,
} from "./injected-marker";
import {
  CODEX_CONFIG_PATH,
  CODEX_PROFILE_PATH,
  getCodexHome,
  resolveCodexStateDbPath,
  tomlString,
} from "./paths";
import { transformManagedSubagentDefaults } from "./subagent-defaults";
import type { OcxConfig } from "../types";
import {
  configuredManagedSubagentDefaults,
  standaloneCodexRoutingTarget,
  usesProviderTable,
  validateCodexRoutingTarget,
  type CodexRoutingTarget,
} from "./inject/routing-target";
import {
  applyEol,
  buildProfileFileForTarget,
  buildProviderTableBlockForTarget,
  chooseCatalogPathForInjection,
  dominantEol,
  ensureFastModeFeature,
  externalCodexModelProvider,
  normalizeServiceTier,
  removeProfileSection,
  setRootModelCatalogPath,
  setRootModelProvider,
  setRootOpenaiBaseUrlForTarget,
  setRootRealtimeWsBaseUrl,
  stripExistingModelProvider,
  stripInjectedOpenaiBaseUrl,
  stripOpencodexCatalogPath,
  stripRootContextWindowOverrides,
} from "./inject/config-toml";
import { hasOcxProviderTable, removeOcxSection } from "./inject/remove";


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
  /** `hub-gated` is the hub-role gate (#4236), distinct from the user's own OFF switch. */
  skippedReason?: "desired_disabled" | "desired_enabled" | "hub-gated";
  nativeSubagentDefaultsWarning?: string;
}

/**
 * The one history preflight reason that is permanent rather than operational: Codex owns
 * paginated rollout ordinals, so no retry makes the legacy relabel protocol available again.
 */
const HISTORY_RELABEL_STANDS_DOWN = "history_paginated_requires_native_writer";

class CodexHistoryPreflightRefusal extends Error {}
let historyArtifactStageForTests: ((stage: string) => void) | undefined;
export function setHistoryArtifactStageForTests(hook: typeof historyArtifactStageForTests): void {
  historyArtifactStageForTests = hook;
}
let beforeHistoryArtifactCommitForTests: ((kind: string) => void) | undefined;
export function setBeforeHistoryArtifactCommitForTests(hook: typeof beforeHistoryArtifactCommitForTests): void {
  beforeHistoryArtifactCommitForTests = hook;
}

export async function injectCodexConfig(
  port: number,
  config?: OcxConfig,
  options: InjectCodexOptions = {},
): Promise<CodexInjectResult> {
  try { return await injectCodexConfigImpl(port, config, options); }
  catch (error) {
    if (error instanceof CodexHistoryPreflightRefusal) return { success: false, historyPreflightFailureReason: error.message, message: `Codex config injection refused: ${error.message}. Existing configuration and history were preserved.` };
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
  const preflightTableMode = usesProviderTable(routingTarget);
  const compactionOnly = routingTarget.clientCompaction === true
    && routingTarget.desktopAuthless !== true
    && routingTarget.requiresAdmissionToken !== true;
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

  // Marker-owned native defaults are OpenCodex residue, never part of the
  // user's journal baseline. Clean them before either snapshotting or adding a
  // root routing key: inserting that key ahead of a marker-owned first table
  // would otherwise separate the table marker from its header. Ambiguous
  // markers fail closed without writing config, profile, or journal state.
  const nativeDefaultsBaseline = transformManagedSubagentDefaults(
    rawContent,
    null,
  );
  if (!nativeDefaultsBaseline.ok) {
    return {
      success: false,
      message:
        `Codex config injection refused: existing OpenCodex-managed native sub-agent defaults are ambiguous: ${nativeDefaultsBaseline.error}. ` +
        `No files were changed; inspect ${CODEX_CONFIG_PATH}.`,
    };
  }
  const baselineContent = nativeDefaultsBaseline.content;

  /*
   * The journal write used to happen HERE, before the transforms. It now happens
   * inside the write lock further down, and the transforms were hoisted above it
   * rather than the lock being narrowed to the three file writes.
   *
   * Why: the lock's witness hashes the CANDIDATE BYTES, and those are not final
   * until `profileContent` and the EOL-applied `content` exist. Opening the lock
   * before them would leave nothing to hash; keeping the journal outside the
   * lock would leave the first artifact-creating write unserialized, which is
   * the hole this edge exists to close.
   *
   * The move is safe because the region between here and the writes performs no
   * filesystem mutation — its only touch is `existsSync` on the catalog paths
   * (`chooseCatalogPathForInjection`) — and because `writeJournal` is called
   * with `configContent`, so it snapshots the baseline it is handed rather than
   * rereading `config.toml` underneath the transforms.
   */
  // EOL boundary: transforms below are LF-pure; preserve the file's dominant ending on write.
  const eol = dominantEol(rawContent);
  let content = applyEol(baselineContent, "\n");

  // Idempotent clean-up of any prior injection: drop the provider table (marker-based) and every
  // stray/mis-nested model_provider line, so re-injecting can't duplicate keys or leave the buggy
  // table-nested key behind.
  // Design B form FIRST: removeOcxSection also keys on the marker line, so a root-level
  // marker + openai_base_url pair must be gone before it scans or it would swallow root keys.
  content = stripInjectedOpenaiBaseUrl(content);
  // #1798: after a Codex app rewrite the markers are gone but the values we recorded writing
  // are still ours. Consume them by value here, BEFORE the routing form is chosen, so a
  // Design B -> provider-table transition (hostname change, authless opt-in) cannot leave our
  // own root URLs behind as if they were the user's, and so re-inject never journals them as
  // not-ours (which would make them unrestorable).
  content = stripJournaledOpenaiBaseUrl(
    content,
    journaledInjectedOpenaiBaseUrl({ readOnly: !!options.beforeClientWrite }),
    journaledInjectedRealtimeWsBaseUrl({ readOnly: !!options.beforeClientWrite }),
  );
  // Whether this home already published the provider id that its thread rows may reference.
  // Design B strips the table below; it may only stay stripped if those rows can be relabeled.
  const hadOcxProviderTableOnDisk = hasOcxProviderTable(content);
  if (hadOcxProviderTableOnDisk) {
    content = removeOcxSection(content);
  }
  content = removeProfileSection(content);
  content = stripExistingModelProvider(content);
  content = stripRootContextWindowOverrides(content);
  content = normalizeServiceTier(content);
  content = ensureFastModeFeature(content, config?.fastMode);

  const catalogPath = chooseCatalogPathForInjection(
    content,
    options.catalogPath,
  );
  content = catalogPath
    ? setRootModelCatalogPath(content, catalogPath)
    : stripOpencodexCatalogPath(content);

  // Provider-table form: non-loopback admission or an explicit Desktop policy.
  const providerTableMode = usesProviderTable(routingTarget);
  // Client compaction is the one table form that must not orphan existing threads. It changes
  // the DEFAULT provider to `opencodex`, but a thread already tagged `openai` keeps resolving
  // to Codex's built-in entry, and without the root override that entry is api.openai.com —
  // the thread would resume outside this proxy and outside configured routing. Keeping the
  // marker-owned root override alongside the table fixes that at the source: codex builds its
  // provider map as merge_configured_model_providers(built_in_model_providers(openai_base_url),
  // model_providers), so the override lands on the built-in `openai` entry when the map is
  // built, independent of which id is the default, and the merge leaves that entry alone for
  // every id except the two Amazon Bedrock ones. With the managed override in place both
  // entries point at this proxy. That is a guarantee about the line we own: when the user owns
  // the root line we inject nothing, and the built-in entry keeps whatever destination they
  // chose, so an `openai`-tagged thread follows their configuration rather than this proxy.
  //
  // Re-tagging history was the alternative and it cannot be made durable: the length-preserving
  // first-line repair cannot grow "openai" into "opencodex" without pre-existing padding, and
  // codex re-appends that stale first line whenever it writes git or memory-mode metadata.
  //
  // Authless is excluded on purpose: its whole point is a provider that carries
  // requires_openai_auth = false, and admission-token forms cannot use the root key at all.
  // Those two forms therefore keep their existing behaviour, forward-tagging resume history with
  // originals backed up, and that includes the case where a user enables authless and client
  // compaction together. Only the compaction-only form skips the history unit.
  const keepRootOverrideAlongsideTable = providerTableMode
    && routingTarget.clientCompaction === true
    && routingTarget.desktopAuthless !== true
    && routingTarget.requiresAdmissionToken !== true;
  let keptUserBaseUrl = false;
  let keptUserRealtimeWsBaseUrl = false;
  if (providerTableMode) {
    // Legacy (non-loopback) injection: the built-in openai provider cannot carry the
    // x-opencodex-api-key env header, so keep the opencodex provider table + root re-tag.
    // The authless opt-in needs the same table because only a dedicated provider can carry
    // requires_openai_auth = false.
    // 1) Root key BEFORE the first table header (must be a global, not nested under a table).
    content = setRootModelProvider(content);
    // 2) Provider table appended at EOF (position-independent).
    content =
      content.trimEnd() +
      "\n" +
      buildProviderTableBlockForTarget(routingTarget, websocketsEnabled(config ?? {}));
    // 3) Keep existing `openai`-tagged threads reaching the proxy (see above). Ownership rules
    // are the Design B ones: a user's own root line is never replaced.
    if (keepRootOverrideAlongsideTable) {
      content = stripInjectedOpenaiBaseUrl(content);
      const rootFallback = setRootOpenaiBaseUrlForTarget(content, routingTarget);
      content = rootFallback.content;
      keptUserBaseUrl = rootFallback.keptUserBaseUrl;
    }
  } else {
    // Design B (loopback): a single root override; codex keeps its native `openai` provider id
    // so thread history is never remapped. Any legacy form was already stripped above.
    content = stripInjectedOpenaiBaseUrl(content); // normalize before idempotent re-insert
    const result = setRootOpenaiBaseUrlForTarget(content, routingTarget);
    content = result.content;
    keptUserBaseUrl = result.keptUserBaseUrl;
    // Voice sideband override rides on the routing override: same value, same ownership rule,
    // and never when the user owns the routing line (we inject nothing in that case).
    if (!keptUserBaseUrl) {
      const realtime = setRootRealtimeWsBaseUrl(content, routingTarget);
      content = realtime.content;
      keptUserRealtimeWsBaseUrl = realtime.keptUserRealtimeWsBaseUrl;
    }
  }

  const desiredSubagentDefaults = configuredManagedSubagentDefaults(config);
  const routingOwnershipWarning =
    keptUserBaseUrl && desiredSubagentDefaults
      ? "Native Codex sub-agent defaults were not injected: a user-owned root openai_base_url prevents OpenCodex from managing active Codex routing."
      : undefined;
  const managedDefaults = transformManagedSubagentDefaults(
    content,
    keptUserBaseUrl ? null : desiredSubagentDefaults,
  );
  let nativeSubagentDefaultsWarning = routingOwnershipWarning;
  let managedDefaultsMessage = routingOwnershipWarning
    ? `  ⚠️ ${routingOwnershipWarning}\n`
    : "";
  if (managedDefaults.ok) {
    content = managedDefaults.content;
    if (desiredSubagentDefaults && managedDefaults.conflicts.length > 0) {
      const keys = managedDefaults.conflicts
        .map((conflict) => `agents.${conflict.key}`)
        .join(", ");
      nativeSubagentDefaultsWarning = `Native Codex sub-agent defaults were not injected: user-owned ${keys} preserved.`;
      managedDefaultsMessage = `  ⚠️ ${nativeSubagentDefaultsWarning}\n`;
    }
  } else {
    const action =
      desiredSubagentDefaults && !keptUserBaseUrl
        ? "were not injected"
        : "could not be safely removed";
    nativeSubagentDefaultsWarning = `Native Codex sub-agent defaults ${action}: ${managedDefaults.error}.`;
    managedDefaultsMessage = `  ⚠️ ${nativeSubagentDefaultsWarning}\n`;
  }

  const profileContent = buildProfileFileForTarget(
    routingTarget,
    catalogPath,
    websocketsEnabled(config ?? {}),
    config?.fastMode,
  );
  content = applyEol(content, eol);

  // Resolve storage from the normalized candidate. Owned duplicate catalog keys
  // are repairable above and must not make this read-only preflight throw.
  const historyPreflight = (): string | null => {
    try {
      return preflightCodexHistoryInjection(
        preflightTableMode,
        config?.syncResumeHistory !== false && !compactionOnly,
        resolveCodexStateDbPath({ readConfig: () => content }),
      );
    } catch {
      return "history_injection_preflight_unavailable";
    }
  };
  /*
   * ONE refusal stands the relabel unit down instead of vetoing the config transition, and
   * only because it is permanent. Codex allocates paginated rollout ordinals in its own
   * writer, so `assertLegacyHistoryRecord` refuses every rollout on a current install and no
   * amount of retrying changes that. While it vetoed the write, `model_catalog_json` never
   * reached config.toml, so the app and the CLI both fell back to their built-in model list
   * while `ocx sync` still reported success.
   *
   * Every other reason — an unreadable state database, a rollout whose identity changed, a
   * preflight that could not run — describes a store that may well be relabelable on the next
   * attempt. Treating those as a stand-down would record the transition as converged and
   * suppress the relabel permanently, so they keep the hard refusal and the rollback.
   */
  /*
   * Re-observed inside the artifact transaction. A store that migrates to paginated history
   * mid-write retires the relabel unit, because the config half writes no history and rolling
   * it back is what left every paginated home with no OpenCodex models. Any other reason is
   * still treated as a failed transition so compensation can restore the pre-images.
   */
  const observeHistoryRefusalOrThrow = (known: string | null): string | null => {
    if (known) return known;
    const observed = historyPreflight();
    if (observed && observed !== HISTORY_RELABEL_STANDS_DOWN) throw new CodexHistoryPreflightRefusal(observed);
    return observed;
  };
  const observedHistoryRefusal = historyPreflight();
  if (observedHistoryRefusal && observedHistoryRefusal !== HISTORY_RELABEL_STANDS_DOWN) {
    return {
      success: false,
      historyPreflightFailureReason: observedHistoryRefusal,
      message: `Codex config injection refused: ${observedHistoryRefusal}. `
        + "Existing provider definitions and conversation files were preserved. "
        + "Paginated history requires native-writer coordination; do not run legacy recovery or retry this transition blindly.",
    };
  }
  let historyRelabelRefusal = observedHistoryRefusal;

  /*
   * Rows this home may have tagged `opencodex` resolve only through a provider table. Design B
   * normally retires that table because the relabel migrates those rows back to `openai` in
   * the same pass; with the relabel stood down, stripping it anyway would leave every such
   * conversation pointing at a provider id that no longer exists. Keep what was already
   * published, and keep it BEFORE the witness so the lock admits the bytes actually written.
   */
  if (historyRelabelRefusal && hadOcxProviderTableOnDisk && !providerTableMode) {
    content = applyEol(
      content.trimEnd() + "\n" + buildProviderTableBlockForTarget(routingTarget, websocketsEnabled(config ?? {})),
      eol,
    );
  }

  /*
   * The witness, built from the FINAL bytes. Everything it hashes is either the
   * output about to be written or evidence that can be re-read under the lock;
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
  const candidate = {
    configBytes: content,
    profileBytes: profileContent,
    catalogPath,
  };
  const witness = buildInjectWitness(
    candidate,
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

  const journalBaselineIsNative = (): boolean => {
    // Value evidence survives an app rewrite that removes the ownership comments.
    const journaledBaseUrl = journaledInjectedOpenaiBaseUrl({ readOnly: true });
    const journaledRealtimeWsBaseUrl = journaledInjectedRealtimeWsBaseUrl({ readOnly: true });
    const looksInjectedByValue =
      (journaledBaseUrl !== null && rootTomlString(rawContent, "openai_base_url") === journaledBaseUrl)
      || (journaledRealtimeWsBaseUrl !== null
        && rootTomlString(rawContent, REALTIME_WS_BASE_URL_KEY) === journaledRealtimeWsBaseUrl);
    return !hasInjectedCodexRouting(rawContent) && !looksInjectedByValue;
  };
  const readCurrentProfile = (): string | null => existsSync(CODEX_PROFILE_PATH)
    ? readFileSync(CODEX_PROFILE_PATH, "utf-8")
    : null;
  const unverifiedJournalMessage = "Codex configuration was not written: the journal has no verified baseline for the current config/profile. Current files and the journal were preserved.";
  if (!journalBaselineIsNative() && hasUnverifiedJournalBaseline(baselineContent, readCurrentProfile())) {
    return { success: false, message: unverifiedJournalMessage };
  }

  if (options.validateOnly) {
    return {
      success: true,
      ...(historyRelabelRefusal ? { historyPreflightFailureReason: historyRelabelRefusal } : {}),
      message: "Codex config injection preflight passed; no files were changed.",
    };
  }

  const applyNativeArtifacts = (): void => {
    beforeHistoryArtifactCommitForTests?.(eligibility.kind);
    historyRelabelRefusal = observeHistoryRefusalOrThrow(historyRelabelRefusal);
    const preImages = captureCodexPreImages();
    try {
    historyArtifactStageForTests?.("after-preflight");
    writeJournal({
      currentStateIsNative: journalBaselineIsNative(),
      configContent: baselineContent,
      owner: options.journalOwner,
    });
    // A native snapshot may have been refreshed above. An older hashless routed snapshot
    // must not gain the new injection's hash and later overwrite preserved user edits.
    if (hasUnverifiedJournalBaseline(baselineContent, readCurrentProfile())) throw new Error(unverifiedJournalMessage);
    atomicWriteFile(CODEX_CONFIG_PATH, content);
    historyArtifactStageForTests?.("after-config");
    atomicWriteFile(CODEX_PROFILE_PATH, profileContent);
    markJournalInjectedState(content, profileContent, {
      // A root override is ours whenever we wrote one and no user-owned value won. That is
      // loopback Design B, and now also the client-compaction form, which keeps the same
      // marker-owned root line beside its provider table. Journaling it matters because the
      // marker comment is not durable: the Codex app can reserialize config.toml and drop
      // comments, and restore then has only the journaled value to tell our line from a user's
      // (#1798). The other table forms never write the key, so they still record null.
      injectedOpenaiBaseUrl: (providerTableMode && !keepRootOverrideAlongsideTable) || keptUserBaseUrl
        ? null
        : rootTomlString(content, "openai_base_url"),
      // The sideband override is ours only when we wrote it this pass (never in legacy mode,
      // never when the user owns either key).
      injectedRealtimeWsBaseUrl: providerTableMode || keptUserBaseUrl || keptUserRealtimeWsBaseUrl
        ? null
        : rootTomlString(content, REALTIME_WS_BASE_URL_KEY),
      // This is the catalog artifact selected for this injection, even when config.toml
      // already points at that path and therefore needs no textual rewrite.
      injectedCatalogPath: catalogPath,
    });
    historyArtifactStageForTests?.("after-artifacts");
    // Detect migration throughout the artifact transaction, not just at entry.
    historyRelabelRefusal = observeHistoryRefusalOrThrow(historyRelabelRefusal);
    } catch (error) {
      const compensated = restoreCodexPreImages(preImages);
      if (!compensated.complete) throw new CodexPartialWriteError(compensated.unrestored);
      throw error;
    }
  };

  /*
   * Set only on the coordinated path: the generation/txId the transition just
   * committed. The terminal history update CASes against this, so a job that
   * was overtaken cannot overwrite the winner. Stays undefined for a
   * legacy-uncoordinated home, which publishes no transition to resolve.
   */
  let transitionReceipt: { nativeGeneration: number; currentTxId: string } | undefined;

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
      applyNativeArtifacts();
    };
    // Only connected guarded writes add C here. A concurrent disconnect claim
    // either follows this commit or is observed by the guard before any write.
    const skipped = options.beforeClientWrite
      ? withConfigMutationLockSync(applyLegacy)
      : applyLegacy();
    if (skipped) return skipped;
  } else {
    const coordinated = await withCodexWriteLock(
      {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_INJECT_LOCK_TIMEOUT_MS,
        ...(eligibility.kind === "adopt" ? { adoption: { direction: "apply" as const } } : {}),
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
         * Publish BEFORE touching the filesystem. `assertPublished` runs after this
         * callback returns and throws unless a transition was recorded, so writing
         * first would replace every file and only then fail — with SQLite rolling
         * back and the filesystem staying changed.
         *
         * `beginTransition` returns a conflict rather than throwing, so its result
         * is checked here; ignoring it would reach the same failure by a slower
         * route.
         */
        const published = ctx.coordinator.beginTransition(
          {
            nativeGeneration: ctx.expectation.nativeBefore,
            currentTxId: ctx.currentTxId,
          },
          {
            txId: ctx.expectation.txId,
            direction: "apply",
            authoritySnapshotId: ctx.admission.authoritySnapshotId,
            nextRetryAt: new Date().toISOString(),
          },
        );
        if (published.kind !== "updated") {
          throw new CodexWriteConflictError(
            `The Codex transition could not be published: ${published.kind}.`,
          );
        }

        /*
         * Exact pre-images, captured under the lock and used for compensation.
         *
         * A rolled-back coordinator row is not a rolled-back filesystem: each
         * `atomicWriteFile` is atomic alone, never across the three together, so a
         * failure partway leaves earlier replacements in place. `restoreJournalState`
         * cannot be the undo — it restores whichever journal occupies the path,
         * which need not be the one this operation wrote.
         */
        const preImages = captureCodexPreImages();
        try {
          applyNativeArtifacts();
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
  const historyOutcome: CodexHistoryJobOutcome = historyRelabelRefusal
    ? { kind: "skipped" }
    : await runCodexHistoryJob({
      ...resolveCodexHistoryJobTarget(),
      expectedDesiredEnabled: true,
      operation: deriveCodexHistoryOperation({
        direction: "apply",
        resumeHistory: config?.syncResumeHistory !== false && !keepRootOverrideAlongsideTable,
        legacyMode: providerTableMode,
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

  const catalogMessage = catalogPath
    ? `  Codex model catalog: ${catalogPath}\n`
    : `  Codex model catalog not injected because no opencodex catalog file exists yet.\n`;
  const ejected = (history as { ejectedRows?: number }).ejectedRows ?? 0;
  const migratedRows = (history.rows ?? 0) + ejected;
  const historyMessage =
    keepRootOverrideAlongsideTable
      ? (keptUserBaseUrl
        ? `  Codex resume history: left unchanged; threads already tagged openai follow your configured root openai_base_url.\n`
        : `  Codex resume history: left unchanged; existing threads keep reaching the proxy through the retained openai_base_url override.\n`)
      : historyRelabelRefusal
      ? `  ⚠️ Codex resume history: left to Codex's native writer (${historyRelabelRefusal}); existing threads keep the provider they are tagged with. Routing and the model catalog were still installed, so new threads reach the proxy.\n`
      : config?.syncResumeHistory === false
      ? `  Codex resume history: left unchanged (syncResumeHistory=false).\n`
      : history.failed
        ? formatApplyHistoryFailure(historyOutcome, providerTableMode)
        : providerTableMode
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
  if (keptUserBaseUrl && keepRootOverrideAlongsideTable) {
    return {
      success: true,
      ...(nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning } : {}),
      ...(historyRelabelRefusal ? { historyPreflightFailureReason: historyRelabelRefusal } : {}),
      message:
        `Injected opencodex as default provider into Codex config (client-side compaction mode; ChatGPT auth remains required).\n` +
        `  Your root openai_base_url was left exactly as you set it, so opencodex did not add its own.\n` +
        catalogMessage +
        historyMessage +
        managedDefaultsMessage +
        `  New threads use the injected opencodex provider and route through the proxy.\n` +
        `  Threads already tagged openai resolve through Codex's built-in provider, which your root openai_base_url points at.\n` +
        `  No root URL change is required to enable client-side compaction for new threads.\n` +
        `  Fallback: codex --profile opencodex (same behavior)`,
    };
  }
  if (keptUserBaseUrl) {
    return {
      success: true,
      ...(nativeSubagentDefaultsWarning
        ? { nativeSubagentDefaultsWarning }
        : {}),
      ...(historyRelabelRefusal ? { historyPreflightFailureReason: historyRelabelRefusal } : {}),
      message:
        `⚠️ Codex routing NOT injected: your config already sets a root openai_base_url, and opencodex never overwrites a user-owned override.\n` +
        catalogMessage +
        historyMessage +
        managedDefaultsMessage +
        `  To route plain codex through the proxy, remove your openai_base_url line from ~/.codex/config.toml and rerun 'ocx start'.\n` +
        `  Reference config: ${CODEX_PROFILE_PATH}`,
    };
  }
  const headline = routingTarget.desktopAuthless === true
    ? `Injected opencodex as default provider into Codex config (authless Desktop mode: requires_openai_auth = false).\n`
    : routingTarget.clientCompaction === true
      ? `Injected opencodex as default provider into Codex config (client-side compaction mode; ChatGPT auth remains required).\n`
    : providerTableMode
      ? `Injected opencodex as default provider into Codex config.\n`
      : `Pointed Codex's built-in openai provider at the opencodex proxy (openai_base_url + realtime sideband override).\n`;
  return {
    success: true,
    ...(nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning } : {}),
    ...(historyRelabelRefusal ? { historyPreflightFailureReason: historyRelabelRefusal } : {}),
    message:
      headline +
      catalogMessage +
      historyMessage +
      managedDefaultsMessage +
      `  All models now route through opencodex proxy (like OpenRouter).\n` +
      `  OpenAI models (gpt-5.5, etc.) are passed through to OpenAI.\n` +
      `  Custom models route to their configured providers.\n` +
      (providerTableMode
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


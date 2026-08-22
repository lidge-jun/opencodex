import { join } from "node:path";

import { getConfigDir, websocketsEnabled, withExpectedConfigGenerationSync } from "../config";
import { COMBO_NAMESPACE } from "../combos";
import { getAuthStorePath } from "../oauth/store";
import type { OcxConfig } from "../types";
import { captureCatalogAdmissionSnapshot } from "./catalog-admission";
import { legacyCustomModelCatalogSlugs } from "./custom-model-catalog-migration";
import {
  type CatalogGatherPathKind,
  type CatalogSourceForGather,
  bundledCatalogCacheState,
  resolveCatalogSourceForGather,
  } from "./catalog/bundled";
  import {
  acceptCatalogGatherSourcePath,
  captureAndSealCatalogHomeSelection,
  captureCatalogGatherTargetIdentity,
  createCatalogGatherEvidenceSession,
  readCatalogGatherSource,
  sealCatalogGatherEvidenceSession,
  type CatalogFilesystemEvidenceSession,
  } from "./catalog/filesystem-evidence";
  import {
  CatalogGatherBusyError,
  createCatalogGatherAuthorityIdentity,
  filterCatalogVisibleModels,
  gatherRoutedModelsForCatalogGather,
  type CatalogGatherProviderAuthOutcome,
  type CatalogGatherProviderModelOutcome,
  } from "./catalog/provider-fetch";
  import {
  catalogBackupPathFor,
  catalogHasRoutedEntries,
  findNativeTemplate,
  legacyCatalogBackupPath,
  parseCatalogJson,
  type RawCatalog,
  type RawEntry,
  } from "./catalog/parsing";
  import {
  buildCatalogEntriesFromObservedState,
  CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
  mergeCatalogEntriesFromObservedState,
  mergeCatalogModelsWithNativeRecovery,
  orderForSubagents,
  } from "./catalog/sync";
  import { multiAgentV2EnabledFromConfigText } from "./features";
  import { exactComboCatalogSlugs } from "./catalog/aggregation";
  import {
  isNativeAliasCatalogEntry,
  accountBoundNativeOpenAiSlugs,
  accountBoundNativeOpenAiSlugsBySelector,
  disabledNativeSlugs,
  desktopAllowlistSuppressedNativeSlugs,
  NATIVE_OPENAI_MODELS,
  shouldIncludeAccountBoundNativeOpenAi,
  shouldIncludeNativeOpenAi,
} from "./catalog/metadata";
import {
  trustedAccountBoundNativeCatalogSlug,
  visibleCodexAccountSelectors,
} from "./catalog/account-models";
import {
  clampCatalogModelsToObservedCodexSupport,
  supportedCodexReasoningEffortsFromObservedCatalog,
} from "./catalog/effort";
import { codexRuntimeStatePath, peekCodexRuntimeProcessCache } from "./runtime";
import { codexAccountNamespaceEntries, isMainCodexAccountTarget } from "./account-namespaces";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import {
  availableAccountGatedNativeModels,
  isCodexModelEntitlementSnapshotCurrent,
  resolveCodexModelEntitlements,
  type CodexModelEntitlementSnapshot,
} from "./model-entitlements";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "./catalog/native-models";
import { providerCodexAccountMode } from "../providers/registry";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { withCatalogWriteSerialization } from "./catalog-write-serialization";
import {
  publishHashedCodexCatalogBackup,
  publishLegacyCodexCatalogBackup,
  replaceActiveCodexCatalog,
  replaceCodexModelsCache,
  type PreparedCatalogFileWrite,
} from "./internal/catalog-writer";
import type {
  CatalogAdmissionSnapshot,
  CatalogDisposition,
  CatalogGatherAuthorityIdentity,
  CatalogNotice,
  CatalogProviderDiscoveryPolicySnapshot,
  CatalogProcessLocalEvidence,
  CatalogSourceEvidence,
  CatalogSourceRole,
  ConvergeRequest,
} from "./convergence-types";

export interface CatalogWriteReceipt {
  readonly keyedBackup: "written" | "preserved" | "not-requested";
  readonly legacyBackup: "written" | "preserved" | "not-requested";
  readonly catalog: "written" | "not-written";
  readonly cache: "written" | "not-written";
}

export type CodexCatalogCommitResult =
  | { readonly kind: "committed"; readonly changed: boolean; readonly writes: CatalogWriteReceipt }
  | { readonly kind: "stale"; readonly reason: "generation" | "home-selection" | "source-observation" | "process-local" | "target-identity" | "candidate-consumed" | "account-entitlement" }
  | { readonly kind: "refused"; readonly reason: "source-unreadable" | "source-ambiguous" | "target-unsafe" }
  | { readonly kind: "failed"; readonly surface: "disk"; readonly writes: CatalogWriteReceipt };

declare const catalogCandidateBrand: unique symbol;
export interface CodexCatalogCandidate { readonly [catalogCandidateBrand]: true }

export type CodexCatalogGatherResult =
  | { readonly kind: "candidate"; readonly candidate: CodexCatalogCandidate }
  | { readonly kind: "disposition"; readonly disposition: CatalogDisposition };

type CommitAttempt = CodexCatalogCommitResult | { readonly kind: "busy" };

interface CandidateState {
  consumed: boolean;
  readonly generation: CatalogAdmissionSnapshot["generation"];
  readonly authority: CatalogGatherAuthorityIdentity;
  readonly sourceEvidence: CatalogSourceEvidence;
  readonly processLocal: CatalogProcessLocalEvidence;
  readonly home: string;
  readonly targets: CatalogAdmissionSnapshot["targets"];
  readonly catalog: PreparedCatalogFileWrite;
  readonly cache: PreparedCatalogFileWrite;
  readonly keyedBackup?: PreparedCatalogFileWrite;
  readonly legacyBackup?: PreparedCatalogFileWrite;
  readonly changed: boolean;
  readonly notices: readonly CatalogNotice[];
  readonly modelEntitlements: CodexModelEntitlementSnapshot;
}

const candidateStates = new WeakMap<object, CandidateState>();
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetPath(identity: string): string {
  const parsed = JSON.parse(identity) as { path?: unknown };
  if (typeof parsed.path !== "string") throw new TypeError("Catalog target identity has no path.");
  return parsed.path;
}

function catalogFrom(bytes: Uint8Array | null): RawCatalog | null {
  return bytes === null ? null : parseCatalogJson(Buffer.from(bytes).toString("utf8"));
}

function catalogBytes(catalog: RawCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function nativePriorityBaseline(catalog: ReadonlyRawCatalogLike | null): Map<string, number> {
  return new Map((catalog?.models ?? []).flatMap(entry => (
    typeof entry.slug === "string"
      && !entry.slug.includes("/")
      && typeof entry.priority === "number"
      ? [[entry.slug, entry.priority] as const]
      : []
  )));
}

interface ReadonlyRawCatalogLike {
  readonly models?: readonly Readonly<Record<string, unknown>>[];
}

function hasRoutedEntries(catalog: ReadonlyRawCatalogLike): boolean {
  return (catalog.models ?? []).some(entry => typeof entry.slug === "string"
    && (entry.slug.includes("/") || isNativeAliasCatalogEntry(entry as RawEntry)));
}

function processEvidence(source: CatalogSourceForGather): CatalogProcessLocalEvidence {
  return Object.freeze({
    runtime: Object.freeze({ ...source.processLocal.runtime }),
    bundledCatalog: Object.freeze({ ...source.processLocal.bundledCatalog }),
  });
}

function bindGatherPaths(
  session: CatalogFilesystemEvidenceSession,
  snapshot: CatalogAdmissionSnapshot,
): Readonly<{
  catalog: string;
  cache: string;
  keyedBackup: string;
  legacyBackup?: string;
  catalogKind: CatalogGatherPathKind;
  multiAgentV2Enabled: boolean;
}> {
  const catalog = targetPath(snapshot.targets.catalog);
  const cache = targetPath(snapshot.targets.cache);
  const keyedBackup = targetPath(snapshot.targets.catalogBackups[0]!);
  const legacyBackup = snapshot.targets.catalogBackups[1]
    ? targetPath(snapshot.targets.catalogBackups[1]) : undefined;
  const configPath = snapshot.sourceEvidence.required["catalog-target-selection"].logicalPath;

  acceptCatalogGatherSourcePath(session, "catalog-target-selection", configPath);
  const configBytes = readCatalogGatherSource(session, "catalog-target-selection");
  acceptCatalogGatherSourcePath(session, "active-catalog-merge", catalog);
  acceptCatalogGatherSourcePath(session, "hashed-backup-fallback", keyedBackup);
  acceptCatalogGatherSourcePath(session, "legacy-backup-fallback", legacyBackup ?? legacyCatalogBackupPath());
  acceptCatalogGatherSourcePath(session, "models-cache-fallback", cache);
  acceptCatalogGatherSourcePath(session, "runtime-selection", codexRuntimeStatePath(getConfigDir()));
  acceptCatalogGatherSourcePath(session, "provider-auth-selection", getAuthStorePath());
  acceptCatalogGatherSourcePath(session, "native-catalog-selection", catalog);
  return {
    catalog,
    cache,
    keyedBackup,
    ...(legacyBackup ? { legacyBackup } : {}),
    catalogKind: legacyBackup ? "default" : "custom",
    multiAgentV2Enabled: multiAgentV2EnabledFromConfigText(
      configBytes === null ? null : Buffer.from(configBytes).toString("utf8"),
    ),
  };
}

function prepareCatalog(
  config: Readonly<OcxConfig>,
  source: Extract<CatalogSourceForGather, { kind: "available" }>,
  active: RawCatalog | null,
  routedModels: Awaited<ReturnType<typeof gatherRoutedModelsForCatalogGather>>,
  multiAgentV2Enabled: boolean,
  baseline: ReadonlyMap<string, number>,
  baselineCatalogModels: readonly Readonly<Record<string, unknown>>[],
  degradedProviderNames: ReadonlySet<string>,
  modelEntitlements: CodexModelEntitlementSnapshot,
  nativeRecoverySources: readonly (readonly RawEntry[])[] = [],
  observedAccountNativeEntries: readonly RawEntry[] = [],
): RawCatalog {
  const catalog = JSON.parse(JSON.stringify(source.catalog)) as RawCatalog;
  const template = findNativeTemplate(catalog);
  const enabled = filterCatalogVisibleModels(routedModels, config);
  const featured = config.subagentModels ?? [];
  const ordered = orderForSubagents(enabled, featured);
  const modelPickerOrder = config.modelPickerOrder ?? [];
  const multiAgentMode = config.multiAgentMode === "v1" || config.multiAgentMode === "v2"
    ? config.multiAgentMode : "default";
  const exactComboSlugs = exactComboCatalogSlugs(config);
  const bareEligibleAccountIds = providerCodexAccountMode(
    OPENAI_CODEX_PROVIDER_ID,
    config.providers[OPENAI_CODEX_PROVIDER_ID],
  ) === "direct" ? new Set([MAIN_CODEX_ACCOUNT_ID]) : undefined;
  const availableBareGatedNativeSlugs = availableAccountGatedNativeModels(
    modelEntitlements,
    bareEligibleAccountIds,
  );
  const availableAccountGatedNativeSlugs = availableAccountGatedNativeModels(modelEntitlements);
  const availableBareNativeSlugs = NATIVE_OPENAI_MODELS.filter(slug => (
    !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableBareGatedNativeSlugs.has(slug)
  ));
  const availableAccountNativeSlugs = NATIVE_OPENAI_MODELS.filter(slug => (
    !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableAccountGatedNativeSlugs.has(slug)
  ));
  const suppressedBareNativeSlugs = new Set([
    ...desktopAllowlistSuppressedNativeSlugs(config),
    ...[...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(slug => !availableBareGatedNativeSlugs.has(slug)),
  ]);
  const hasPhysicalComboProvider = Object.hasOwn(config.providers, COMBO_NAMESPACE);
  const enabledProviders = Object.entries(config.providers).filter(([, provider]) => provider.disabled !== true);
  const includeNativeOpenAi = shouldIncludeNativeOpenAi(config);
  const accountSelectors = shouldIncludeAccountBoundNativeOpenAi(config)
    ? visibleCodexAccountSelectors(config)
    : [];
  const accountTargets = new Map(codexAccountNamespaceEntries(config));
  const accountNativeSlugsBySelector = accountSelectors.length > 0
    ? new Map([...accountBoundNativeOpenAiSlugsBySelector(config, observedAccountNativeEntries)].map(([selector, slugs]) => {
      const target = accountTargets.get(selector);
      const accountId = target && isMainCodexAccountTarget(target) ? MAIN_CODEX_ACCOUNT_ID : target;
      const entitled = accountId ? modelEntitlements.modelsByAccount.get(accountId) : undefined;
      const confirmed = accountId ? modelEntitlements.confirmedAccountIds.has(accountId) : false;
      return [selector, slugs.filter(slug => (
        !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || (confirmed && entitled?.has(slug) === true)
      ))] as const;
    }))
    : new Map<string, readonly string[]>();
  const accountNativeSlugs = accountSelectors.length > 0
    ? [...new Set([...accountNativeSlugsBySelector.values()].flatMap(slugs => [...slugs]))]
    : [];
  // Unknown account-native ids have no safe bare/global identity. They are only projected through
  // selector-qualified rows when a live selector is configured.
  const observedNativeSlugs: string[] = [];
  const disabledNative = disabledNativeSlugs(config);
  const nativeCatalogModels = mergeCatalogModelsWithNativeRecovery(
    active?.models ?? catalog.models ?? [],
    [catalog.models ?? [], ...nativeRecoverySources],
  );
  const catalogModels = nativeCatalogModels;
  const routedEntries = buildCatalogEntriesFromObservedState({
    template: template ? JSON.parse(JSON.stringify(template)) : null,
    gptSlugs: [],
    goModels: ordered,
    featured,
    modelPickerOrder,
    wsEnabled: websocketsEnabled(config),
    multiAgentMode,
    exactComboSlugs,
    accountSelectors,
    suppressedBareNativeSlugs,
    disabledNativeAccountSlugs: new Set(),
    multiAgentV2Enabled,
  });
  const accountBoundEntries = accountSelectors.length === 0
    ? []
    : buildCatalogEntriesFromObservedState({
      template: template ? JSON.parse(JSON.stringify(template)) : null,
      gptSlugs: availableAccountNativeSlugs,
      goModels: [],
      featured,
      wsEnabled: websocketsEnabled(config),
      multiAgentMode,
      exactComboSlugs,
      accountSelectors,
      suppressedBareNativeSlugs,
      disabledNativeAccountSlugs: new Set([...disabledNative].filter(slug => suppressedBareNativeSlugs.has(slug))),
      multiAgentV2Enabled,
      keepNativeChatGptOnV1: config.keepNativeChatGptOnV1 === true,
      accountNativeSlugs,
      accountNativeSlugsBySelector,
    }).filter(entry => trustedAccountBoundNativeCatalogSlug(entry) !== undefined);
  const gatheredProviderNames = new Set(enabledProviders.map(([name]) => name));
  const selectedModelsByProvider = new Map<string, ReadonlySet<string>>(
    enabledProviders.flatMap(([name, provider]) => (
      Array.isArray(provider.selectedModels) && provider.selectedModels.length > 0
        ? [[name, new Set(provider.selectedModels)] as const]
        : []
    )),
  );
  const mergedModels = mergeCatalogEntriesFromObservedState({
    catalogModels,
    baselineCatalogModels,
    routedEntries,
    baseline,
    featured,
    wsEnabled: websocketsEnabled(config),
    template,
    disabledModels: new Set(config.disabledModels ?? []),
    selectedModelsByProvider,
    gatheredProviderNames,
    degradedProviderNames,
    legacyCustomModelSlugs: legacyCustomModelCatalogSlugs(config),
    multiAgentMode,
    multiAgentV2Enabled,
    keepNativeChatGptOnV1: config.keepNativeChatGptOnV1 === true,
    exactComboSlugs,
    hasPhysicalComboProvider,
    includeNativeOpenAi,
    accountBoundEntries,
    suppressedBareNativeSlugs,
    policy: {
      ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
      nativeBackfillSlugs: [...availableBareNativeSlugs, ...observedNativeSlugs],
      warningPolicy: "suppress",
    },
  });
  clampCatalogModelsToObservedCodexSupport(
    mergedModels,
    source.runtimeSupport.kind === "available"
      ? supportedCodexReasoningEffortsFromObservedCatalog(source.runtimeSupport.catalog)
      : null,
  );
  catalog.models = mergedModels;
  return catalog;
}

export async function gatherCodexCatalogCandidate(
  snapshot: CatalogAdmissionSnapshot,
): Promise<CodexCatalogGatherResult> {
  let providerGatherStarted = false;
  try {
    const session = createCatalogGatherEvidenceSession();
    const home = captureAndSealCatalogHomeSelection(session);
    if (!same(home, snapshot.sourceEvidence.homeSelection)) {
      return { kind: "disposition", disposition: { status: "skipped", reason: "stale", retryable: true } };
    }
    const paths = bindGatherPaths(session, snapshot);
    const source = resolveCatalogSourceForGather(session, paths.catalogKind);
    if (source.kind === "catalog-unavailable") {
      return { kind: "disposition", disposition: { status: "skipped", reason: "catalog-unavailable", retryable: false } };
    }

    const activeBytes = readCatalogGatherSource(session, "active-catalog-merge");
    const cacheBytes = readCatalogGatherSource(session, "models-cache-fallback");
    const keyedBackupBytes = readCatalogGatherSource(session, "hashed-backup-fallback");
    const legacyBackupBytes = paths.legacyBackup
      ? readCatalogGatherSource(session, "legacy-backup-fallback") : null;
    if (Object.keys(snapshot.config.combos ?? {}).length > 0) {
      readCatalogGatherSource(session, "native-catalog-selection");
    }
    const authOutcomes: CatalogGatherProviderAuthOutcome[] = [];
    const providerModelOutcomes: CatalogGatherProviderModelOutcome[] = [];
    const discoveryPolicies: CatalogProviderDiscoveryPolicySnapshot[] = [];
    providerGatherStarted = true;
    const [routedModels, modelEntitlements] = await Promise.all([
      gatherRoutedModelsForCatalogGather(snapshot.config, session, {
        providerAuthOutcomes: authOutcomes,
        providerModelOutcomes,
        discoveryPolicySnapshots: discoveryPolicies,
      }),
      resolveCodexModelEntitlements(snapshot.config),
    ]);
    const processLocal = processEvidence(source);
    const sourceEvidence = sealCatalogGatherEvidenceSession(session);
    if (!same(sourceEvidence.required, snapshot.sourceEvidence.required)) {
      return { kind: "disposition", disposition: { status: "skipped", reason: "stale", retryable: true } };
    }

    const current = captureCatalogAdmissionSnapshot(snapshot.config);
    if (!same(current.configIdentity, snapshot.configIdentity)
      || !same(current.targets, snapshot.targets)
      || !same(current.sourceEvidence.homeSelection, snapshot.sourceEvidence.homeSelection)
      || !same(current.sourceEvidence.required, snapshot.sourceEvidence.required)) {
      return { kind: "disposition", disposition: { status: "skipped", reason: "stale", retryable: true } };
    }

    const active = catalogFrom(activeBytes);
    // Retained sync restores native priorities from the once-only pristine backup. Convergence
    // must use the same admitted evidence instead of treating its already-featured active catalog
    // as the baseline, or feature A -> feature B -> none would retain stale priorities.
    const backupCanAcceptPristineCatalog = keyedBackupBytes === null
      || (paths.legacyBackup !== undefined && legacyBackupBytes === null);
    const baselineCatalog = catalogFrom(keyedBackupBytes)
      ?? catalogFrom(legacyBackupBytes)
      ?? (backupCanAcceptPristineCatalog
        ? (active && !catalogHasRoutedEntries(active)
          ? active
          : !hasRoutedEntries(source.catalog) ? source.catalog : null)
        : null);
    const preparedCatalog = prepareCatalog(
      snapshot.config,
      source,
      active,
      routedModels,
      paths.multiAgentV2Enabled,
      nativePriorityBaseline(baselineCatalog),
      baselineCatalog?.models ?? [],
      new Set(providerModelOutcomes
        .filter(outcome => outcome.state === "degraded")
        .map(outcome => outcome.provider)),
      modelEntitlements,
      [
        catalogFrom(keyedBackupBytes)?.models ?? [],
        catalogFrom(legacyBackupBytes)?.models ?? [],
      ],
      [
        ...(catalogFrom(cacheBytes)?.models ?? []),
        ...(catalogFrom(activeBytes)?.models ?? []).filter(entry =>
          trustedAccountBoundNativeCatalogSlug(entry) !== undefined),
      ],
    );
    const preparedCatalogBytes = catalogBytes(preparedCatalog);
    const preparedCacheBytes = `${JSON.stringify({
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models: preparedCatalog.models ?? [],
    }, null, 2)}\n`;
    const pristineBytes = active && !catalogHasRoutedEntries(active)
      ? Buffer.from(activeBytes!).toString("utf8")
      : !hasRoutedEntries(source.catalog) ? `${JSON.stringify(source.catalog, null, 2)}\n` : null;
    const notices = new Set<CatalogNotice>();
    const sourceIsAuthoritative = paths.catalogKind === "default"
      ? source.source === "bundled-catalog-template"
      : source.source === "active-catalog-merge";
    if (!sourceIsAuthoritative) notices.add("fallback");
    const authDegradedProviders = new Set(authOutcomes
      .filter(outcome => outcome.state !== "available")
      .map(outcome => outcome.provider));
    if (authDegradedProviders.size > 0) notices.add("provider-auth");
    if (providerModelOutcomes.some(outcome => (
      outcome.state === "degraded" && !authDegradedProviders.has(outcome.provider)
    ))) notices.add("provider-network");
    const candidate = {} as CodexCatalogCandidate;
    candidateStates.set(candidate, {
      consumed: false,
      generation: snapshot.generation,
      authority: createCatalogGatherAuthorityIdentity(
        snapshot,
        sourceEvidence,
        processLocal,
        discoveryPolicies,
      ),
      sourceEvidence,
      processLocal,
      home: home.canonicalCodexHome,
      targets: snapshot.targets,
      catalog: { path: paths.catalog, content: preparedCatalogBytes },
      cache: { path: paths.cache, content: preparedCacheBytes },
      ...(pristineBytes ? { keyedBackup: { path: paths.keyedBackup, content: pristineBytes } } : {}),
      ...(pristineBytes && paths.legacyBackup
        ? { legacyBackup: { path: paths.legacyBackup, content: pristineBytes } } : {}),
      changed: Buffer.from(activeBytes ?? []).toString("utf8") !== preparedCatalogBytes
        || Buffer.from(cacheBytes ?? []).toString("utf8") !== preparedCacheBytes,
      notices: Object.freeze([...notices]),
      modelEntitlements,
    });
    return { kind: "candidate", candidate };
  } catch (error) {
    if (error instanceof CatalogGatherBusyError) {
      return { kind: "disposition", disposition: { status: "skipped", reason: "busy", retryable: true } };
    }
    if (!providerGatherStarted) {
      return { kind: "disposition", disposition: { status: "skipped", reason: "refused", retryable: false } };
    }
    return {
      kind: "disposition",
      disposition: { status: "failed", reason: "provider-network", phase: "gather", retryable: true, partialWrite: false },
    };
  }
}

function revalidateCandidate(state: CandidateState): CodexCatalogCommitResult | null {
  if (!isCodexModelEntitlementSnapshotCurrent(state.modelEntitlements)) {
    return { kind: "stale", reason: "account-entitlement" };
  }
  let session: CatalogFilesystemEvidenceSession;
  let validatingTargets = false;
  try {
    session = createCatalogGatherEvidenceSession();
    const home = captureAndSealCatalogHomeSelection(session);
    if (!same(home, state.sourceEvidence.homeSelection)) return { kind: "stale", reason: "home-selection" };
    validatingTargets = true;
    const currentTargets = {
      catalog: captureCatalogGatherTargetIdentity(session, state.catalog.path),
      cache: captureCatalogGatherTargetIdentity(session, state.cache.path),
      catalogBackups: state.targets.catalogBackups.map(identity => (
        captureCatalogGatherTargetIdentity(session, targetPath(identity))
      )),
    };
    if (!same(currentTargets, state.targets)) return { kind: "stale", reason: "target-identity" };
    validatingTargets = false;
    for (const observation of [state.sourceEvidence.required["catalog-target-selection"]]) {
      acceptCatalogGatherSourcePath(session, observation.role, observation.logicalPath);
      readCatalogGatherSource(session, observation.role);
    }
    for (const [role, observations] of Object.entries(state.sourceEvidence.conditional)) {
      for (const observation of observations) {
        acceptCatalogGatherSourcePath(session, role as CatalogSourceRole, observation.logicalPath);
        readCatalogGatherSource(session, role as CatalogSourceRole);
      }
    }
    if (!same(sealCatalogGatherEvidenceSession(session), state.sourceEvidence)) {
      return { kind: "stale", reason: "source-observation" };
    }
  } catch {
    return { kind: "refused", reason: validatingTargets ? "target-unsafe" : "source-unreadable" };
  }

  if (state.processLocal.runtime.state === "used") {
    const current = peekCodexRuntimeProcessCache();
    if (current.kind !== "available" || current.epoch !== state.processLocal.runtime.epoch
      || current.valueIdentity !== state.processLocal.runtime.valueIdentity) {
      return { kind: "stale", reason: "process-local" };
    }
  }
  if (state.processLocal.bundledCatalog.state === "used") {
    const current = bundledCatalogCacheState();
    if (current.epoch !== state.processLocal.bundledCatalog.epoch
      || current.valueIdentity !== state.processLocal.bundledCatalog.valueIdentity) {
      return { kind: "stale", reason: "process-local" };
    }
  }
  return null;
}

function fixedCommit(state: CandidateState, permit: Parameters<typeof replaceActiveCodexCatalog>[0]): CodexCatalogCommitResult {
  let writes: CatalogWriteReceipt = {
    keyedBackup: "not-requested",
    legacyBackup: "not-requested",
    catalog: "not-written",
    cache: "not-written",
  };
  try {
    if (state.keyedBackup) {
      writes = { ...writes, keyedBackup: publishHashedCodexCatalogBackup(permit, state.home, state.keyedBackup) };
    }
    if (state.legacyBackup) {
      writes = { ...writes, legacyBackup: publishLegacyCodexCatalogBackup(permit, state.home, state.legacyBackup) };
    }
    replaceActiveCodexCatalog(permit, state.home, state.catalog);
    writes = { ...writes, catalog: "written" };
    replaceCodexModelsCache(permit, state.home, state.cache);
    writes = { ...writes, cache: "written" };
    return { kind: "committed", changed: state.changed, writes };
  } catch {
    return { kind: "failed", surface: "disk", writes };
  }
}

export async function commitCodexCatalogCandidate(
  candidate: CodexCatalogCandidate,
  deadlineMs: number,
): Promise<CommitAttempt> {
  const state = candidateStates.get(candidate as object);
  if (!state) return { kind: "refused", reason: "source-ambiguous" };
  if (state.consumed) return { kind: "stale", reason: "candidate-consumed" };
  const deadline = Date.now() + Math.max(0, deadlineMs);
  while (true) {
    const acquired = withCatalogWriteSerialization(state.home, permit => {
      state.consumed = true;
      const guarded = withExpectedConfigGenerationSync(state.generation, () => {
        const invalid = revalidateCandidate(state);
        return invalid ?? fixedCommit(state, permit);
      });
      if (guarded.kind === "conflict") return { kind: "stale", reason: "generation" } as const;
      if (guarded.kind === "unavailable") return { kind: "busy" } as const;
      return guarded.value;
    });
    if (acquired.kind === "completed") return acquired.value;
    if (acquired.reason !== "busy" || Date.now() >= deadline) return { kind: "busy" };
    await Bun.sleep(Math.min(10, Math.max(1, deadline - Date.now())));
  }
}

function projectCommit(result: CommitAttempt, notices: readonly CatalogNotice[]): CatalogDisposition {
  if (result.kind === "busy") return { status: "skipped", reason: "busy", retryable: true };
  if (result.kind === "committed") {
    return { status: "committed", changed: result.changed, degraded: notices.length > 0, notices };
  }
  if (result.kind === "stale") return { status: "skipped", reason: "stale", retryable: true };
  if (result.kind === "refused") return { status: "skipped", reason: "refused", retryable: false };
  const partialWrite = result.writes.keyedBackup === "written"
    || result.writes.legacyBackup === "written" || result.writes.catalog === "written";
  return { status: "failed", reason: "disk", phase: "commit", retryable: false, partialWrite };
}

export async function convergeCodexCatalog(
  snapshot: CatalogAdmissionSnapshot,
  request: ConvergeRequest,
  lifecycle: Readonly<{ onCommitBegin?: () => void }> = {},
): Promise<Readonly<{ changed: boolean; catalogRefresh: CatalogDisposition }>> {
  if (request.scope !== "catalog" || request.action !== "converge") {
    return {
      changed: false,
      catalogRefresh: { status: "failed", reason: "disk", phase: "gather", retryable: false, partialWrite: false },
    };
  }
  const gathered = await gatherCodexCatalogCandidate(snapshot);
  if (gathered.kind === "disposition") return { changed: false, catalogRefresh: gathered.disposition };
  const state = candidateStates.get(gathered.candidate as object)!;
  lifecycle.onCommitBegin?.();
  const committed = await commitCodexCatalogCandidate(gathered.candidate, request.deadlineMs);
  return {
    changed: committed.kind === "committed" ? committed.changed : false,
    catalogRefresh: projectCommit(committed, state.notices),
  };
}

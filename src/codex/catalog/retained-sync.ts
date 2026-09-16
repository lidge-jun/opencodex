import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, websocketsEnabled } from "../../config";
import { shouldSyncCodexOnStart } from "../desired-state";
import { legacyCustomModelCatalogSlugs } from "../custom-model-catalog-migration";
import { getCodexHome } from "../paths";
import type { OcxConfig } from "../../types";
import { pendingModelSelectionProviders } from "../../providers/initial-model-selection";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { providerCodexAccountMode } from "../../providers/registry";
import { COMBO_NAMESPACE } from "../../combos";
import { codexAccountNamespaceEntries, isMainCodexAccountTarget } from "../account-namespaces";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import {
  availableAccountGatedNativeModels,
  codexModelEntitlementStateForAccount,
  isCodexModelEntitlementSnapshotCurrent,
  resolveCodexModelEntitlements,
  type CodexModelEntitlementSnapshot,
} from "../model-entitlements";
import { isAccountNeedsReauth } from "../account-runtime-state";
import { codexRuntimeStatePath } from "../runtime";
import {
  activeCodexModelsCachePath,
  catalogBackupPathFor,
  catalogHasRoutedEntries,
  findNativeTemplate,
  findSupportedNativeTemplate,
  isDefaultCatalogPath,
  legacyCatalogBackupPath,
  readCatalog,
  readCatalogBackup,
  readCodexCatalogPath,
  readCodexCatalogPathForHome,
  readNativeBaseline,
} from "./parsing";
import type { CatalogModel, MultiAgentMode, RawCatalog, RawEntry } from "./parsing";
import {
  accountBoundNativeOpenAiSlugsBySelector,
  desktopAllowlistSuppressedNativeSlugs,
  disabledNativeSlugs,
  nativeContextLimits,
  observedAccountBoundNativeEntries,
  observedReserveCatalogSource,
  shouldIncludeAccountBoundNativeOpenAi,
  shouldIncludeNativeOpenAi,
  upstreamNativeEntry,
} from "./metadata";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { bundledCatalogCacheState, loadBundledCodexCatalog } from "./bundled";
import { isMultiAgentV2Enabled } from "../features";
import { clampCatalogModelsToCodexSupport } from "./effort";
import { filterCatalogVisibleModels, gatherRoutedModels, type CatalogGatherProviderModelOutcome } from "./provider-fetch";
import { dedupeCatalogEntriesBySlug, enforceCatalogSlugUniqueness, exactComboCatalogSlugs, type ComboCatalogOmission } from "./aggregation";
import {
  withCatalogWriteSerialization,
  type CatalogWritePermit,
} from "../catalog-write-serialization";
import {
  publishHashedCodexCatalogBackup,
  publishLegacyCodexCatalogBackup,
  replaceActiveCodexCatalog,
  replaceCodexModelsCache,
} from "../internal/catalog-writer";
import { visibleCodexAccountSelectors } from "./account-models";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS, NATIVE_OPENAI_MODELS, NATIVE_RESERVE_MODEL } from "./native-models";
import { createReserveCatalogProjection, RESERVE_LUNA_METADATA_SOURCE, RESERVE_SOURCE_CATALOG_FIELD } from "./reserve";
import {
  CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
  buildCatalogEntriesFromObservedState,
  mergeCatalogEntriesFromObservedState,
  mergeCatalogModelsWithNativeRecovery,
  orderForSubagents,
} from "./build-entries";
import { finishUpstreamNativeEntry } from "./derive-entry";
import { finalizeAutoReviewModelOverride } from "./auto-review";
import { gatedNativeAccountLabel, gatedNativeReauthSuppressionReason, warnGatedNativeSuppressedOnce } from "./gated-native-warn";

interface RetainedCatalogSyncRead {
  readonly catalogPath: string;
  readonly catalog: RawCatalog;
  readonly onDiskCatalog: RawCatalog | null;
  readonly modelsCache: RawCatalog | null;
  readonly evidence: string;
  /**
   * Process-local epochs, baselined AFTER our own gather rather than with the
   * filesystem bytes above. See `retainedCatalogProcessEvidence`.
   */
  readonly processEvidence: string;
}

interface RetainedCatalogSyncResult {
  added: number;
  path: string;
  catalogWritten: boolean;
  comboOmissions: ComboCatalogOmission[];
  /** Validated catalog commit (including identical bytes), or a refused refresh. */
  refreshOutcome?: "committed" | "refused";
  /** `desired_disabled` observed under K after the provider await; nothing was written. */
  skippedReason?: "desired_disabled";
}

/**
 * Catalog/cache commit overrides.
 *
 * An explicit `ocx sync` is also the refresh path for side profiles that consume
 * the OpenCodex catalog without injection (for example a custom `model_provider`
 * that routes to the proxy). In that mode the Codex integration toggle only
 * governs config/history injection; the catalog and models cache may still be
 * refreshed, so `allowWhenDesiredDisabled` lets the commit path ignore the OFF
 * gate that otherwise protects a fully native home.
 */
export interface CodexCatalogSyncOptions {
  allowWhenDesiredDisabled?: boolean;
}

interface RetainedCatalogSyncWrite {
  readonly config: OcxConfig;
  readonly goModels: CatalogModel[];
  readonly providerModelOutcomes: readonly CatalogGatherProviderModelOutcome[];
  readonly comboOmissions: ComboCatalogOmission[];
  readonly read: RetainedCatalogSyncRead;
  readonly permit: CatalogWritePermit;
  readonly owningCodexHome: string;
  readonly modelEntitlements: CodexModelEntitlementSnapshot;
}

function optionalFileBytes(path: string): string | null {
  try {
    return readFileSync(path).toString("base64");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
}

function loadCatalogForRetainedSync(path: string): RawCatalog | null {
  const bundled = isDefaultCatalogPath(path) ? loadBundledCodexCatalog() : null;
  if (bundled) return JSON.parse(JSON.stringify(bundled)) as RawCatalog;
  const active = readCatalog(path);
  // A valid configured custom file remains the content authority even when it has no bare native
  // template. The null-template builder is deliberate; a stale backup must not replace active
  // custom root metadata merely because the current file contains only routed rows.
  if (active && (!isDefaultCatalogPath(path) || findNativeTemplate(active))) return active;
  return readCatalog(catalogBackupPathFor(path))
    ?? (isDefaultCatalogPath(path) ? readCatalog(legacyCatalogBackupPath()) : null)
    ?? readCatalog(activeCodexModelsCachePath())
    ?? active;
}

function retainedCatalogSyncEvidence(
  config: OcxConfig,
  catalogPath: string,
  catalog: RawCatalog,
): string {
  return JSON.stringify({
    config,
    catalogPath,
    catalog,
    catalogBytes: optionalFileBytes(catalogPath),
    hashedBackupBytes: optionalFileBytes(catalogBackupPathFor(catalogPath)),
    legacyBackupBytes: isDefaultCatalogPath(catalogPath)
      ? optionalFileBytes(legacyCatalogBackupPath()) : null,
    modelsCacheBytes: optionalFileBytes(activeCodexModelsCachePath()),
    // The persisted runtime selection is a pre-await filesystem input, not a
    // process epoch: another PROCESS can move runtime authority by rewriting this
    // file, and that move is invisible to our in-process memo. Recorded PRESENT or
    // ABSENT, because its absence is what makes the resolver fall back.
    runtimeStateBytes: optionalFileBytes(codexRuntimeStatePath()),
  });
}

/**
 * The bundled-template half of the same evidence, observed separately.
 *
 * The runtime process memo is deliberately NOT here, and that exclusion took three
 * attempts to get honest. Gathering resolves the Codex runtime lazily and under its
 * own cache key, so this path cannot pre-settle that memo: baselining it before the
 * await always detected our own side effect and refused every write, and baselining
 * it after the await captured a runtime that ANOTHER process had moved as though it
 * were ours — a catalog prepared from R1 committing after authority reached R2.
 *
 * Runtime authority is covered where it is actually durable instead: the persisted
 * `codex-runtime.json` bytes sit in the pre-await filesystem evidence, PRESENT or
 * ABSENT, so a cross-process runtime move is caught. What is left uncovered, and is
 * written down rather than papered over, is a same-process in-memory runtime swap
 * that never touches that file — WP11 owns the lock that makes that case decidable.
 */
function retainedCatalogProcessEvidence(): string {
  return JSON.stringify({
    bundledCatalogCache: bundledCatalogCacheState(),
  });
}

/**
 * Capture every local catalog input the retained sync path consults before its
 * provider await. The exact evidence is compared after K acquisition; a newer
 * catalog/backup/cache or target selection makes this attempt a no-write.
 */
function readRetainedCatalogSync(config: OcxConfig): RetainedCatalogSyncRead | null {
  const catalogPath = readCodexCatalogPath();
  const catalog = loadCatalogForRetainedSync(catalogPath);
  if (!catalog) return null;

  // The bundled catalog is a reliable native template on the default path, but it is not the
  // merge source. Preservation must inspect the file that this sync is about to overwrite;
  // otherwise an empty/partial provider gather cannot see routed or user-native rows on disk.
  const onDiskCatalog = readCatalog(catalogPath);
  const modelsCache = readCatalog(activeCodexModelsCachePath());
  const evidence = retainedCatalogSyncEvidence(config, catalogPath, catalog);
  // `processEvidence` is filled in after the provider await, not here.
  return { catalogPath, catalog, onDiskCatalog, modelsCache, evidence, processEvidence: "" };
}

function revalidateRetainedCatalogSync(
  config: OcxConfig,
  prepared: RetainedCatalogSyncRead,
): RetainedCatalogSyncRead | null {
  const catalogPath = readCodexCatalogPath();
  if (catalogPath !== prepared.catalogPath) return null;
  const evidence = retainedCatalogSyncEvidence(config, catalogPath, prepared.catalog);
  if (evidence !== prepared.evidence) return null;
  if (retainedCatalogProcessEvidence() !== prepared.processEvidence) return null;
  return {
    catalogPath,
    catalog: JSON.parse(JSON.stringify(prepared.catalog)) as RawCatalog,
    onDiskCatalog: readCatalog(catalogPath),
    modelsCache: readCatalog(activeCodexModelsCachePath()),
    evidence,
    processEvidence: prepared.processEvidence,
  };
}

/**
 * Exact bytes currently on disk at `path`, or null when unreadable/absent.
 *
 * Deliberately a Buffer rather than a decoded string: `readFileSync(path, "utf8")`
 * substitutes U+FFFD for every invalid byte, so a file holding a raw 0x80 decodes
 * equal to prepared content holding a legitimately encoded U+FFFD. Comparing the
 * decoded strings would then classify a malformed catalog as identical, skip the
 * atomic repair write, and leave the corruption on disk while reporting
 * `catalogWritten: false`.
 */
function currentCatalogFileContent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function pristineCatalogBytes(read: RetainedCatalogSyncRead): string | null {
  if (read.onDiskCatalog && !catalogHasRoutedEntries(read.onDiskCatalog)) {
    try {
      return readFileSync(read.catalogPath, "utf8");
    } catch {
      return null;
    }
  }
  return catalogHasRoutedEntries(read.catalog)
    ? null
    : `${JSON.stringify(read.catalog, null, 2)}\n`;
}

function catalogModelsForMergeWithNativeRecovery(
  catalogPath: string,
  catalog: RawCatalog,
  onDiskCatalog: RawCatalog | null,
): RawEntry[] {
  const primaryCatalogModels = onDiskCatalog?.models ?? catalog.models ?? [];
  // Native-alias compatibility can omit disabled native rows from the effective catalog because
  // Desktop's remote allowlist ignores `visibility: "hide"`. Keep current/pristine native recovery
  // sources beside the on-disk rows so re-enabling a model restores its real metadata. Routed and
  // user-authored rows still come only from the on-disk catalog.
  return mergeCatalogModelsWithNativeRecovery(primaryCatalogModels, [
    catalog.models ?? [],
    readCatalogBackup(catalogPath)?.models ?? [],
  ]);
}

function writeRetainedCatalogSync({
  config,
  goModels,
  providerModelOutcomes,
  comboOmissions,
  read,
  permit,
  owningCodexHome,
  modelEntitlements,
}: RetainedCatalogSyncWrite): RetainedCatalogSyncResult {
  const { catalogPath, catalog, onDiskCatalog } = read;
  const catalogModelsForMerge = catalogModelsForMergeWithNativeRecovery(
    catalogPath,
    catalog,
    onDiskCatalog,
  );
  // Strict selector for template inheritance; the validity gate above keeps the broad one.
  const template = findSupportedNativeTemplate(catalog);

  try {
    // Once-only: preserve the PRISTINE pre-opencodex catalog as the native-priority baseline
    // (later syncs would otherwise overwrite it with featured-modified priorities).
    const pristine = pristineCatalogBytes(read);
    if (pristine !== null) {
      publishHashedCodexCatalogBackup(permit, owningCodexHome, {
        path: catalogBackupPathFor(catalogPath),
        content: pristine,
      });
      if (isDefaultCatalogPath(catalogPath)) {
        publishLegacyCodexCatalogBackup(permit, owningCodexHome, {
          path: legacyCatalogBackupPath(),
          content: pristine,
        });
      }
    }
  } catch { /* backup best-effort */ }

  // Hide disabled models from Codex, then feature the chosen subagent models (native OR routed)
  // by giving them the lowest priority — see buildCatalogEntries for why priority, not array order.
  const enabledGo = filterCatalogVisibleModels(goModels, config);
  const featured = config.subagentModels ?? [];
  const orderedGoModels = orderForSubagents(enabledGo, featured); // stable tie-break among equal priorities
  const modelPickerOrder = config.modelPickerOrder ?? [];
  const multiAgentMode: MultiAgentMode = config.multiAgentMode === "v1" || config.multiAgentMode === "v2" ? config.multiAgentMode : "default";
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
  const unavailableGatedNativeSlugs = new Set([...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(slug => (
    !availableBareGatedNativeSlugs.has(slug)
  )));
  // #4212: this set is the whole record of a model vanishing, and it is a set of strings that
  // nothing downstream ever asks a question of. Explain it here, while the entitlement snapshot
  // that produced it is still in scope, because after this point the model is simply absent and
  // no later surface can tell "never entitled" apart from "the account broke this morning".
  for (const slug of unavailableGatedNativeSlugs) {
    const reason = gatedNativeReauthSuppressionReason({
      snapshot: modelEntitlements,
      slug,
      eligibleAccountIds: bareEligibleAccountIds,
      needsReauth: isAccountNeedsReauth,
      label: accountId => gatedNativeAccountLabel(config, accountId),
    });
    if (reason) warnGatedNativeSuppressedOnce(slug, reason);
  }
  const suppressedBareNativeSlugs = new Set([
    ...desktopAllowlistSuppressedNativeSlugs(config),
    ...unavailableGatedNativeSlugs,
  ]);
  const hasPhysicalComboProvider = Object.hasOwn(config.providers, COMBO_NAMESPACE);
  const includeNativeOpenAi = shouldIncludeNativeOpenAi(config);
  const includeAccountBoundNativeOpenAi = shouldIncludeAccountBoundNativeOpenAi(config);
  // Both user levers. Passing only the cap here is what let a per-model window the dashboard
  // had accepted get written back at full width in the on-disk catalog.
  const openaiContextCap = nativeContextLimits(config);
  const accountSelectors = includeAccountBoundNativeOpenAi
    ? visibleCodexAccountSelectors(config)
    : [];
  const observedAccountNativeEntries = [
    ...(read.modelsCache?.models ?? []),
    ...(onDiskCatalog?.models ?? []).filter(entry =>
      trustedAccountBoundNativeCatalogSlug(entry) !== undefined),
  ];
  const accountTargets = new Map(codexAccountNamespaceEntries(config));
  const reserveMainSelectors = accountSelectors.filter(selector =>
    isMainCodexAccountTarget(accountTargets.get(selector) ?? ""));
  // The active file can own a bare source even when the bundled catalog is the build base.
  // A previously clamped qualified projection must not shorten a retained genuine ladder.
  const reserveObservations = [
    ...(onDiskCatalog?.models ?? []),
    ...(read.modelsCache?.models ?? []),
    ...(catalog.models ?? []),
  ];
  const retainedReserve = onDiskCatalog?.[RESERVE_SOURCE_CATALOG_FIELD];
  const retainedReserveSource = retainedReserve && typeof retainedReserve === "object" && !Array.isArray(retainedReserve)
    ? observedReserveCatalogSource([retainedReserve as RawEntry], [])
    : null;
  const observedReserveSource = observedReserveCatalogSource(
    // Cache invalidation carries historical bare observations alongside emitted models.
    // Only unmarked observations are fresh enough to supersede the retained source.
    reserveObservations.filter(entry => entry.slug === NATIVE_RESERVE_MODEL
      && entry.opencodex_account_observed_native === undefined), reserveMainSelectors,
  ) ?? retainedReserveSource ?? observedReserveCatalogSource(reserveObservations, reserveMainSelectors);
  // This root is read only by OCX. Upstream ModelsResponse ignores unknown root fields.
  // Retain before final runtime clamping: an omitted row must not turn into Luna next sync.
  if (observedReserveSource) catalog[RESERVE_SOURCE_CATALOG_FIELD] = structuredClone(observedReserveSource);
  else delete catalog[RESERVE_SOURCE_CATALOG_FIELD];
  const lunaSource = upstreamNativeEntry(RESERVE_LUNA_METADATA_SOURCE);
  const reserve = createReserveCatalogProjection(
    config,
    reserveMainSelectors,
    observedReserveSource,
    lunaSource ? finishUpstreamNativeEntry(lunaSource, 9, openaiContextCap) : null,
  );
  const accountNativeSlugsBySelector = accountSelectors.length > 0
    ? new Map([...accountBoundNativeOpenAiSlugsBySelector(config, observedAccountNativeEntries)].map(([selector, slugs]) => {
      const target = accountTargets.get(selector);
      const accountId = target && isMainCodexAccountTarget(target) ? MAIN_CODEX_ACCOUNT_ID : target;
      return [selector, slugs.filter(slug => (
        !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)
        || (accountId !== undefined
          && codexModelEntitlementStateForAccount(modelEntitlements, accountId, slug) === "granted")
      ))] as const;
    }))
    : new Map<string, readonly string[]>();
  const accountNativeSlugs = accountSelectors.length > 0
    ? [...new Set([...accountNativeSlugsBySelector.values()].flatMap(slugs => [...slugs]))]
    : [];
  // Unknown account-native ids have no safe bare/global identity. They are only projected through
  // the selector map above; the no-selector catalog remains the static native/API-key surface.
  const observedNativeSlugs: string[] = [];
  const wsEnabled = websocketsEnabled(config);
  const multiAgentV2Enabled = isMultiAgentV2Enabled();
  const goEntries = buildCatalogEntriesFromObservedState({
    template: template ? JSON.parse(JSON.stringify(template)) : null,
    gptSlugs: [],
    goModels: orderedGoModels,
    featured,
    modelPickerOrder,
    wsEnabled,
    multiAgentMode,
    exactComboSlugs,
    accountSelectors,
    suppressedBareNativeSlugs,
    disabledNativeAccountSlugs: new Set(),
    multiAgentV2Enabled,
    openaiContextCap,
  });
  // Keep genuine native entries (gpt-*, codex-*) with their real per-model fields and append
  // routed providers as namespaced slugs. Cursor and other adopted providers can expose model ids
  // like `gpt-5.5`; those must not delete the native OpenAI/Codex base row.
  const baselineCatalog = readCatalogBackup(catalogPath);
  const baseline = readNativeBaseline(catalogPath);
  const gatheredProviderNames = new Set(
    Object.entries(config.providers ?? {})
      .filter(([, prov]) => prov.disabled !== true)
      .map(([name]) => name),
  );
  const degradedProviderNames = new Set(
    providerModelOutcomes
      .filter(outcome => outcome.state === "degraded")
      .map(outcome => outcome.provider),
  );
  const selectedModelsByProvider = new Map<string, ReadonlySet<string>>(
    Object.entries(config.providers ?? {}).flatMap(([name, provider]) => (
      provider.disabled !== true
        && Array.isArray(provider.selectedModels)
        && provider.selectedModels.length > 0
        ? [[name, new Set(provider.selectedModels)] as const]
        : []
    )),
  );
  // Central WS capability override on the FINAL on-disk catalog (the file Codex reads). Applies to
  // native AND routed so the advertised flag matches the implemented endpoint (phase 120.4) and a
  // native template can never leak supports_websockets while the flag is off.
  // #636: when the user only configured non-OpenAI providers (e.g. kimi), do not advertise
  // bare gpt-* rows that hard-404 via NoEnabledOpenAiProviderError. Keep natives when no
  // providers are configured yet (fresh install / catalog bootstrap tests).
  const accountBoundEntries = includeAccountBoundNativeOpenAi && accountSelectors.length > 0
    ? buildCatalogEntriesFromObservedState({
      template: template ? JSON.parse(JSON.stringify(template)) : null,
      gptSlugs: availableAccountNativeSlugs,
      goModels: [],
      featured,
      wsEnabled,
      multiAgentMode,
      exactComboSlugs,
      accountSelectors,
      suppressedBareNativeSlugs,
      disabledNativeAccountSlugs: new Set([...disabledNativeSlugs(config)].filter(slug => suppressedBareNativeSlugs.has(slug))),
      multiAgentV2Enabled,
      keepNativeChatGptOnV1: config.keepNativeChatGptOnV1 === true,
      openaiContextCap,
      accountNativeSlugs,
      accountNativeSlugsBySelector,
      reserve,
    }).filter(entry => trustedAccountBoundNativeCatalogSlug(entry) !== undefined)
    : [];
  catalog.models = mergeCatalogEntriesFromObservedState({
    modelPickerOrder,
    accountSelectors,
    catalogModels: catalogModelsForMerge,
    baselineCatalogModels: baselineCatalog?.models ?? [],
    routedEntries: goEntries,
    baseline,
    featured,
    wsEnabled,
    template,
    disabledModels: new Set(config.disabledModels ?? []),
    selectedModelsByProvider,
    gatheredProviderNames,
    pendingProviderNames: pendingModelSelectionProviders(config),
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
    openaiContextCap,
    nativeDisplayNames: config.providers[OPENAI_CODEX_PROVIDER_ID]?.modelDisplayNames,
    policy: {
      ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
      nativeBackfillSlugs: [...availableBareNativeSlugs, ...observedNativeSlugs],
      warningPolicy: "emit",
    },
  });
  clampCatalogModelsToCodexSupport(catalog.models);
  finalizeAutoReviewModelOverride(catalog.models, catalogModelsForMerge, config);
  // Last mutation before serialization; see `enforceCatalogSlugUniqueness` for why the ordering
  // against the effort clamp is load-bearing rather than cosmetic.
  catalog.models = enforceCatalogSlugUniqueness(catalog.models, true);

  const added = goEntries.length + accountBoundEntries.length;
  const content = `${JSON.stringify(catalog, null, 2)}\n`;
  // A byte-identical rewrite is not a catalog change, but every mtime-keyed reader
  // has to treat it as one. The app-server staleness classifier (#857) is the one
  // that matters: it compares this file's mtime against each running Codex's start
  // time, so an ordinary `ocx start` — or any dashboard action that re-syncs an
  // unchanged model set — marked every already-running Codex as holding an outdated
  // in-memory catalog. Since #1407 that verdict silences opencodex's own model
  // guidance entirely (no preferred model, no roster) for the rest of that Codex's
  // lifetime, so a configured injectionModel stops reaching the session even though
  // nothing about the catalog changed. Skipping the no-op write keeps both the mtime
  // and `catalogWritten` honest; `added` still reports the routed rows the catalog
  // carries, because they are on disk either way.
  const onDiskBytes = currentCatalogFileContent(catalogPath);
  if (onDiskBytes !== null && onDiskBytes.equals(Buffer.from(content, "utf8"))) {
    return { added, path: catalogPath, catalogWritten: false, comboOmissions };
  }

  replaceActiveCodexCatalog(permit, owningCodexHome, {
    path: catalogPath,
    content,
  });
  return {
    added,
    path: catalogPath,
    catalogWritten: true,
    comboOmissions,
  };
}

// Re-exported so the #4730 unit regression keeps importing the guard from the sync module it
// guards; the implementation lives in ./aggregation because the management convergence commit
// is the second writer that has to apply the identical rule.
export { dedupeCatalogEntriesBySlug };

export async function syncCatalogModels(
  config: OcxConfig,
  options?: CodexCatalogSyncOptions,
): Promise<RetainedCatalogSyncResult> {
  if (pendingModelSelectionProviders(config).size) {
    const { resolvePendingInitialModelSelection } = await import("../../providers/initial-model-selection-runtime");
    await resolvePendingInitialModelSelection(config);
  }
  const owningCodexHome = getCodexHome();
  const preflightRead = readRetainedCatalogSync(config);
  if (preflightRead === null) {
    return {
      added: 0,
      path: readCodexCatalogPath(),
      catalogWritten: false,
      comboOmissions: [],
      refreshOutcome: "refused",
    };
  }

  const comboOmissions: ComboCatalogOmission[] = [];
  const providerModelOutcomes: CatalogGatherProviderModelOutcome[] = [];
  // Settle the bundled template, then baseline, and only then await. Reading it
  // here makes the memo ours before anyone else can move it, so a bundled swap
  // during the await is an outside change rather than our own side effect.
  //
  // The persisted runtime selection is covered by the filesystem evidence above
  // rather than by a process epoch; see `retainedCatalogProcessEvidence` for why
  // the in-memory runtime memo cannot be baselined honestly from this path.
  loadBundledCodexCatalog();
  const prepared: RetainedCatalogSyncRead = {
    ...preflightRead,
    evidence: retainedCatalogSyncEvidence(config, preflightRead.catalogPath, preflightRead.catalog),
    processEvidence: retainedCatalogProcessEvidence(),
  };
  const [goModels, modelEntitlements] = await Promise.all([
    gatherRoutedModels(config, {
      comboOmissions,
      providerModelOutcomes,
    }),
    resolveCodexModelEntitlements(config),
  ]);
  const committed = withCatalogWriteSerialization(owningCodexHome, permit => {
    // Desired state can flip OFF during the provider await above. The catalog
    // evidence revalidation below cannot see that — intent lives in our config,
    // not in the catalog files — so the policy is re-read here, under K, right
    // before the only write. A lost race becomes the discriminated skip instead
    // of a routed catalog/cache surviving a completed disable. An explicit
    // catalog-only sync opts out of that gate: the user asked for a refresh even
    // when injection is OFF, and the toggle only protects config/history writes.
    if (!shouldSyncCodexOnStart(loadConfig()) && options?.allowWhenDesiredDisabled !== true) {
      return {
        added: 0,
        path: prepared.catalogPath,
        catalogWritten: false,
        comboOmissions,
        skippedReason: "desired_disabled" as const,
      };
    }
    const current = revalidateRetainedCatalogSync(config, prepared);
    if (current === null) return null;
    if (!isCodexModelEntitlementSnapshotCurrent(modelEntitlements)) return null;
    return writeRetainedCatalogSync({
      config,
      goModels,
      providerModelOutcomes,
      comboOmissions,
      read: current,
      permit,
      owningCodexHome,
      modelEntitlements,
    });
  });
  if (committed.kind === "completed" && committed.value !== null) {
    return {
      ...committed.value,
      refreshOutcome: committed.value.skippedReason ? "refused" : "committed",
    };
  }
  return {
    added: 0,
    path: prepared.catalogPath,
    catalogWritten: false,
    comboOmissions,
    refreshOutcome: "refused",
  };
}

export function invalidateCodexModelsCacheWithPermit(
  permit: CatalogWritePermit,
  owningCodexHome: string,
  options?: CodexCatalogSyncOptions,
): boolean {
  try {
    // This permit is a REACQUISITION: refreshCodexModelCatalog's commit released
    // K before this rewrite runs, so the commit-path desired-state check cannot
    // cover it. A disable landing in that gap must not be overwritten by a
    // routed cache write — re-read intent under this permit, same as the commit.
    // The catalog-only sync override applies here too so an explicit refresh
    // keeps the cache consistent with the catalog it just wrote.
    if (!shouldSyncCodexOnStart(loadConfig()) && options?.allowWhenDesiredDisabled !== true) return false;
    const catalogPath = readCodexCatalogPathForHome(owningCodexHome);
    if (!existsSync(catalogPath)) return false;
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const models = catalog.models ?? catalog;
    const cachePath = join(owningCodexHome, "models_cache.json");
    const currentCache = readCatalog(cachePath);
    const existingSlugs = new Set(models.flatMap((entry: RawEntry) =>
      typeof entry.slug === "string" ? [entry.slug] : []));
    const currentConfig = loadConfig();
    const mainSelectors = visibleCodexAccountSelectors(currentConfig).filter(selector => {
      const target = new Map(codexAccountNamespaceEntries(currentConfig)).get(selector);
      return isMainCodexAccountTarget(target ?? "");
    });
    const observedAccountModels = observedAccountBoundNativeEntries(currentCache?.models ?? [])
      .filter(entry => {
        const slug = typeof entry.slug === "string" ? entry.slug : "";
        return !existingSlugs.has(slug);
      })
      .map(entry => ({
        ...entry,
        // Keep the observation in Codex's cache without advertising a new bare picker row. The
        // next OpenCodex catalog sync consumes this marker and creates only selector-qualified
        // rows for the currently configured public account selectors.
        visibility: "hide",
        opencodex_account_observed_native: true,
        opencodex_account_observed_selectors: mainSelectors,
      }));
    const wrapper = {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models: [...models, ...observedAccountModels],
    };
    replaceCodexModelsCache(permit, owningCodexHome, {
      path: cachePath,
      content: `${JSON.stringify(wrapper, null, 2)}\n`,
    });
    return true;
  } catch {
    return false;
  }
}

export function invalidateCodexModelsCache(options?: CodexCatalogSyncOptions): boolean {
  const owningCodexHome = getCodexHome();
  const outcome = withCatalogWriteSerialization(
    owningCodexHome,
    permit => invalidateCodexModelsCacheWithPermit(permit, owningCodexHome, options),
  );
  return outcome.kind === "completed" && outcome.value;
}

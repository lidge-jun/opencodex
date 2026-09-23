import type { OcxConfig, OcxProviderConfig } from "../types";
import { configReasoningPinsConfigError } from "./provider-validation";
import { adoptCustomModelCatalogMigration, projectCustomModelCatalogMigration } from "../codex/custom-model-catalog-migration";
import { refreshPreservedProviderOwner, refreshUserCostOverlays } from "../usage/user-cost-overlays";
import {
  applyConfigObjectChildDeletions,
  clearPendingConfigObjectChildDeletions,
  prepareConfigObjectChildDeletionRebase,
  clearPendingConfigTopLevelDeletions,
  configHasRebaseProvenance,
  configRebaseDeletionKeys,
  CONFIG_REBASE_PROVENANCE_KEY,
  projectConfigRebaseProvenance,
} from "./rebase-provenance";
import { withConfigMutationLockSync, bumpGenerationForCooperatingConfigWrite } from "./mutation-lock";
import { persistConfigUnlocked, readRawConfigJson } from "./persist-unlocked";
import { configDiagnosticsFromRaw, readConfigDiagnostics } from "./diagnostics";
import { normalizePersistedClaudeCode } from "./load-degrade";

// ---------------------------------------------------------------------------
// Hand-edit protection for the `claudeCode` subtree (devlog 260726_claude_auth_auto/040 H1).
//
// `saveConfig` serializes the WHOLE config object, so ANY service-time save — a model
// visibility toggle, a 429 key rotation on the request path — rewrites `claudeCode`
// from whatever the long-lived server config happens to hold. A user who hand-edits
// `config.json` while the proxy runs then watches their edit vanish for no visible
// reason (issue #488). Enumerating `claudeCode` mutators cannot fix that; the guard has
// to live in ONE save wrapper that every live-config writer goes through.
// ---------------------------------------------------------------------------

/**
 * Baseline keyed on the CONFIG INSTANCE, never a module global: a second `loadConfig()`
 * elsewhere must not refresh the baseline the long-lived server config is judged
 * against, or a later stale save would masquerade as "our own change".
 */
const claudeCodeBaseline = new WeakMap<OcxConfig, unknown>();
/**
 * Full live-config baseline used to rebase unrelated cooperating writes. The
 * Claude subtree and the bound listener fields remain on their dedicated
 * reconciliation paths below.
 */
const liveConfigBaseline = new WeakMap<OcxConfig, OcxConfig>();
/**
 * The live config retains the address of the socket Bun actually opened, while
 * this map retains the operator's desired address for the next process start.
 * Keeping them separate prevents an unrelated live save from restoring a stale
 * externally exposed bind after OAuth adopted a newer loopback disk config.
 */
type PersistedServerBinding = Pick<OcxConfig, "port" | "hostname">;

const persistedLiveServerBinding = new WeakMap<OcxConfig, PersistedServerBinding>();

/**
 * Config instances nobody holds long-term — the catalog auto-refresh tick's
 * per-tick `loadConfig()` snapshot. A detached snapshot cannot express a
 * deliberate deletion and owns no live listener socket, so the live policy's
 * `hostname`/`port` and disk-only-key skips would only discard concurrent hand
 * edits wholesale. Keyed on the instance so the mode cannot leak into the
 * long-lived server config.
 */
const detachedConfigSnapshots = new WeakSet<OcxConfig>();

/**
 * Arm the baseline for a long-lived config. MANDATORY at `startServer`, not lazy on
 * first save — arming lazily would lose exactly the hand edit made before that first
 * save, which is the case the guard exists for.
 */
export function armClaudeCodeBaseline(config: OcxConfig): void {
  liveConfigBaseline.set(config, structuredClone(config));
  claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
}

/**
 * Arm a freshly loaded config instance no long-lived server owns. The save path
 * then reconciles every field — the listener binding and keys that exist only
 * on disk included — against this arming baseline, so a concurrent hand edit is
 * adopted rather than overwritten by the snapshot's stale values.
 */
export function armDetachedConfigBaseline(config: OcxConfig): void {
  armClaudeCodeBaseline(config);
  detachedConfigSnapshots.add(config);
}

/**
 * Adopt one schema-validated provider that was read from the authoritative disk
 * config into a long-lived server config without rebasing any unrelated field.
 * Updating the matching baseline row keeps a later guarded save from treating the
 * adopted provider as an unsaved live edit that should defeat a newer disk change.
 */
export function adoptPersistedProviderIntoLiveConfig(
  config: OcxConfig,
  name: string,
  provider: OcxProviderConfig,
  persistedConfig?: OcxConfig,
): void {
  config.providers[name] = structuredClone(provider);
  const baseline = liveConfigBaseline.get(config);
  if (baseline) baseline.providers[name] = structuredClone(provider);
  if (persistedConfig) refreshPreservedProviderOwner(config, persistedConfig);
}

/** Test seam only: is this instance armed? */
export function claudeCodeBaselineArmed(config: OcxConfig): boolean {
  return claudeCodeBaseline.has(config);
}

/**
 * Adopt a field-scoped Claude Code write into a long-lived config snapshot.
 *
 * Scoped writers commit against the current file rather than serializing the
 * whole snapshot. Mirror that committed subtree and rebase the hand-edit guard
 * together so a later unrelated save does not mistake the scoped write for an
 * outstanding in-memory mutation.
 *
 * The live subtree may already hold pending mutations a concurrent request
 * assigned but has not saved yet — the Claude settings PUT yields between
 * assigning `config.claudeCode` and saving. Adopt through the same three-way
 * reconcile guarded saves use, so pending live leaves survive, disjoint
 * committed changes merge in, and only the baseline moves wholesale to the
 * committed subtree.
 */
export function adoptPersistedClaudeCode(
  config: OcxConfig,
  persistedClaudeCode: OcxConfig["claudeCode"],
): void {
  const storedBaseline: ConfigMergeValue = claudeCodeBaseline.has(config)
    ? claudeCodeBaseline.get(config)
    : MISSING_CONFIG_VALUE;
  const merged = reconcileConfigValue(
    storedBaseline === undefined ? MISSING_CONFIG_VALUE : storedBaseline,
    config.claudeCode === undefined ? MISSING_CONFIG_VALUE : config.claudeCode,
    persistedClaudeCode === undefined ? MISSING_CONFIG_VALUE : persistedClaudeCode,
  );
  if (merged === MISSING_CONFIG_VALUE) delete config.claudeCode;
  else config.claudeCode = merged as OcxConfig["claudeCode"];
  const baseline = liveConfigBaseline.get(config);
  if (baseline) baseline.claudeCode = structuredClone(persistedClaudeCode);
  if (claudeCodeBaseline.has(config)) {
    claudeCodeBaseline.set(config, structuredClone(persistedClaudeCode));
  }
}

/**
 * Structural compare of parsed subtrees. NOT `JSON.stringify`: key order must not
 * decide whether a user's hand edit survives.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  // `undefined` values and absent keys are the same thing after a JSON round-trip.
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] === undefined && right[key] === undefined) continue;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

const MISSING_CONFIG_VALUE = Symbol("missing-config-value");
type ConfigMergeValue = unknown | typeof MISSING_CONFIG_VALUE;

function isPlainConfigRecord(value: ConfigMergeValue): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownConfigValue(record: Record<string, unknown>, key: string): ConfigMergeValue {
  return Object.hasOwn(record, key) ? record[key] : MISSING_CONFIG_VALUE;
}

function cloneConfigValue(value: ConfigMergeValue): ConfigMergeValue {
  return value === MISSING_CONFIG_VALUE ? value : structuredClone(value);
}

type IndexedCustomModels = {
  order: string[];
  byId: Map<string, Record<string, unknown>>;
};

function indexDisabledModels(value: ConfigMergeValue): { order: string[]; members: Set<string> } | null {
  if (value === MISSING_CONFIG_VALUE) return { order: [], members: new Set() };
  if (!Array.isArray(value)) return null;
  const members = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || members.has(item)) return null;
    members.add(item);
  }
  return { order: value as string[], members };
}

/**
 * Merge disabled-model lists by membership instead of treating the array as one
 * opaque leaf: a slug either side deleted stays deleted (deletion wins over the
 * other side's unchanged retention) while slugs added on either side are kept.
 * Discovery only appends, so live additions are its arrivals; a hand edit that
 * hid or un-hid a model mid-refresh survives the discovery save.
 */
function reconcileDisabledModels(
  baseline: ConfigMergeValue,
  live: ConfigMergeValue,
  persisted: ConfigMergeValue,
): ConfigMergeValue | null {
  const baselineSet = indexDisabledModels(baseline);
  const liveSet = indexDisabledModels(live);
  const persistedSet = indexDisabledModels(persisted);
  if (!baselineSet || !liveSet || !persistedSet) return null;
  const order = [...liveSet.order, ...persistedSet.order.filter(id => !liveSet.members.has(id))];
  const merged: string[] = [];
  for (const id of order) {
    if (baselineSet.members.has(id) && (!liveSet.members.has(id) || !persistedSet.members.has(id))) continue;
    merged.push(id);
  }
  return merged;
}

function indexCustomModels(value: ConfigMergeValue): IndexedCustomModels | null {
  if (!Array.isArray(value)) return null;
  const order: string[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    if (!isPlainConfigRecord(item) || typeof item.id !== "string" || item.id.length === 0 || byId.has(item.id)) {
      return null;
    }
    order.push(item.id);
    byId.set(item.id, item);
  }
  return { order, byId };
}

/**
 * Merge custom-model rows by their stable id instead of treating the array as
 * one opaque value. A row changed only on disk is adopted, a row changed only
 * in the live config is retained, and disjoint edits to the same row recurse
 * through the normal three-way object merge. A newer persisted row deletion
 * wins over a stale live edit to that row.
 */
function reconcileCustomModels(
  baseline: ConfigMergeValue,
  live: ConfigMergeValue,
  persisted: ConfigMergeValue,
): ConfigMergeValue | null {
  const baselineRows = indexCustomModels(baseline);
  const liveRows = indexCustomModels(live);
  const persistedRows = indexCustomModels(persisted);
  if (!baselineRows || !liveRows || !persistedRows) return null;

  const order = [...liveRows.order, ...persistedRows.order.filter(id => !liveRows.byId.has(id))];
  const merged: Array<Record<string, unknown>> = [];
  for (const id of order) {
    const baselineRow = baselineRows.byId.get(id) ?? MISSING_CONFIG_VALUE;
    const persistedRow = persistedRows.byId.get(id) ?? MISSING_CONFIG_VALUE;
    const row = baselineRow !== MISSING_CONFIG_VALUE && persistedRow === MISSING_CONFIG_VALUE
      ? MISSING_CONFIG_VALUE
      : reconcileConfigValue(
          baselineRow,
          liveRows.byId.get(id) ?? MISSING_CONFIG_VALUE,
          persistedRow,
        );
    if (row !== MISSING_CONFIG_VALUE) merged.push(row as Record<string, unknown>);
  }
  return merged;
}

function reconcileConfigRecord(
  live: Record<string, unknown>,
  baseline: Record<string, unknown>,
  persisted: Record<string, unknown>,
  skippedKeys?: ReadonlySet<string>,
  persistedDeletionsWin = false,
): void {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(live), ...Object.keys(persisted)]);
  for (const key of keys) {
    if (skippedKeys?.has(key)) continue;
    const baselineValue = ownConfigValue(baseline, key);
    const liveValue = ownConfigValue(live, key);
    const persistedValue = ownConfigValue(persisted, key);
    const merged = persistedDeletionsWin
        && baselineValue !== MISSING_CONFIG_VALUE
        && persistedValue === MISSING_CONFIG_VALUE
      ? MISSING_CONFIG_VALUE
      : key === "customModels"
        ? reconcileCustomModels(baselineValue, liveValue, persistedValue)
          ?? reconcileConfigValue(baselineValue, liveValue, persistedValue)
        : key === "disabledModels"
          ? reconcileDisabledModels(baselineValue, liveValue, persistedValue)
            ?? reconcileConfigValue(baselineValue, liveValue, persistedValue)
          : reconcileConfigValue(baselineValue, liveValue, persistedValue, key === "providers");
    if (merged === MISSING_CONFIG_VALUE) delete live[key];
    else live[key] = merged;
  }
}

function reconcileConfigValue(
  baseline: ConfigMergeValue,
  live: ConfigMergeValue,
  persisted: ConfigMergeValue,
  persistedChildDeletionsWin = false,
): ConfigMergeValue {
  const liveChanged = !deepEqual(live, baseline);
  const persistedChanged = !deepEqual(persisted, baseline);

  if (!liveChanged) {
    if (live !== MISSING_CONFIG_VALUE && Array.isArray(live) && Array.isArray(persisted)) {
      live.splice(0, live.length, ...structuredClone(persisted));
      return live;
    }
    if (isPlainConfigRecord(live) && isPlainConfigRecord(persisted)) {
      reconcileConfigRecord(
        live,
        isPlainConfigRecord(baseline) ? baseline : {},
        persisted,
      );
      return live;
    }
    return cloneConfigValue(persisted);
  }

  if (!persistedChanged) return live;

  if (isPlainConfigRecord(live)
    && isPlainConfigRecord(persisted)
    && (baseline === MISSING_CONFIG_VALUE || isPlainConfigRecord(baseline))) {
    reconcileConfigRecord(
      live,
      isPlainConfigRecord(baseline) ? baseline : {},
      persisted,
      undefined,
      persistedChildDeletionsWin,
    );
  }
  // Same-leaf conflicts prefer the pending live management mutation.
  return live;
}

/**
 * Reconcile an async OAuth disk commit into the shared live config without erasing
 * management mutations that have not saved yet. The baseline is a normalized disk
 * snapshot from immediately before login; disjoint object edits merge recursively,
 * while same-leaf conflicts prefer live state.
 */
export function reconcileLiveConfigFromDisk(config: OcxConfig, persistedBaseline: OcxConfig): void {
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source === "fallback") {
    throw new Error(`OAuth config reconciliation failed: ${diagnostics.error ?? "invalid config file"}`);
  }
  const persisted = diagnostics.config;
  const claudeGuardArmed = claudeCodeBaseline.has(config);
  const pendingLiveClaudeMutation = claudeGuardArmed
    && !deepEqual(config.claudeCode, claudeCodeBaseline.get(config));

  persistedLiveServerBinding.set(config, {
    port: persisted.port,
    ...(persisted.hostname !== undefined ? { hostname: persisted.hostname } : {}),
  });

  const childDeletions = prepareConfigObjectChildDeletionRebase(config);
  reconcileConfigRecord(
    config as unknown as Record<string, unknown>,
    persistedBaseline as unknown as Record<string, unknown>,
    persisted as unknown as Record<string, unknown>,
    new Set(["hostname", "port", ...(claudeGuardArmed ? ["claudeCode"] : [])]),
  );
  applyConfigObjectChildDeletions(config, childDeletions);

  if (claudeGuardArmed && !pendingLiveClaudeMutation) {
    if (persisted.claudeCode === undefined) delete config.claudeCode;
    else config.claudeCode = structuredClone(persisted.claudeCode);
    claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
  }
  // The reconciliation may have adopted a providers.<name>.modelCosts edit made
  // by a cooperating process while the OAuth login was pending; keep the overlay
  // registry (and the usage-cache overlay version) in sync with the live config.
  refreshUserCostOverlays(config);
}

/**
 * Read only schema-valid binding fields from the literal file. Missing fields mean
 * their schema defaults; malformed fields keep the last known persisted value.
 */
function readPersistedServerBinding(
  raw: Record<string, unknown>,
  baseline: PersistedServerBinding,
): PersistedServerBinding {
  const port = raw.port === undefined
    ? 10100
    : (typeof raw.port === "number"
        && Number.isInteger(raw.port)
        && raw.port >= 0
        && raw.port <= 65535
      ? raw.port
      : baseline.port);
  const hostname = raw.hostname === undefined
    ? undefined
    : (typeof raw.hostname === "string" ? raw.hostname : baseline.hostname);
  return { port, ...(hostname !== undefined ? { hostname } : {}) };
}

/**
 * The save entry point for every writer holding a LIVE server config, and for a
 * detached snapshot armed through {@link armDetachedConfigBaseline}. The live
 * policy keeps `hostname`/`port` and disk-only keys out of the merge; a detached
 * snapshot has neither hazard, so it rebases every field against its arming
 * baseline instead.
 *
 * Conflict policy, chosen deliberately:
 * - disk changed, we did not → their hand edit wins;
 * - disk changed AND we changed → disjoint fields are merged, while a same-leaf
 *   conflict keeps the live value;
 * - a provider or custom-model row deleted on disk stays deleted even if stale
 *   live state edited that same row;
 * - file missing/unreadable → save what we have, no throw.
 *
 * Custom-model rows are merged by their stable `id`, and `disabledModels` by
 * member, preserving independent edits and deletions across stale whole-config
 * saves.
 */
export function saveConfigPreservingClaudeCode(config: OcxConfig): void {
  const pinError = configReasoningPinsConfigError(config);
  if (pinError) throw new Error(pinError);
  withConfigMutationLockSync(() => {
    const childDeletions = prepareConfigObjectChildDeletionRebase(config);
    const bindingBaseline = persistedLiveServerBinding.get(config);
    // One authoritative pre-write read feeds both the live-config reconciliation and
    // custom-model deletion migration. A second read could observe different bytes.
    const onDisk = readRawConfigJson();
    const baseline = liveConfigBaseline.get(config);
    if (baseline && onDisk !== undefined) {
      const persistedDiagnostics = configDiagnosticsFromRaw(JSON.stringify(onDisk));
      if (persistedDiagnostics.source === "file") {
        // A detached snapshot diverged only where this pipeline mutated it (model
        // discovery fields for the auto-refresh tick): it cannot express a
        // deliberate deletion, so the disk-only-key and listener-binding skips
        // below would only discard concurrent hand edits. It merges every top-level
        // key — including configRebaseProvenance, so a cooperating writer's
        // deletion marker adopted from disk is honored instead of silently dropped —
        // and captures deletion intent from the current disk snapshot before the
        // merge can temporarily restore a key and invalidate its deletion marker.
        const detached = detachedConfigSnapshots.has(config);
        const deletedKeys = detached
          ? configRebaseDeletionKeys(persistedDiagnostics.config)
          : configRebaseDeletionKeys(config);
        const skipped = detached
          ? new Set(["claudeCode"])
          : new Set(["hostname", "port", "claudeCode", CONFIG_REBASE_PROVENANCE_KEY]);
        if (!detached) {
          const provenanceExists = configHasRebaseProvenance(config);
          // Only keys this live config is actually known to have diverged on may be
          // rebased. The baseline is captured once when the server arms it, so any key
          // that appeared on disk afterwards — through saveConfig(), a hand edit, or
          // another process — is absent from the baseline as well as from the live
          // config. Reconciling those keys reads "live never changed this" and adopts
          // the disk value, which resurrects a field the live writer had deliberately
          // deleted (#1462 regression: PUT /api/grok/selection with an empty list).
          // Restrict the merge to keys the baseline knew about, plus keys the live
          // config still carries; a key that exists only on disk is left to the
          // ordinary whole-config write below.
          const rebaseableKeys = new Set([
            ...Object.keys(baseline as unknown as Record<string, unknown>),
            ...Object.keys(config as unknown as Record<string, unknown>),
            ...(provenanceExists
              ? Object.keys(persistedDiagnostics.config as unknown as Record<string, unknown>)
              : []),
          ]);
          for (const key of Object.keys(persistedDiagnostics.config as unknown as Record<string, unknown>)) {
            if (!rebaseableKeys.has(key)) skipped.add(key);
          }
        }
        reconcileConfigRecord(
          config as unknown as Record<string, unknown>,
          baseline as unknown as Record<string, unknown>,
          persistedDiagnostics.config as unknown as Record<string, unknown>,
          skipped,
        );
        for (const key of deletedKeys) {
          delete (config as unknown as Record<string, unknown>)[key];
        }
      }
    }
    applyConfigObjectChildDeletions(config, childDeletions);
    if (claudeCodeBaseline.has(config)) {
      if (onDisk !== undefined) {
        const baseline = claudeCodeBaseline.get(config);
        const persistedClaudeCode = normalizePersistedClaudeCode(onDisk.claudeCode);
        const diskChanged = !deepEqual(persistedClaudeCode, baseline);
        const weChanged = !deepEqual(config.claudeCode, baseline);
        if (diskChanged && !weChanged) {
          config.claudeCode = persistedClaudeCode;
        }
      }
    }
    const provenanceProjection = projectConfigRebaseProvenance(config);
    const projectedConfig = projectCustomModelCatalogMigration(
      onDisk,
      config,
    );
    if (provenanceProjection.configRebaseProvenance === undefined) delete projectedConfig.configRebaseProvenance;
    else projectedConfig.configRebaseProvenance = provenanceProjection.configRebaseProvenance;
    const persistedBinding = bindingBaseline && onDisk
      ? readPersistedServerBinding(onDisk, bindingBaseline)
      : bindingBaseline;
    if (persistedBinding) {
      const persistedConfig: OcxConfig = { ...projectedConfig, port: persistedBinding.port };
      if (persistedBinding.hostname === undefined) delete persistedConfig.hostname;
      else persistedConfig.hostname = persistedBinding.hostname;
      if (persistConfigUnlocked(persistedConfig)) bumpGenerationForCooperatingConfigWrite();
      persistedLiveServerBinding.set(config, persistedBinding);
    } else {
      if (persistConfigUnlocked(projectedConfig)) bumpGenerationForCooperatingConfigWrite();
    }
    adoptCustomModelCatalogMigration(config, projectedConfig);
    if (claudeCodeBaseline.has(config)) {
      claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
    }
    if (liveConfigBaseline.has(config)) {
      if (projectedConfig.configRebaseProvenance === undefined) delete config.configRebaseProvenance;
      else config.configRebaseProvenance = structuredClone(projectedConfig.configRebaseProvenance);
      liveConfigBaseline.set(config, structuredClone(projectedConfig));
    }
    clearPendingConfigObjectChildDeletions(config);
    clearPendingConfigTopLevelDeletions(config);
  });
}

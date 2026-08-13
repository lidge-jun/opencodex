import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { atomicWriteFile, expandUserPath, getConfigDir, websocketsEnabled } from "../../config";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, readRootTomlString, resolveCodexConfigPath } from "../paths";
import { clearModelCache, DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, isModelsFetchCoolingDown, markModelsFetchFailure, setCached } from "../model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "../../oauth";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { getModelMetadata, getModelMetadataCaseInsensitive, listModelMetadata, resolveMetadataProvider } from "../../generated/model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import { getProviderRegistryEntry } from "../../providers/registry";
import { applyProviderContextCap, providerContextCap } from "../../providers/context-cap";
import { routedSlug, slugEquals, slugsEquivalent } from "../../providers/slug-codec";
import { CODEX_GPT5_IDENTITY_LINE } from "../../adapters/identity";
import { filterCursorConfiguredModelsByLiveDiscovery } from "../../adapters/cursor/discovery";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import { isCanonicalOpenAiForwardProvider, OPENAI_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import {
  COMBO_NAMESPACE,
  comboModelId,
  getCombo,
  listComboIds,
  targetKey,
} from "../../combos";
import type { NormalizedComboConfig } from "../../combos/types";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { redactSecretString } from "../../lib/redact";
import upstreamModelsSnapshot from "../data/upstream-models.json";


import { activeCodexModelsCachePath, catalogBackupPathFor, findNativeTemplate, isDefaultCatalogPath, legacyCatalogBackupPath, parseCatalogJson, readCatalog, readCatalogBackup, readCodexCatalogPath } from "./parsing";
import type { RawCatalog, RawEntry } from "./parsing";
import { codexExecInvocation, isSpawnableCodexCandidate } from "../exec-invocation";
import {
  parsePersistedCodexRuntime,
  peekCodexRuntimeProcessCache,
  resolveAndPersistCodexRuntime,
} from "../runtime";
import type {
  DeepReadonly,
  EffortClampDiagnostic,
  ResolvedCodexRuntime,
} from "../runtime";
import type {
  CatalogGatherEvidenceSession,
  CatalogGatherReadableSourceRole,
} from "./filesystem-evidence";

export { isSpawnableCodexCandidate, codexExecInvocation } from "../exec-invocation";
export type {
  CatalogGatherEvidenceSession,
  CatalogGatherReadableSourceRole,
} from "./filesystem-evidence";

export const BUNDLED_CATALOG_CACHE_MS = 60_000;

export type ReadonlyRawCatalog = DeepReadonly<RawCatalog>;

interface BundledCatalogMemo {
  /** Selected runtime identity; must change when doctor/sync picks a different binary. */
  readonly key: string;
  readonly expiresAt: number;
  readonly epoch: number;
  readonly valueIdentity: string;
  readonly value: ReadonlyRawCatalog | null;
}

export interface BundledCatalogCacheState {
  readonly epoch: number;
  readonly valueIdentity: string | null;
}

let bundledCatalogEpoch = 0;
let bundledCatalogCache: BundledCatalogMemo | null = null;

function cloneAndDeepFreeze<T>(value: T): DeepReadonly<T> {
  const clone = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(clone);
    if (current && typeof current === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(current)) out[key] = clone(child);
      return out;
    }
    return current;
  };
  const freeze = (current: unknown): unknown => {
    if (!current || typeof current !== "object" || Object.isFrozen(current)) return current;
    for (const child of Object.values(current)) freeze(child);
    return Object.freeze(current);
  };
  return freeze(clone(value)) as DeepReadonly<T>;
}

function bundledRuntimeKey(
  runtime: Pick<ResolvedCodexRuntime, "command" | "version">,
  opencodexHome: string = process.env.OPENCODEX_HOME ?? "",
): string {
  return [runtime.command, runtime.version ?? "", opencodexHome].join("\0");
}

function publishBundledCatalogCache(
  key: string,
  expiresAt: number,
  value: RawCatalog | null,
): void {
  const epoch = ++bundledCatalogEpoch;
  bundledCatalogCache = {
    key,
    expiresAt,
    epoch,
    valueIdentity: `bundled:${epoch}`,
    value: value === null ? null : cloneAndDeepFreeze(value),
  };
}

function clearBundledCatalogCache(): void {
  bundledCatalogEpoch += 1;
  bundledCatalogCache = null;
}

export function bundledCatalogCacheState(): Readonly<BundledCatalogCacheState> {
  return Object.freeze({
    epoch: bundledCatalogEpoch,
    valueIdentity: bundledCatalogCache?.valueIdentity ?? null,
  });
}

/** Test-only: clear the bundled-catalog cache (owned here; sync.ts calls this instead of assigning the import). */
export function resetBundledCatalogCacheForTests(): void {
  clearBundledCatalogCache();
}

/** Drop the process-local bundled catalog memo (e.g. after runtime selection changes). */
export function invalidateBundledCatalogCache(): void {
  clearBundledCatalogCache();
}

/** Test-only owner mutation seam; input is cloned and frozen before publication. */
export function setBundledCatalogCacheForTests(
  runtime: Pick<ResolvedCodexRuntime, "command" | "version">,
  value: RawCatalog | null,
  options: Readonly<{ expiresAt?: number; opencodexHome?: string }> = {},
): void {
  publishBundledCatalogCache(
    bundledRuntimeKey(runtime, options.opencodexHome),
    options.expiresAt ?? Date.now() + BUNDLED_CATALOG_CACHE_MS,
    value,
  );
}

export type ExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: boolean;
    shell?: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => string;

export interface BundledCatalogDeps {
  commandCandidates?: () => string[];
  execFileSync?: ExecFile;
  onEffortClamp?: (diagnostic: EffortClampDiagnostic) => void;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
  now?: () => number;
  discoverAlternatives?: boolean;
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function codexCommandCandidates(): string[] {
  const envPath = process.env.CODEX_CLI_PATH?.trim();
  const candidates = envPath ? [envPath] : [];
  candidates.push(...codexShimCommandCandidates());
  if (process.platform === "win32") {
    for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      candidates.push(join(dir, "codex.exe"), join(dir, "codex.cmd"));
    }
  }
  candidates.push("codex");
  return unique(candidates);
}

export function codexShimCommandCandidates(): string[] {
  try {
    const state = JSON.parse(readFileSync(join(getConfigDir(), "codex-shim.json"), "utf8")) as {
      wrapperPath?: unknown;
      originalPath?: unknown;
      backupPath?: unknown;
      wrappers?: Array<{ wrapperPath?: unknown; originalPath?: unknown; backupPath?: unknown }>;
    };
    const files = Array.isArray(state.wrappers) && state.wrappers.length > 0 ? state.wrappers : [state];
    const out: string[] = [];
    for (const file of files) {
      for (const value of [file.backupPath, file.originalPath, file.wrapperPath]) {
        if (typeof value !== "string" || value.length === 0) continue;
        if (!isSpawnableCodexCandidate(value)) continue;
        out.push(value);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function runCodexDebugModels(
  command: string,
  execFile: ExecFile,
  deps: Pick<BundledCatalogDeps, "env" | "platform" | "existsSync"> = {},
): string {
  const args = ["debug", "models", "--bundled"];
  const invocation = codexExecInvocation(command, args, deps.platform ?? process.platform, {
    env: deps.env,
    exists: deps.existsSync,
  });
  return execFile(invocation.file, invocation.args, {
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    windowsHide: true,
    ...invocation.options,
  });
}

export function loadBundledCodexCatalog(deps: BundledCatalogDeps = {}): ReadonlyRawCatalog | null {
  const useCache = !deps.commandCandidates && !deps.execFileSync && !deps.configDir && !deps.env;
  const execFile = deps.execFileSync ?? (execFileSync as unknown as ExecFile);
  // Prefer the single resolved runtime so sync/clamp never probe a different binary
  // than OpenCodex will launch. Tests may inject commandCandidates to stub probing.
  let cacheKey: string | null = null;
  const candidates = deps.commandCandidates?.() ?? (() => {
    const resolved = resolveAndPersistCodexRuntime({
      // Forward an INJECTED execFileSync only. Passing the real one unconditionally made
      // resolveCacheKey() bail out (it refuses to memoize injected-dep resolves), so every
      // catalog read re-ran the ~1s `codex --version` probe even on a warm cache hit.
      ...(deps.execFileSync ? { execFileSync: deps.execFileSync } : {}),
      configDir: deps.configDir,
      env: deps.env,
      platform: deps.platform,
      existsSync: deps.existsSync,
      readFileSync: deps.readFileSync,
      now: deps.now,
      // Catalog loading only consumes `resolved.runtime.command`, never `newerAvailable`.
      // Full PATH discovery probes every candidate launcher (100+ on a dev machine, ~1.2s),
      // which alone can exceed the 3s budget `ocx claude` allows /api/claude-code. Priority
      // selection is identical either way; callers wanting discovery diagnostics opt in.
      discoverAlternatives: deps.discoverAlternatives ?? false,
    });
    if (useCache) {
      cacheKey = bundledRuntimeKey(resolved.runtime);
    }
    return [resolved.runtime.command];
  })();
  if (
    useCache
    && cacheKey
    && bundledCatalogCache
    && bundledCatalogCache.key === cacheKey
    && bundledCatalogCache.expiresAt > Date.now()
  ) {
    return bundledCatalogCache.value === null
      ? null
      : cloneAndDeepFreeze(bundledCatalogCache.value);
  }
  for (const command of unique(candidates)) {
    try {
      const catalog = parseCatalogJson(runCodexDebugModels(command, execFile, deps));
      if (catalog && findNativeTemplate(catalog)) {
        if (useCache && cacheKey) {
          publishBundledCatalogCache(
            cacheKey,
            Date.now() + BUNDLED_CATALOG_CACHE_MS,
            catalog,
          );
          return cloneAndDeepFreeze(bundledCatalogCache!.value!);
        }
        return cloneAndDeepFreeze(catalog);
      }
    } catch { /* try next candidate */ }
  }
  if (useCache && cacheKey) {
    publishBundledCatalogCache(
      cacheKey,
      Date.now() + BUNDLED_CATALOG_CACHE_MS,
      null,
    );
  }
  return null;
}

export type CatalogGatherProcessLocalObservation =
  | Readonly<{ state: "unused" }>
  | Readonly<{ state: "used"; epoch: number; valueIdentity: string }>;

export type CodexRuntimeForCatalogGather =
  | Readonly<{
      kind: "available";
      origin: "process-cache" | "persisted";
      runtime: DeepReadonly<ResolvedCodexRuntime>;
      processLocal: CatalogGatherProcessLocalObservation;
    }>
  | Readonly<{
      kind: "runtime-unavailable";
      processLocal: Readonly<{ state: "unused" }>;
    }>;

export type CatalogSourceForGather =
  | Readonly<{
      kind: "available";
      source:
        | "bundled-catalog-template"
        | "active-catalog-merge"
        | "hashed-backup-fallback"
        | "legacy-backup-fallback"
        | "models-cache-fallback";
      catalog: ReadonlyRawCatalog;
      runtimeSupport:
        | Readonly<{ kind: "available"; catalog: ReadonlyRawCatalog }>
        | Readonly<{ kind: "unavailable" }>;
      processLocal: Readonly<{
        runtime: CatalogGatherProcessLocalObservation;
        bundledCatalog: CatalogGatherProcessLocalObservation;
      }>;
    }>
  | Readonly<{
      kind: "catalog-unavailable";
      processLocal: Readonly<{
        runtime: Readonly<{ state: "unused" }>;
        bundledCatalog: Readonly<{ state: "unused" }>;
      }>;
    }>;

export type CatalogGatherPathKind = "default" | "custom";

const UNUSED_PROCESS_LOCAL = Object.freeze({ state: "unused" as const });

function sameRuntimeIdentity(
  left: Pick<ResolvedCodexRuntime, "command" | "version">,
  right: Pick<ResolvedCodexRuntime, "command" | "version">,
): boolean {
  return left.command === right.command && (left.version ?? null) === (right.version ?? null);
}

/**
 * Observe an already-resolved runtime only. The evidence owner supplies the
 * exact persisted bytes (or observed absence); this path never probes or writes.
 */
export function peekCodexRuntimeForCatalogGather(
  evidenceSession: CatalogGatherEvidenceSession,
): CodexRuntimeForCatalogGather {
  const persistedBytes = evidenceSession.readSource("runtime-selection");
  const persisted = persistedBytes === null
    ? null
    : parsePersistedCodexRuntime(persistedBytes);
  const processMemo = peekCodexRuntimeProcessCache();

  if (processMemo.kind === "available") {
    const runtime = processMemo.value.runtime;
    if (persistedBytes === null || (persisted && sameRuntimeIdentity(runtime, {
      command: persisted.command,
      version: persisted.selectedVersion ?? null,
    }))) {
      return cloneAndDeepFreeze({
        kind: "available" as const,
        origin: "process-cache" as const,
        runtime,
        processLocal: {
          state: "used" as const,
          epoch: processMemo.epoch,
          valueIdentity: processMemo.valueIdentity,
        },
      });
    }
  }

  if (persisted) {
    return cloneAndDeepFreeze({
      kind: "available" as const,
      origin: "persisted" as const,
      runtime: {
        command: persisted.command,
        version: persisted.selectedVersion ?? null,
        source: persisted.source,
      },
      processLocal: UNUSED_PROCESS_LOCAL,
    });
  }

  return Object.freeze({
    kind: "runtime-unavailable" as const,
    processLocal: UNUSED_PROCESS_LOCAL,
  });
}

/**
 * Resolve only already-observed catalog sources. A cold process cache falls
 * through to evidence-owned persisted sources and never becomes probe authority.
 */
export function resolveCatalogSourceForGather(
  evidenceSession: CatalogGatherEvidenceSession,
  pathKind: CatalogGatherPathKind,
): CatalogSourceForGather {
  const bundledMemo = bundledCatalogCache;
  let runtimeSupport:
    | Readonly<{ kind: "available"; catalog: ReadonlyRawCatalog }>
    | Readonly<{ kind: "unavailable" }> = Object.freeze({ kind: "unavailable" });
  let processLocal: Readonly<{
    runtime: CatalogGatherProcessLocalObservation;
    bundledCatalog: CatalogGatherProcessLocalObservation;
  }> = {
    runtime: UNUSED_PROCESS_LOCAL,
    bundledCatalog: UNUSED_PROCESS_LOCAL,
  };
  if (bundledMemo?.value && bundledMemo.expiresAt > Date.now()) {
    const runtime = peekCodexRuntimeForCatalogGather(evidenceSession);
    if (runtime.kind === "available" && bundledMemo.key === bundledRuntimeKey(runtime.runtime)) {
      runtimeSupport = Object.freeze({
        kind: "available" as const,
        catalog: bundledMemo.value,
      });
      processLocal = {
        runtime: runtime.processLocal,
        bundledCatalog: {
          state: "used" as const,
          epoch: bundledMemo.epoch,
          valueIdentity: bundledMemo.valueIdentity,
        },
      };
      if (pathKind === "default") {
        return cloneAndDeepFreeze({
          kind: "available" as const,
          source: "bundled-catalog-template" as const,
          catalog: bundledMemo.value,
          runtimeSupport,
          processLocal,
        });
      }
    }
  }

  const roles = pathKind === "default"
    ? [
        "active-catalog-merge",
        "hashed-backup-fallback",
        "legacy-backup-fallback",
        "models-cache-fallback",
      ] as const
    : [
        "active-catalog-merge",
        "hashed-backup-fallback",
        "models-cache-fallback",
      ] as const;
  for (const role of roles) {
    const bytes = evidenceSession.readSource(role);
    if (bytes === null) continue;
    const catalog = parseCatalogJson(Buffer.from(bytes).toString("utf8"));
    if (!catalog) continue;
    // Custom catalogs may intentionally contain only routed rows. Keep their existing source
    // priority (active, then backup/cache) without imposing the default catalog's native-template
    // requirement; a valid active custom file therefore remains authoritative over stale fallbacks.
    if (pathKind === "default" && !findNativeTemplate(catalog)) continue;
    return cloneAndDeepFreeze({
      kind: "available" as const,
      source: role,
      catalog,
      runtimeSupport,
      processLocal,
    });
  }

  return Object.freeze({
    kind: "catalog-unavailable" as const,
    processLocal: Object.freeze({
      runtime: UNUSED_PROCESS_LOCAL,
      bundledCatalog: UNUSED_PROCESS_LOCAL,
    }),
  });
}

export function materializeBundledCodexCatalog(path: string, deps: BundledCatalogDeps = {}): RawCatalog | null {
  const catalog = loadBundledCodexCatalog(deps);
  if (!catalog) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFile(path, JSON.stringify(catalog, null, 2) + "\n");
  } catch {
    return null;
  }
  return JSON.parse(JSON.stringify(catalog)) as RawCatalog;
}

export function loadCatalogForSync(path: string): RawCatalog | null {
  const bundled = isDefaultCatalogPath(path) ? loadBundledCodexCatalog() : null;
  if (bundled) return JSON.parse(JSON.stringify(bundled)) as RawCatalog;
  const catalog = readCatalog(path);
  if (catalog && findNativeTemplate(catalog)) return catalog;
  return readCatalog(catalogBackupPathFor(path))
    ?? (isDefaultCatalogPath(path) ? readCatalog(legacyCatalogBackupPath()) : null)
    ?? readCatalog(activeCodexModelsCachePath())
    ?? materializeBundledCodexCatalog(path)
    ?? catalog;
}

export function readCurrentCatalogOrCache(): RawCatalog | null {
  const path = readCodexCatalogPath();
  const bundled = isDefaultCatalogPath(path) ? loadBundledCodexCatalog() : null;
  if (bundled) return JSON.parse(JSON.stringify(bundled)) as RawCatalog;
  return readCatalog(path) ?? readCatalog(activeCodexModelsCachePath());
}

/**
 * Read the user-owned Codex catalog surfaces without substituting the bundled catalog.
 *
 * The bundled catalog is intentionally the authority for static native metadata on the default
 * path. Account-qualified discovery needs the opposite view: an exact model id that Codex has
 * observed in the user's catalog/cache may be account-scoped even when this release does not know
 * it statically yet.
 */
export function readCurrentCodexCatalog(): RawCatalog | null {
  return readCatalog(readCodexCatalogPath());
}

export function readCurrentCodexModelsCache(): RawCatalog | null {
  return readCatalog(activeCodexModelsCachePath());
}

export function loadCatalogTemplate(): RawEntry | null {
  const catalogPath = readCodexCatalogPath();
  const bundled = loadBundledCodexCatalog();
  const native = findNativeTemplate(readCatalog(catalogPath))
    ?? findNativeTemplate(readCatalogBackup(catalogPath))
    ?? findNativeTemplate(readCatalog(activeCodexModelsCachePath()))
    ?? findNativeTemplate(bundled ? JSON.parse(JSON.stringify(bundled)) as RawCatalog : null);
  return native ? JSON.parse(JSON.stringify(native)) : null;
}

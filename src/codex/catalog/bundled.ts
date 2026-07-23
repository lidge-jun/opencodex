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
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive, listJawcodeModelMetadata, resolveJawcodeProvider } from "../../generated/jawcode-model-metadata";
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
import { resolveAndPersistCodexRuntime } from "../runtime";
import type { EffortClampDiagnostic } from "../runtime";

export { isSpawnableCodexCandidate, codexExecInvocation } from "../exec-invocation";

export const BUNDLED_CATALOG_CACHE_MS = 60_000;

export let bundledCatalogCache: { expiresAt: number; value: RawCatalog | null } | null = null;

/** Test-only: clear the bundled-catalog cache (owned here; sync.ts calls this instead of assigning the import). */
export function resetBundledCatalogCacheForTests(): void {
  bundledCatalogCache = null;
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

export function loadBundledCodexCatalog(deps: BundledCatalogDeps = {}): RawCatalog | null {
  const useCache = !deps.commandCandidates && !deps.execFileSync && !deps.configDir && !deps.env;
  if (useCache && bundledCatalogCache && bundledCatalogCache.expiresAt > Date.now()) {
    return bundledCatalogCache.value;
  }
  const execFile = deps.execFileSync ?? (execFileSync as unknown as ExecFile);
  // Prefer the single resolved runtime so sync/clamp never probe a different binary
  // than OpenCodex will launch. Tests may inject commandCandidates to stub probing.
  const candidates = deps.commandCandidates?.() ?? (() => {
    const resolved = resolveAndPersistCodexRuntime({
      execFileSync: execFile,
      configDir: deps.configDir,
      env: deps.env,
      platform: deps.platform,
      existsSync: deps.existsSync,
      readFileSync: deps.readFileSync,
    });
    return [resolved.runtime.command];
  })();
  for (const command of unique(candidates)) {
    try {
      const catalog = parseCatalogJson(runCodexDebugModels(command, execFile, deps));
      if (catalog && findNativeTemplate(catalog)) {
        if (useCache) bundledCatalogCache = { expiresAt: Date.now() + BUNDLED_CATALOG_CACHE_MS, value: catalog };
        return catalog;
      }
    } catch { /* try next candidate */ }
  }
  if (useCache) bundledCatalogCache = { expiresAt: Date.now() + BUNDLED_CATALOG_CACHE_MS, value: null };
  return null;
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
  return catalog;
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
  return (isDefaultCatalogPath(path) ? loadBundledCodexCatalog() : null)
    ?? readCatalog(path)
    ?? readCatalog(activeCodexModelsCachePath());
}

export function loadCatalogTemplate(): RawEntry | null {
  const catalogPath = readCodexCatalogPath();
  const native = findNativeTemplate(readCatalog(catalogPath))
    ?? findNativeTemplate(readCatalogBackup(catalogPath))
    ?? findNativeTemplate(readCatalog(activeCodexModelsCachePath()))
    ?? findNativeTemplate(loadBundledCodexCatalog());
  return native ? JSON.parse(JSON.stringify(native)) : null;
}

import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import type { OcxClaudeDesktopProfile } from "../types";
import {
  reconcileDesktopProfile,
  renderDesktopProfile,
  type DesktopProfileModel,
} from "./desktop-profile";

export interface Desktop3pModelEntry {
  name: string;
  labelOverride: string;
  anthropicFamilyTier: "opus" | "fable" | "sonnet" | "haiku";
  isFamilyDefault?: boolean;
  /**
   * Desktop's documented 1M-context capability assertion. Set ONLY from an
   * authoritative routed contextWindow >= 1M — never guessed (devlog 136 B5).
   */
  supports1m?: true;
}

/**
 * static (default, Pro-verified devlog 138): pinned inferenceModels with
 * modelDiscoveryEnabled:false — a static list OVERRIDES discovery (no merge), so
 * this is the deterministic shape. hybrid keeps discovery:true alongside the list
 * (claude-code-router's version-defensive pattern). discovery: /v1/models only.
 */
export type Desktop3pConfigMode = "hybrid" | "discovery" | "static";

export interface Desktop3pRoutedModel {
  provider: string;
  id: string;
  /** Authoritative context window (CatalogModel.contextWindow); optional. */
  contextWindow?: number;
}

const SUPPORTS_1M_THRESHOLD = 1_000_000;

/** CLI arg parsing for `ocx claude desktop` mode flags (mutually exclusive). */
export function parseDesktop3pModeArgs(flags: string[]): { mode: Desktop3pConfigMode } | { error: string } {
  const known = new Map<string, Desktop3pConfigMode>([
    ["--static", "static"],
    ["--hybrid", "hybrid"],
    ["--discovery-only", "discovery"],
  ]);
  const unknown = flags.filter(a => !known.has(a));
  if (unknown.length > 0) return { error: `알 수 없는 옵션: ${unknown.join(" ")} (지원: --static, --hybrid, --discovery-only)` };
  const picked = [...new Set(flags.map(a => known.get(a)!))];
  if (picked.length > 1) return { error: "모드 옵션은 하나만 쓸 수 있습니다 (--static | --hybrid | --discovery-only)." };
  return { mode: picked[0] ?? "static" };
}

interface Desktop3pMetadataEntry {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface Desktop3pMetadata {
  appliedId?: string;
  entries: Desktop3pMetadataEntry[];
  [key: string]: unknown;
}

let desktop3pRegistry = new Map<string, string>();
let desktop3pAliasesByRoute = new Map<string, string>();

/** Derive a stable letter-first, three-character base36 code from a route key. */
export function deriveDesktop3pCode(route: string): string {
  const hash = createHash("sha256").update(route).digest();
  const n = hash.readUInt32BE(0) % 33696;
  const first = String.fromCharCode(97 + Math.floor(n / 1296));
  const rest = (n % 1296).toString(36).padStart(2, "0");
  return first + rest;
}

/**
 * Alias for one proxy model. Real Anthropic models pass through unchanged (they must
 * keep hitting the sk-ant native passthrough); everything else gets a Claude-shaped
 * `claude-opus-4-8-{code}` id. Opus 4.8 is chosen deliberately: Desktop's effort
 * selector is an allowlist keyed on exact supported model ids (Opus 4.8/4.7/4.6,
 * Sonnet 4.6 — devlog 131), and 4.6+ canonical ids are dateless, so the letter-first
 * 3-char suffix can never collide with a real id or a legacy date suffix.
 */
export function desktop3pAlias(provider: string, modelId: string): string {
  if (provider === "anthropic" && modelId.startsWith("claude-")) return modelId;
  return `claude-opus-4-8-${deriveDesktop3pCode(`${provider}/${modelId}`)}`;
}

/** Pre-rename alias shape (claude-opus-4-{code}) — still decoded for stale Desktop configs. */
export function legacyDesktop3pAlias(provider: string, modelId: string): string {
  return `claude-opus-4-${deriveDesktop3pCode(`${provider}/${modelId}`)}`;
}

function displayModelId(modelId: string): string {
  return modelId
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => {
      const lower = part.toLowerCase();
      if (lower === "gpt" || lower === "glm" || lower === "ai") return lower.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function collectDesktop3pModels(
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  profile?: OcxClaudeDesktopProfile,
): { models: Desktop3pModelEntry[]; registry: Map<string, string> } {
  const registry = new Map<string, string>();
  const models: Desktop3pModelEntry[] = [];
  const candidates: Desktop3pRoutedModel[] = [
    ...nativeSlugs.map(id => ({ provider: "native", id })),
    ...routedModels,
  ];

  if (profile) {
    const profileModels = candidates.map(({ provider, id, contextWindow }) => ({
      route: `${provider}/${id}`,
      label: `${displayModelId(id)} (${provider})`,
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
    } satisfies DesktopProfileModel));
    const reconciled = reconcileDesktopProfile(profile, profileModels);
    const rendered = renderDesktopProfile(reconciled, profileModels);
    const aliasesByRoute = new Map<string, string>();
    for (const model of rendered) {
      aliasesByRoute.set(model.route, model.name);
      if (!model.route.startsWith("anthropic/claude-")) registry.set(model.name, model.route);
      models.push({
        name: model.name,
        labelOverride: model.label,
        anthropicFamilyTier: model.family,
        ...(model.isFamilyDefault ? { isFamilyDefault: true } : {}),
        ...(model.supports1m ? { supports1m: true } : {}),
      });
    }
    // Legacy hashes are compatibility-only and can collide. Bind them in stable route order so
    // changing a family default or rendered ordering can never silently rebind an old Desktop id.
    for (const model of [...rendered].sort((a, b) => a.route.localeCompare(b.route))) {
      if (model.route.startsWith("anthropic/claude-")) continue;
      const providerEnd = model.route.indexOf("/");
      const provider = model.route.slice(0, providerEnd);
      const id = model.route.slice(providerEnd + 1);
      const legacy = legacyDesktop3pAlias(provider, id);
      const existing = registry.get(legacy);
      if (existing && existing !== model.route) {
        console.warn(`[opencodex] Claude Desktop legacy alias collision: ${legacy} stays bound to ${existing}; ignoring ${model.route}`);
        continue;
      }
      registry.set(legacy, model.route);
    }
    desktop3pAliasesByRoute = aliasesByRoute;
    return { models, registry };
  }

  for (const { provider, id, contextWindow } of candidates) {
    const route = `${provider}/${id}`;
    const alias = desktop3pAlias(provider, id);
    const supports1m = typeof contextWindow === "number" && contextWindow >= SUPPORTS_1M_THRESHOLD
      ? { supports1m: true as const }
      : {};
    if (alias === id) {
      // Real Anthropic model: keep it OUT of the decode registry — registering it would
      // make resolveInboundModel() non-identity and kill the sk-ant native passthrough
      // (audit 133 #1). It still appears in the static Desktop model list below.
      models.push({
        name: alias,
        labelOverride: `${displayModelId(id)} (${provider})`,
        anthropicFamilyTier: "opus",
        ...supports1m,
      });
      continue;
    }
    const existingRoute = registry.get(alias);
    if (existingRoute !== undefined) {
      console.warn(`[opencodex] Claude Desktop 3P alias collision: ${alias} maps to both ${existingRoute} and ${route}; skipping ${route}`);
      continue;
    }

    registry.set(alias, route);
    // Back-compat decode for Desktop configs written before the opus-4-8 rename.
    const legacy = legacyDesktop3pAlias(provider, id);
    if (!registry.has(legacy)) registry.set(legacy, route);
    models.push({
      name: alias,
      labelOverride: `${displayModelId(id)} (${provider})`,
      anthropicFamilyTier: "opus",
      ...supports1m,
    });
  }

  if (models[0]) models[0].isFamilyDefault = true;
  desktop3pAliasesByRoute = new Map(candidates.map(({ provider, id }) => [`${provider}/${id}`, desktop3pAlias(provider, id)]));
  return { models, registry };
}

/** Build and install the registry used to decode Desktop aliases. */
export function buildDesktop3pRegistry(
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  profile?: OcxClaudeDesktopProfile,
): Map<string, string> {
  const { registry } = collectDesktop3pModels(nativeSlugs, routedModels, profile);
  desktop3pRegistry = registry;
  return registry;
}

/** Generate Claude Desktop 3P model entries from the proxy's available models. */
export function generateDesktop3pModels(
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  profile?: OcxClaudeDesktopProfile,
): Desktop3pModelEntry[] {
  const { models, registry } = collectDesktop3pModels(nativeSlugs, routedModels, profile);
  desktop3pRegistry = registry;
  return models;
}

/** Resolve an alias using the most recently generated Desktop model registry. */
export function resolveDesktop3pAlias(alias: string): string | null {
  return desktop3pRegistry.get(alias) ?? null;
}

/** Alias selected by the installed profile registry, falling back to the legacy hash shape. */
export function activeDesktop3pAlias(provider: string, modelId: string): string {
  return desktop3pAliasesByRoute.get(`${provider}/${modelId}`) ?? desktop3pAlias(provider, modelId);
}

/**
 * Generate the complete Claude Desktop 3P gateway config.
 *
 * Default mode is "static" (Pro-verified, devlog 138): the static list is the ONLY
 * channel for supports1m/tier pins and it overrides discovery anyway (no merge), so
 * discovery stays off for determinism. supports1m makes Desktop offer a separate 1M
 * row; selecting it sends the bare id + `anthropic-beta: context-1m-2025-08-07`.
 */
export function generateDesktop3pConfig(
  port: number,
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  apiKey = "ocx",
  mode: Desktop3pConfigMode = "static",
  profile?: OcxClaudeDesktopProfile,
): object {
  const base = {
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: `http://127.0.0.1:${port}`,
    inferenceGatewayApiKey: apiKey,
  };
  if (mode === "discovery") {
    // Build/refresh the decode registry even though no static list is emitted.
    buildDesktop3pRegistry(nativeSlugs, routedModels, profile);
    return { ...base, modelDiscoveryEnabled: true };
  }
  return {
    ...base,
    modelDiscoveryEnabled: mode === "hybrid",
    inferenceModels: generateDesktop3pModels(nativeSlugs, routedModels, profile),
  };
}

function parseMetadata(path: string): Desktop3pMetadata {
  if (!existsSync(path)) return { entries: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Desktop3pMetadata>;
  if (!Array.isArray(parsed.entries)) throw new Error("Claude Desktop 3P _meta.json has no entries array");
  return { ...parsed, entries: parsed.entries };
}

/** Write and apply the opencodex config in Claude Desktop 3P's config library. */
export function writeDesktop3pConfig(
  port: number,
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  apiKey?: string,
  mode: Desktop3pConfigMode = "static",
  profile?: OcxClaudeDesktopProfile,
): { written: boolean; path: string; reason?: string } {
  const libraryPath = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR?.trim()
    || join(homedir(), "Library", "Application Support", "Claude-3p", "configLibrary");
  const metadataPath = join(libraryPath, "_meta.json");
  let configPath = libraryPath;

  try {
    mkdirSync(libraryPath, { recursive: true, mode: 0o700 });
    const metadata = parseMetadata(metadataPath);
    const existing = metadata.entries.find(entry => entry?.name === "opencodex" && typeof entry.id === "string");
    const id = existing?.id ?? randomUUID();
    configPath = join(libraryPath, `${id}.json`);
    const entry: Desktop3pMetadataEntry = existing ? { ...existing, id, name: "opencodex" } : { id, name: "opencodex" };
    const entries = existing
      ? metadata.entries.map(current => current === existing ? entry : current)
      : [...metadata.entries, entry];

    const configJson = JSON.stringify(generateDesktop3pConfig(port, nativeSlugs, routedModels, apiKey, mode, profile), null, 2) + "\n";
    atomicReplaceDesktopConfig(configPath, configJson);
    atomicWriteFile(metadataPath, JSON.stringify({ ...metadata, appliedId: id, entries }, null, 2) + "\n");
    return { written: true, path: configPath };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { written: false, path: configPath, reason };
  }
}

/** Backup an existing owned config then atomically replace it. Exported for failure-path tests. */
export function atomicReplaceDesktopConfig(
  path: string,
  content: string,
  writer: (path: string, content: string) => void = atomicWriteFile,
): { backupPath?: string } {
  const backupPath = `${path}.bak`;
  if (existsSync(path)) copyFileSync(path, backupPath);
  writer(path, content);
  return existsSync(backupPath) ? { backupPath } : {};
}

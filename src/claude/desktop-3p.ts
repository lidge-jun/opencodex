import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import type { OcxClaudeDesktopProfile } from "../types";
import { claudeDesktopConfigLibraryDir, resolveConfigLibraryDir } from "./desktop-3p-paths";
import {
  reconcileDesktopProfile,
  renderDesktopProfile,
  type DesktopProfileModel,
} from "./desktop-profile";
import { nativeOpenAiContextWindow, type NativeContextLimitsInput } from "../codex/catalog";
import { assertDesktop3pModelsValid } from "./desktop-3p-guard";

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
  /** When true, Desktop selects the 1M variant by default (official schema, Luna research 260722). */
  prefer1m?: true;
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

/**
 * 1M-context eligibility, shared with the Desktop DTO so the dashboard's 1M chip can
 * never disagree with what the writer emits. The DTO imports this from here — keeping
 * the constant in this module avoids a cycle, since shared.ts already reads
 * claude/desktop-profile.
 */
export const DESKTOP_SUPPORTS_1M_THRESHOLD = 1_000_000;

export interface Desktop3pConfigLibraryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

/**
 * Resolve the config library from the same user-data root Claude Desktop uses. Keeping this in one
 * helper prevents the writer and dashboard status probe from agreeing on a path Desktop never reads.
 *
 * The resolution itself lives in `./desktop-3p-paths`, which ports Claude Desktop's own `GE()`
 * branch for branch — including the `-3p` suffix the app appends to its userData root. Dropping
 * that suffix points us at a directory Desktop never reads (GitHub #539).
 */
export function resolveDesktop3pConfigLibraryPath(
  options: Desktop3pConfigLibraryOptions = {},
): string {
  if (options.env === undefined && options.platform === undefined && options.homeDir === undefined) {
    return claudeDesktopConfigLibraryDir();
  }
  return resolveConfigLibraryDir({
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    home: options.homeDir ?? homedir(),
  });
}

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

export type Desktop3pLibraryKind =
  | "not_installed"
  | "standard"
  | "gateway_ours"
  | "gateway_drifted"
  | "foreign"
  | "no_owned_state"
  | "broken"
  | "unsafe";

export interface Desktop3pLibraryInspection {
  kind: Desktop3pLibraryKind;
  libraryPath: string;
  selectedProfilePath: string | null;
  appliedId: string | null;
  /** Paths of opencodex-owned rows that are not selected by Desktop. */
  residualPaths: string[];
  /** Bounded reason code; never includes metadata or profile contents. */
  reason?: "metadata_unreadable" | "unsafe_applied_id" | "invalid_owned_profile";
  fingerprint?: string;
  /**
   * Whether Desktop's applied selection is our owned entry, by ID match alone.
   * `null` = undeterminable (no metadata, unreadable metadata, or no appliedId);
   * a readable appliedId with no owned entry is a KNOWN false, not unknown.
   * Deliberately independent of profile-file health: the status contract
   * predates this inspector and callers render tri-state.
   */
  ownedProfileActive: boolean | null;
}

export interface Desktop3pRemovalResult {
  ok: boolean;
  changed: boolean;
  kind: "removed" | "noop" | "cleanup_incomplete" | "unsafe" | "write_failed";
  libraryPath: string;
  residualPaths?: string[];
  reason?: string;
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
    // Capability markers like [1m] are not name text: strip the brackets so the label
    // reads "K3 1M", never "K3[1m]".
    .replace(/\[([^\]]+)\]/g, "-$1")
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => {
      const lower = part.toLowerCase();
      if (lower === "gpt" || lower === "glm" || lower === "ai" || lower === "1m") return lower.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function collectDesktop3pModels(
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  profile?: OcxClaudeDesktopProfile,
  nativeContextCap?: NativeContextLimitsInput,
): { models: Desktop3pModelEntry[]; registry: Map<string, string> } {
  const registry = new Map<string, string>();
  const models: Desktop3pModelEntry[] = [];
  const candidates: Desktop3pRoutedModel[] = [
    // Native candidates carry their real context window from the same accessor the
    // Desktop DTO uses, so a native 1M/372k model resolves identically in the written
    // config and on the dashboard.
    ...nativeSlugs.map(id => {
      const contextWindow = nativeOpenAiContextWindow(id, nativeContextCap);
      return { provider: "native", id, ...(contextWindow !== undefined ? { contextWindow } : {}) };
    }),
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
        ...(model.supports1m ? { supports1m: true, prefer1m: true } : {}),
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
    const supports1m = typeof contextWindow === "number" && contextWindow >= DESKTOP_SUPPORTS_1M_THRESHOLD
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
      ...(supports1m.supports1m ? { prefer1m: true as const } : {}),
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
      ...(supports1m.supports1m ? { prefer1m: true as const } : {}),
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
  nativeContextCap?: NativeContextLimitsInput,
): Map<string, string> {
  const { registry } = collectDesktop3pModels(nativeSlugs, routedModels, profile, nativeContextCap);
  desktop3pRegistry = registry;
  return registry;
}

/** Generate Claude Desktop 3P model entries from the proxy's available models. */
export function generateDesktop3pModels(
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  profile?: OcxClaudeDesktopProfile,
  nativeContextCap?: NativeContextLimitsInput,
): Desktop3pModelEntry[] {
  const { models, registry } = collectDesktop3pModels(nativeSlugs, routedModels, profile, nativeContextCap);
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
  nativeContextCap?: NativeContextLimitsInput,
): object {
  const base = {
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: `http://127.0.0.1:${port}`,
    inferenceGatewayApiKey: apiKey,
  };
  if (mode === "discovery") {
    // Build/refresh the decode registry even though no static list is emitted.
    buildDesktop3pRegistry(nativeSlugs, routedModels, profile, nativeContextCap);
    return { ...base, modelDiscoveryEnabled: true };
  }
  return {
    ...base,
    modelDiscoveryEnabled: mode === "hybrid",
    inferenceModels: (() => {
      const models = generateDesktop3pModels(nativeSlugs, routedModels, profile, nativeContextCap);
      // Fail loud at the write boundary rather than ship a config Desktop rejects:
      // the output counterpart of the request-path guards.
      assertDesktop3pModelsValid(models);
      return models;
    })(),
  };
}

function parseMetadata(path: string): Desktop3pMetadata {
  if (!existsSync(path)) return { entries: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Desktop3pMetadata>;
  if (!Array.isArray(parsed.entries)) throw new Error("Claude Desktop 3P _meta.json has no entries array");
  return { ...parsed, entries: parsed.entries };
}

const SAFE_DESKTOP_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOwnedDesktopEntry(entry: Desktop3pMetadataEntry | undefined): boolean {
  return entry?.name === "opencodex" || entry?.name === "opencodex-standard";
}

/** A gateway row is removable; the selected standard row must always remain. */
function isOwnedDesktopGatewayEntry(entry: Desktop3pMetadataEntry | undefined): boolean {
  return entry?.name === "opencodex";
}

function profilePath(libraryPath: string, id: string): string {
  return join(libraryPath, `${id}.json`);
}

/**
 * Read Desktop's selected config without changing its library.
 *
 * This is intentionally separate from the eager writer below: status probes must
 * never manufacture a config-library directory on a machine without Desktop.
 */
export function inspectDesktop3pConfigLibrary(
  options: Desktop3pConfigLibraryOptions & { appliedFingerprint?: string | null } = {},
): Desktop3pLibraryInspection {
  const libraryPath = resolveDesktop3pConfigLibraryPath(options);
  if (!existsSync(libraryPath)) {
    return { kind: "not_installed", libraryPath, selectedProfilePath: null, appliedId: null, residualPaths: [], ownedProfileActive: null };
  }

  const metadataPath = join(libraryPath, "_meta.json");
  if (!existsSync(metadataPath)) {
    return { kind: "no_owned_state", libraryPath, selectedProfilePath: null, appliedId: null, residualPaths: [], ownedProfileActive: null };
  }

  let metadata: Desktop3pMetadata;
  try {
    metadata = parseMetadata(metadataPath);
  } catch {
    return {
      kind: "unsafe", libraryPath, selectedProfilePath: null, appliedId: null, residualPaths: [], reason: "metadata_unreadable", ownedProfileActive: null,
    };
  }
  const appliedId = typeof metadata.appliedId === "string" ? metadata.appliedId : null;
  if (appliedId === null) {
    return { kind: "no_owned_state", libraryPath, selectedProfilePath: null, appliedId: null, residualPaths: [], ownedProfileActive: null };
  }
  const selected = metadata.entries.find(entry => entry?.id === appliedId);
  // A readable appliedId with no owned entry is a KNOWN false, not unknown.
  const ownedProfileActive = isOwnedDesktopEntry(selected);
  if (!SAFE_DESKTOP_PROFILE_ID.test(appliedId)) {
    return {
      kind: "unsafe", libraryPath, selectedProfilePath: null, appliedId, residualPaths: [], reason: "unsafe_applied_id", ownedProfileActive,
    };
  }

  const selectedProfilePath = profilePath(libraryPath, appliedId);
  const residualPaths = metadata.entries
    .filter(entry => isOwnedDesktopGatewayEntry(entry) && entry.id !== appliedId && SAFE_DESKTOP_PROFILE_ID.test(entry.id))
    .flatMap(entry => [profilePath(libraryPath, entry.id), `${profilePath(libraryPath, entry.id)}.bak`])
    .filter(existsSync);
  if (!existsSync(selectedProfilePath)) {
    return { kind: "broken", libraryPath, selectedProfilePath, appliedId, residualPaths, ownedProfileActive };
  }

  let profile: Record<string, unknown>;
  let fingerprint: string;
  try {
    const source = readFileSync(selectedProfilePath, "utf8");
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) return { kind: "broken", libraryPath, selectedProfilePath, appliedId, residualPaths, ownedProfileActive };
    profile = parsed;
    fingerprint = createHash("sha256").update(source).digest("hex").slice(0, 16);
  } catch {
    return { kind: "broken", libraryPath, selectedProfilePath, appliedId, residualPaths, ownedProfileActive };
  }
  if (!isOwnedDesktopEntry(selected)) {
    return { kind: "foreign", libraryPath, selectedProfilePath, appliedId, residualPaths, fingerprint, ownedProfileActive };
  }
  if (profile.inferenceProvider === undefined) {
    return { kind: "standard", libraryPath, selectedProfilePath, appliedId, residualPaths, fingerprint, ownedProfileActive };
  }
  const validGateway = profile.inferenceProvider === "gateway"
    && profile.inferenceCredentialKind === "static"
    && typeof profile.inferenceGatewayBaseUrl === "string"
    && typeof profile.inferenceGatewayApiKey === "string";
  if (!validGateway) {
    return {
      kind: "unsafe", libraryPath, selectedProfilePath, appliedId, residualPaths, fingerprint, reason: "invalid_owned_profile", ownedProfileActive,
    };
  }
  return {
    kind: options.appliedFingerprint && options.appliedFingerprint === fingerprint ? "gateway_ours" : "gateway_drifted",
    libraryPath, selectedProfilePath, appliedId, residualPaths, fingerprint, ownedProfileActive,
  };
}

/**
 * Select a credential-free standard profile before deleting an owned gateway.
 * The old metadata row remains as a retry locator only until both its profile
 * and backup are absent; successful cleanup removes it in the same operation.
 *
 * `gateway_drifted` is still an owned opencodex gateway (name + valid shape); the
 * fingerprint only says on-disk bytes differ from the last saved marker. Refusing
 * OFF for drift left users unable to disable after a lost `appliedFingerprint`
 * (or any other benign mismatch), while the Integrations card still showed the
 * leftover profile as applied/stale.
 */
export function removeDesktop3pStandardPivot(
  options: Desktop3pConfigLibraryOptions & {
    appliedFingerprint?: string | null;
    unlink?: (path: string) => void;
  } = {},
): Desktop3pRemovalResult {
  const inspected = inspectDesktop3pConfigLibrary(options);
  if (inspected.kind === "not_installed" || inspected.kind === "no_owned_state") {
    return { ok: true, changed: false, kind: "noop", libraryPath: inspected.libraryPath };
  }
  if (inspected.kind === "broken" || inspected.kind === "unsafe") {
    return { ok: false, changed: false, kind: "unsafe", libraryPath: inspected.libraryPath, reason: inspected.reason };
  }
  if (!inspected.appliedId || !SAFE_DESKTOP_PROFILE_ID.test(inspected.appliedId)) {
    return { ok: false, changed: false, kind: "unsafe", libraryPath: inspected.libraryPath, reason: "unsafe_applied_id" };
  }

  const metadataPath = join(inspected.libraryPath, "_meta.json");
  try {
    const metadata = parseMetadata(metadataPath);
    const selectedId = inspected.appliedId;
    // When Desktop is actively using our gateway (current or drifted), pivot only
    // that selected row first. Any second owned row is residue for a later
    // standard-mode retry; this preserves the selected-row preference after an
    // interrupted cleanup.
    const selectedOwnedGatewayActive =
      inspected.kind === "gateway_ours" || inspected.kind === "gateway_drifted";
    const targetIds = selectedOwnedGatewayActive
      ? [selectedId]
      : metadata.entries
        .filter(isOwnedDesktopGatewayEntry)
        .map(entry => entry.id)
        .filter(id => SAFE_DESKTOP_PROFILE_ID.test(id));
    if (targetIds.length === 0) return { ok: true, changed: false, kind: "noop", libraryPath: inspected.libraryPath };

    let metadataAfterPivot = metadata;
    if (selectedOwnedGatewayActive) {
      const standardId = randomUUID();
      const standardPath = profilePath(inspected.libraryPath, standardId);
      atomicWriteFile(standardPath, "{}\n");
      const standardEntry: Desktop3pMetadataEntry = { id: standardId, name: "opencodex-standard" };
      metadataAfterPivot = { ...metadata, appliedId: standardId, entries: [...metadata.entries, standardEntry] };
      atomicWriteFile(metadataPath, JSON.stringify(metadataAfterPivot, null, 2) + "\n");
    }

    const residualPaths: string[] = [];
    for (const id of targetIds) {
      for (const candidate of [profilePath(inspected.libraryPath, id), `${profilePath(inspected.libraryPath, id)}.bak`]) {
        try {
          if (existsSync(candidate)) (options.unlink ?? unlinkSync)(candidate);
        } catch {
          // Only the path is allowed to leave this credential-bearing cleanup boundary.
        }
        if (existsSync(candidate)) residualPaths.push(candidate);
      }
    }
    const ownedResiduePaths = metadataAfterPivot.entries
      .filter(entry => isOwnedDesktopGatewayEntry(entry) && !targetIds.includes(entry.id) && SAFE_DESKTOP_PROFILE_ID.test(entry.id))
      .flatMap(entry => [profilePath(inspected.libraryPath, entry.id), `${profilePath(inspected.libraryPath, entry.id)}.bak`])
      .filter(existsSync);
    if (residualPaths.length > 0 || ownedResiduePaths.length > 0) {
      return {
        ok: false, changed: true, kind: "cleanup_incomplete", libraryPath: inspected.libraryPath,
        residualPaths: [...new Set([...residualPaths, ...ownedResiduePaths])],
      };
    }
    // Do not leave a metadata row pointing at a deleted profile. For a foreign
    // selection this only removes proven opencodex residues; appliedId is kept.
    atomicWriteFile(
      metadataPath,
      JSON.stringify({ ...metadataAfterPivot, entries: metadataAfterPivot.entries.filter(entry => !targetIds.includes(entry.id)) }, null, 2) + "\n",
    );
    return { ok: true, changed: true, kind: "removed", libraryPath: inspected.libraryPath };
  } catch {
    return { ok: false, changed: false, kind: "write_failed", libraryPath: inspected.libraryPath };
  }
}

/** Write and apply the opencodex config in Claude Desktop 3P's config library. */
export function writeDesktop3pConfig(
  port: number,
  nativeSlugs: string[],
  routedModels: Array<Desktop3pRoutedModel>,
  apiKey?: string,
  mode: Desktop3pConfigMode = "static",
  profile?: OcxClaudeDesktopProfile,
  nativeContextCap?: NativeContextLimitsInput,
): { written: boolean; path: string; reason?: string; fingerprint?: string } {
  const libraryPath = resolveDesktop3pConfigLibraryPath();
  const metadataPath = join(libraryPath, "_meta.json");
  let configPath = libraryPath;

  try {
    mkdirSync(libraryPath, { recursive: true, mode: 0o700 });
    const metadata = parseMetadata(metadataPath);
    const selected = metadata.entries.find(entry => entry?.id === metadata.appliedId && isOwnedDesktopGatewayEntry(entry));
    const existing = selected ?? metadata.entries.find(entry => isOwnedDesktopGatewayEntry(entry) && typeof entry.id === "string");
    const id = existing?.id ?? randomUUID();
    configPath = join(libraryPath, `${id}.json`);
    const entry: Desktop3pMetadataEntry = existing ? { ...existing, id, name: "opencodex" } : { id, name: "opencodex" };
    const entries = existing
      ? metadata.entries.map(current => current === existing ? entry : current)
      : [...metadata.entries, entry];

    const generated = generateDesktop3pConfig(port, nativeSlugs, routedModels, apiKey, mode, profile, nativeContextCap);
    const preserved = readDesktopProfileForeignKeys(configPath);
    const configJson = JSON.stringify({ ...preserved, ...generated }, null, 2) + "\n";
    const fingerprint = createHash("sha256").update(configJson).digest("hex").slice(0, 16);
    const { backupPath } = atomicReplaceDesktopConfig(configPath, configJson);
    try {
      atomicWriteFile(metadataPath, JSON.stringify({ ...metadata, appliedId: id, entries }, null, 2) + "\n");
    } catch (metaError) {
      // Rollback: restore the backed-up config if metadata write fails.
      if (backupPath && existsSync(backupPath)) copyFileSync(backupPath, configPath);
      throw metaError;
    }
    return { written: true, path: configPath, fingerprint };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { written: false, path: configPath, reason };
  }
}

const OPENCODEX_DESKTOP_PROFILE_KEYS = new Set([
  "inferenceProvider",
  "inferenceCredentialKind",
  "inferenceGatewayBaseUrl",
  "inferenceGatewayApiKey",
  "modelDiscoveryEnabled",
  "inferenceModels",
]);

function readDesktopProfileForeignKeys(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Claude Desktop 3P profile is not a JSON object");
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !OPENCODEX_DESKTOP_PROFILE_KEYS.has(key)),
  );
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

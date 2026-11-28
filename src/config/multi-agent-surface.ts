import type { MultiAgentMode } from "../codex/catalog/parsing";
import type { OcxConfig } from "../types";
import type { MultiAgentModelMode } from "../types/multi-agent";
import { slugEquivalenceKey } from "../providers/slug-codec";

/**
 * Bump to raise the sub-agent surface advisory again for installs that already answered
 * the previous one. A version rather than a boolean, so that the day the upstream
 * encrypted-task limitation is fixed, the notice saying so reaches the same operators
 * without a second config key.
 */
export const MULTI_AGENT_SURFACE_ADVISORY_VERSION = 1;

/** The published explanation both advisory surfaces link to. */
export const SUBAGENT_SURFACE_GUIDE_URL = "https://opencodex.me/guides/subagent-v1-default/";

/**
 * The surface an operator effectively runs. An absent key still means base: the key is
 * deleted when base is selected, so its absence cannot be read as "never configured".
 * What changed in this release is the written default, not this resolution.
 */
export function resolveMultiAgentMode(config: Pick<OcxConfig, "multiAgentMode">): MultiAgentMode {
  return config.multiAgentMode === "v1" || config.multiAgentMode === "v2" || config.multiAgentMode === "v2-plaintext"
    ? config.multiAgentMode
    : "default";
}

/** Entries kept from `multiAgentModeByModel`; more would be a config mistake, not a roster. */
export const MULTI_AGENT_MODE_BY_MODEL_LIMIT = 256;
const MODEL_KEY_MAX = 256;

export function isMultiAgentModelMode(value: unknown): value is MultiAgentModelMode {
  return value === "v1" || value === "v2" || value === "v2-plaintext";
}

/** A catalog slug as a map key: trimmed, bounded, and free of control characters. */
export function isMultiAgentModelKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MODEL_KEY_MAX || value !== value.trim()) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Why a raw `multiAgentModeByModel` value is not usable as written, or null. The load path
 * reports this and keeps the usable entries; the write path refuses the whole candidate.
 */
export function multiAgentModeByModelProblem(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "expected an object mapping model ids to \"v1\", \"v2\" or \"v2-plaintext\"";
  }
  const entries = Object.entries(raw);
  const invalid = entries.filter(([model, mode]) => !isMultiAgentModelKey(model) || !isMultiAgentModelMode(mode)).length;
  if (invalid > 0) return `${invalid} ${invalid === 1 ? "entry is" : "entries are"} not a model id mapped to "v1", "v2" or "v2-plaintext"`;
  if (entries.length > MULTI_AGENT_MODE_BY_MODEL_LIMIT) return `more than ${MULTI_AGENT_MODE_BY_MODEL_LIMIT} entries`;
  return null;
}

/**
 * Why a `multiAgentModeByModel` patch is unusable, or null. A patch names only what changes:
 * null clears every entry, and a null value removes one model, as `modelPinnedEfforts` patches do.
 */
export function multiAgentModeByModelPatchProblem(patch: unknown): string | null {
  if (patch === null) return null;
  if (typeof patch !== "object" || Array.isArray(patch)) return "must be an object or null";
  for (const [model, mode] of Object.entries(patch)) {
    if (!isMultiAgentModelKey(model)) return "keys must be trimmed, non-empty model ids";
    if (mode !== null && !isMultiAgentModelMode(mode)) return "values must be 'v1', 'v2', 'v2-plaintext', or null";
  }
  return null;
}

/** The entries after a validated patch. */
export function mergeMultiAgentModeByModel(
  current: ReadonlyMap<string, MultiAgentModelMode>,
  patch: Record<string, MultiAgentModelMode | null> | null,
): Map<string, MultiAgentModelMode> {
  const next = new Map(patch === null ? [] : current);
  for (const [model, mode] of Object.entries(patch ?? {})) {
    if (mode === null) next.delete(model);
    else next.set(model, mode);
  }
  return next;
}

type ModelModeConfig = Pick<OcxConfig, "multiAgentModeByModel">;

/**
 * The per-model surface entries that are usable as stored (#8953). A hand-edited config can
 * hold anything under this key, and every reader goes through here, so an unusable key or
 * value drops that one entry instead of changing what the other models select.
 */
export function resolveMultiAgentModeByModel(config: ModelModeConfig): ReadonlyMap<string, MultiAgentModelMode> {
  const modes = new Map<string, MultiAgentModelMode>();
  const raw: unknown = config.multiAgentModeByModel;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return modes;
  for (const [model, mode] of Object.entries(raw)) {
    if (modes.size >= MULTI_AGENT_MODE_BY_MODEL_LIMIT) break;
    if (isMultiAgentModelKey(model) && isMultiAgentModelMode(mode)) modes.set(model, mode);
  }
  return modes;
}

/**
 * Find a model's entry by catalog slug. An exact key wins; otherwise a routed slug matches in
 * either its raw or its encoded spelling, the relation catalog and config slugs already share.
 */
export function multiAgentModelModeMatcher(
  modes: ReadonlyMap<string, MultiAgentModelMode>,
): (model: string) => MultiAgentModelMode | undefined {
  if (modes.size === 0) return () => undefined;
  const equivalent = new Map<string, MultiAgentModelMode>();
  for (const [model, mode] of modes) {
    const key = slugEquivalenceKey(model);
    if (!equivalent.has(key)) equivalent.set(key, mode);
  }
  return model => modes.get(model) ?? equivalent.get(slugEquivalenceKey(model));
}

/**
 * Entries that name no row in the given catalog. An entry is keyed by slug, so a misspelt one
 * changes nothing and says nothing; callers report these instead of refusing them, because a
 * model that is only missing for now (a provider not yet discovered) is a legitimate entry.
 */
export function unmatchedMultiAgentModelModes(models: Iterable<string>, catalogSlugs: Iterable<string>): string[] {
  const known = new Set<string>();
  for (const slug of catalogSlugs) { known.add(slug); known.add(slugEquivalenceKey(slug)); }
  return [...models].filter(model => !known.has(model) && !known.has(slugEquivalenceKey(model)));
}

/** The surface one model selects: its own entry, else the global mode. */
export function resolveMultiAgentModeForModel(
  config: Pick<OcxConfig, "multiAgentMode"> & ModelModeConfig,
  model: string | undefined,
): MultiAgentMode {
  return (model === undefined ? undefined : multiAgentModelModeMatcher(resolveMultiAgentModeByModel(config))(model))
    ?? resolveMultiAgentMode(config);
}

/**
 * Whether the stored surface only works with the global `multi_agent_v2` feature off.
 *
 * Codex resolves that feature before a row's `multi_agent_version`, so with it on every root
 * session is v2 whatever the catalog says. Three stored choices rely on a v1 pin or on
 * pin-driven v2 and are defeated by it: mode `"v2-plaintext"`, the `keepNativeChatGptOnV1`
 * hybrid under mode `"v2"`, and any per-model `"v1"` entry.
 */
export function multiAgentPinsRequireGlobalV2Disabled(
  config: Pick<OcxConfig, "multiAgentMode" | "keepNativeChatGptOnV1"> & ModelModeConfig,
): boolean {
  const mode = resolveMultiAgentMode(config);
  return mode === "v2-plaintext"
    || (mode === "v2" && config.keepNativeChatGptOnV1 === true)
    || hasMultiAgentModelMode(config, "v1");
}

/** Whether any model selects the v2 surface through its own entry, whatever the global mode. */
export function multiAgentModelModesSelectV2(config: ModelModeConfig): boolean {
  return hasMultiAgentModelMode(config, "v2") || hasMultiAgentModelMode(config, "v2-plaintext");
}

export function hasMultiAgentModelMode(config: ModelModeConfig, mode: MultiAgentModelMode): boolean {
  for (const value of resolveMultiAgentModeByModel(config).values()) if (value === mode) return true;
  return false;
}

type PlaintextConfig = Pick<OcxConfig, "multiAgentMode" | "plaintextV2AgentMessages"> & ModelModeConfig;

/**
 * Whether v2 collaboration messages can be compiled to plaintext on the canonical
 * ChatGPT forward route. Three independent opt-ins activate it: the standalone
 * experimental `plaintextV2AgentMessages` flag, mode `"v2-plaintext"`, and a per-model
 * `"v2-plaintext"` entry; the last two are themselves the operator's explicit consent.
 * Mode transitions never rewrite the flag, and the flag alone never changes the resolved mode.
 *
 * This is the install-wide answer: it scopes replay and raises the startup warning. Which
 * requests are compiled is {@link isPlaintextV2AgentMessagesEnabledForModel}.
 */
export function isPlaintextV2AgentMessagesEnabled(config: PlaintextConfig): boolean {
  return config.plaintextV2AgentMessages === true
    || resolveMultiAgentMode(config) === "v2-plaintext"
    || hasMultiAgentModelMode(config, "v2-plaintext");
}

/**
 * Whether a request for `model` is compiled. The legacy flag covers every model, as it
 * always has. Otherwise the model's own surface decides, so a model the operator moved to
 * `"v1"` or encrypted `"v2"` is left alone while the global mode is `"v2-plaintext"`, and
 * one model can opt in under any other global mode.
 */
export function isPlaintextV2AgentMessagesEnabledForModel(config: PlaintextConfig, model: string | undefined): boolean {
  return config.plaintextV2AgentMessages === true
    || resolveMultiAgentModeForModel(config, model) === "v2-plaintext";
}

type AdvisoryConfig = Pick<OcxConfig, "multiAgentMode" | "multiAgentSurfaceAdvisoryVersion">;

/**
 * True when this install should be told once that v1 is now the default surface.
 *
 * A v1 install is silent because it has nothing to decide. A fresh install is silent
 * because `getDefaultConfig()` writes the current version alongside the v1 default.
 *
 * A "v2-plaintext" install is silent too: the mode explicitly opts into a different
 * native-to-routed delivery mechanism, and entering it required the
 * dedicated plaintext acknowledgement, so re-raising the generic "v1 recommended" notice
 * would repeat a decision the operator just made. The stored advisory version is left
 * alone, so leaving the mode for base or v2 still raises an unanswered advisory.
 *
 * What is left is the case this exists for: an install that predates the change and is
 * running base or v2, where a ChatGPT-native parent cannot hand a task to a routed child.
 */
export function multiAgentSurfaceAdvisoryRequired(config: AdvisoryConfig): boolean {
  const mode = resolveMultiAgentMode(config);
  if (mode === "v1" || mode === "v2-plaintext") return false;
  return (config.multiAgentSurfaceAdvisoryVersion ?? 0) < MULTI_AGENT_SURFACE_ADVISORY_VERSION;
}

export type MultiAgentSurfaceAdvisory = {
  /** Whether the dashboard should raise the notice. */
  required: boolean;
  /** The surface stored today. */
  mode: MultiAgentMode;
  /** What the notice recommends. */
  recommended: "v1";
  /** The advisory revision a client acknowledges. */
  version: number;
  /** Where the notice sends a reader for the explanation. */
  docsUrl: string;
};

/** Response-only projection; none of this is a writable config field. */
export function multiAgentSurfaceAdvisory(config: AdvisoryConfig): MultiAgentSurfaceAdvisory {
  return {
    required: multiAgentSurfaceAdvisoryRequired(config),
    mode: resolveMultiAgentMode(config),
    recommended: "v1",
    version: MULTI_AGENT_SURFACE_ADVISORY_VERSION,
    docsUrl: SUBAGENT_SURFACE_GUIDE_URL,
  };
}

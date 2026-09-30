// Shared client export contracts.
import { canonicalizeReasoningEfforts } from "../../reasoning-effort";
import type { OcxConfig } from "../../types";
import type { ConfigFormat } from "../../integrations/serialize";

export const DROID_DEFAULT_EFFORT_HEADER = "x-opencodex-droid-default-effort";

/**
 * One entry opencodex owns inside a client's config: the JSON path to it and
 * the value we put there.
 *
 * A path list rather than a single provider key because ownership is not
 * always one entry — Kimi owns its provider block AND one model entry per
 * model, and a writer that only knew about the provider would strand the rest
 * (devlog 260802 006 §2).
 */
export interface ManagedFragment {
  path: readonly string[];
  value: unknown;
}

/** Everything opencodex contributes to one client's config, as one unit. */
export interface ManagedContribution {
  clientId: ExportClientId;
  fragments: readonly ManagedFragment[];
}

export type BuildContribution = (ctx: ExportContext) => ManagedContribution;

export interface OpencodeLaunchEnv {
  [key: string]: string | undefined;
}

/** Visible catalog entry keyed by the proxy's canonical namespaced selector. */
export interface OpencodeCatalogModel {
  namespaced: string;
  /** Hub-resolved Fast availability. Missing metadata means unavailable. */
  fastRowAvailable?: boolean;
  native?: boolean;
  provider?: string;
  id?: string;
  contextWindow?: number;
  maxTokens?: number;
  /**
   * Authoritative input ceiling, distinct from `contextWindow` (GPT-5.6 advertises 922k
   * usable input under a 1.05M window). Carried from the catalog row so a client that has a
   * separate input limit never treats the whole window as prompt budget.
   */
  maxInputTokens?: number;
  displayName?: string;
  /**
   * Declared input modalities, carried verbatim from `/api/models`. Serialized as opencode's
   * per-model `attachment` + `modalities`, because opencode gates attachments CLIENT-side:
   * without them every `opencodex` model is text-only in its picker and an image never
   * reaches the proxy or the vision sidecar (#4286).
   */
  inputModalities?: readonly string[];
  /** Declared effort ladder. Exported as opencode model variants where the client reads them. */
  reasoningEfforts?: readonly string[];
  /**
   * Declared default effort. Carried so every client export reads one deduped, visibility-
   * filtered ladder per model. The opencode serializer deliberately does NOT turn it into a
   * model-level setting — see {@link opencodeEffortVariants} for why.
   */
  defaultReasoningEffort?: string;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsReasoningSummaries?: boolean;
}

/**
 * One proxy-routed model destined for a client config. Deliberately narrower than
 * `CatalogModel` so a serializer cannot reach for a field that does not survive the
 * `/api/models` boundary.
 */
export interface ExportModel {
  /** Canonical proxy selector: `provider/id`, or bare slug for native. */
  namespaced: string;
  /** Hub-resolved Fast availability; exporters never infer it from local config. */
  fastRowAvailable?: boolean;
  provider: string;
  id: string;
  /** Native OpenAI entry. Read by the shared label rule. */
  native?: boolean;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Authoritative input ceiling; optional and never guessed from the context window. */
  maxInputTokens?: number;
  inputModalities?: string[];
  /** Optional effort ladder exported only to clients that support it. */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsReasoningSummaries?: boolean;
}

/**
 * Effective, override-applied export metadata for one model row: what a client export should
 * serialize, as distinct from the raw editor representation `/api/models` also carries.
 *
 * Custom rows are the reason this exists. Their row fields are the operator's stored
 * OVERRIDES (an absent field means "not overridden", an empty ladder means "no rungs"), so a
 * serializer reading only them drops every capability the model inherits from the provider,
 * the registry, or the gathered catalog. The management row list resolves that projection
 * from the same canonical sources routed rows use and attaches it additively — the raw
 * override fields stay exactly what the editor wrote.
 */
export interface EffectiveModelExportMetadata {
  contextWindow?: number;
  /** Input ceiling; distinct from `contextWindow`, carried only when a source asserts one. */
  maxInputTokens?: number;
  /** Output ceiling (a catalog row's `maxOutputTokens`). */
  maxTokens?: number;
  inputModalities?: string[];
  /** Effective ladder; `[]` is an explicit "no rungs" declaration and survives as `[]`. */
  reasoningEfforts?: string[];
  /**
   * A default some canonical source declared — never one synthesized from the ladder's
   * preference order, and only when it is a member of the effective ladder. An empty
   * ladder suppresses it entirely: there is no rung to default to.
   */
  defaultReasoningEffort?: string;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsReasoningSummaries?: boolean;
}

/**
 * The per-row evidence the capability booleans are derived from. Only positive, canonical
 * signals — no independent provider fact tables, no name-based inference.
 */
export interface ExportCapabilityEvidence {
  native?: boolean;
  reasoningEfforts?: readonly string[];
  supportsReasoningSummaries?: boolean;
  /** Normalized upstream capability names a catalog row carried (e.g. `"tools"`). */
  capabilities?: readonly string[];
  /** Provider-level parallel tool call opt-in for this model. */
  parallelToolCalls?: boolean;
}

/**
 * Tool support a canonical source positively asserts, or undefined when nothing is known.
 *
 * Mirrors the routing reader (`src/routing/capability.ts`): a catalog row without `"tools"`
 * is UNKNOWN, never a negative — the row may simply not enumerate capabilities. `native`
 * rows and the parallel-call opt-in are positive evidence on their own.
 */
export function knownToolsSupport(evidence: ExportCapabilityEvidence): boolean | undefined {
  if (evidence.native === true) return true;
  if (evidence.capabilities?.includes("tools") === true) return true;
  if (evidence.parallelToolCalls === true) return true;
  return undefined;
}

/**
 * Reasoning support a canonical source positively asserts, or undefined when nothing is
 * known.
 *
 * Never `false` from a missing or empty effort ladder: an empty ladder says "no ADJUSTABLE
 * effort", which is not the claim "cannot reason" — a model can reason at a fixed depth with
 * no rung to select. Known evidence is a positive reasoning rung (the catalog's own statement
 * that the model accepts reasoning parameters) or delivered reasoning summaries. `none` is
 * the off sentinel, not a rung: a ladder of only `none` offers an off variant and asserts
 * nothing about whether the model reasons, so it is not positive evidence on its own.
 */
export function knownReasoningSupport(evidence: ExportCapabilityEvidence): boolean | undefined {
  if (evidence.supportsReasoningSummaries === true) return true;
  if (evidence.reasoningEfforts !== undefined
    && canonicalizeReasoningEfforts(evidence.reasoningEfforts).some(effort => effort !== "none")) {
    return true;
  }
  return undefined;
}

export interface ExportContext {
  /** `http://host:port/v1` — the OpenAI-compatible surface the client dials. */
  baseUrl: string;
  models: readonly ExportModel[];
  /**
   * Live proxy config. Only the OpenCode path reads it: a non-loopback bind moves
   * admission from `apiKey` to the `x-opencodex-api-key` header.
   */
  config?: OcxConfig;
  droidReasoningDefaults?: DroidReasoningDefaults;
  /**
   * The parsed target document, when the caller has one in hand.
   *
   * A client whose reader picks between two roots needs the bytes on disk to
   * choose: Command Code resolves `document.provider ?? document.providers`, so
   * writing the singular root into a document that already carries the plural one
   * leaves the user's providers unreadable rather than merging with them. Absent
   * for `ocx export`, which has no target file — the builder then writes its
   * default root, exactly as before.
   */
  document?: unknown;
}

/** Namespaced model selector to one of that model's declared reasoning efforts. */
export type DroidReasoningDefaults = Record<string, string>;

export type ExportClientId =
  | "opencode"
  | "pi"
  | "omp"
  | "hermes"
  | "openclaw"
  | "kimi"
  | "gajae"
  | "dsh"
  | "mcode"
  | "zcode"
  | "prime"
  | "aside"
  | "raycast"
  | "omo"
  | "cline"
  | "commandcode"
  | "kilo"
  | "droid";

export interface ExportClientSpec {
  id: ExportClientId;
  /** Download filename; matches the destination file's own name (003 §5). */
  filename: string;
  /** Canonical destination for humans. Never written to. */
  destination: (env: NodeJS.ProcessEnv) => string;
  /** Env var the config references; the value is never serialized. */
  apiKeyEnv: string;
  /** Shell line the user runs before launching the client. */
  exportHint: string;
  build: (ctx: ExportContext) => unknown;
  /**
   * Text format of the client's config file. `filename` already carries the
   * extension; this drives serialization and the download media type so no
   * consumer has to infer either from the name.
   */
  format: ConfigFormat;
  /**
   * Count models in THIS client's document shape. Required so a new client
   * cannot be added without teaching the summarizer about it — the old
   * "anything that is not OpenCode must be Pi" branch was a latent bug.
   */
  summarize: (document: unknown) => { modelCount: number; modelsWithoutLimits: number };
  /**
   * The fragments opencodex owns inside this client's config. Only the builder
   * knows where a client keeps our entries, so ownership paths originate here
   * rather than being re-derived by the writer.
   */
  buildContribution: BuildContribution;
  /**
   * True when the generated integration deliberately supports loopback only.
   *
   * `/v1/chat/completions` rejects bearer credentials and requires the
   * dedicated `x-opencodex-api-key` header (AUTH_MATRIX in
   * src/server/auth-cors.ts). If this exporter cannot safely emit that header,
   * it refuses a remote bind rather than generating a config that 401s. Same
   * reasoning as the Grok managed block's non-loopback refusal.
   */
  loopbackOnly: boolean;
  /**
   * True when the destination file may carry comments and trailing commas
   * even though `format` is "json" and serialization stays pretty JSON.
   *
   * Parse tolerates them by canonicalizing the text before the rewrite-safety
   * scan (Kilo's kilo.jsonc). A spec flag rather than a client-name branch:
   * the next OpenCode-family client opts in here instead of growing another
   * `clientId ===` check at every parse site.
   */
  jsonc?: boolean;
}

export interface PiModelEntry {
  id: string;
  name: string;
  input: string[];
  contextWindow?: number;
  maxTokens?: number;
  /** Advertised when the catalog row carries a non-empty effort ladder. */
  reasoning?: true;
  /**
   * Constrains pi's own level scale (minimal..max) to the declared ladder: members map to
   * themselves, everything else is hidden (`null`). Without it pi would offer levels the
   * ladder does not contain — harmless for provider-config ladders (the proxy clamps those
   * at the wire) but a real 400 risk for custom-row ladders, which are advertisement-only.
   */
  thinkingLevelMap?: Record<string, string | null>;
}

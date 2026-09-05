// Shared client export contracts.
import type { OcxConfig } from "../../types";
import type { ConfigFormat } from "../../integrations/serialize";

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
  displayName?: string;
  /** Declared effort ladder. Exported as opencode model variants where the client reads them. */
  reasoningEfforts?: readonly string[];
  /**
   * Declared default effort. Carried so every client export reads one deduped, visibility-
   * filtered ladder per model. The opencode serializer deliberately does NOT turn it into a
   * model-level setting — see {@link opencodeEffortVariants} for why.
   */
  defaultReasoningEffort?: string;
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
  inputModalities?: string[];
  /** Optional effort ladder exported only to clients that support it. */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
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
}

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
  | "aside";

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

/**
 * Client-neutral config export core.
 *
 * One pure function per client, one shared input type. Every export surface (CLI,
 * management API, GUI) consumes this module so the bytes a user copies, downloads, or
 * curls can never drift between surfaces.
 *
 * Two invariants carried over from `ocx opencode` (src/cli/opencode.ts), which owned the
 * OpenCode serializer before it moved here:
 *
 * - **No secret is ever serialized.** Configs carry only the client's documented env
 *   reference (`{env:VAR}` for OpenCode, `$VAR` for Pi); the real admission key travels
 *   through the environment. AGENTS.md treats token serialization as a release blocker.
 * - **No metadata is guessed.** A model with no authoritative context window ships
 *   without context/output fields, and the client applies its own defaults. Pi's `cost`
 *   is omitted entirely rather than zero-filled, because zeros would assert "free",
 *   which is false for routed providers.
 *
 * This module never writes a file. `destination` names the canonical path for a human;
 * targeting it is the caller's explicit act.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { shouldInjectApiAuthHeader } from "../codex/inject";
import { probeHostname } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";

export interface OpencodeLaunchEnv {
  [key: string]: string | undefined;
}

/** Visible catalog entry keyed by the proxy's canonical namespaced selector. */
export interface OpencodeCatalogModel {
  namespaced: string;
  native?: boolean;
  provider?: string;
  id?: string;
  contextWindow?: number;
  displayName?: string;
}

export interface OpencodeModelEntry {
  name: string;
  limit?: { context: number; output: number };
}

export interface OpencodeProviderBlock {
  npm: string;
  name: string;
  options: {
    baseURL: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
  models: Record<string, OpencodeModelEntry>;
}

export interface OpencodeGeneratedConfig {
  $schema: string;
  provider: Record<string, OpencodeProviderBlock>;
}

/** Provider key owned by this project; the only key any exporter ever emits. */
export const OPENCODE_PROVIDER_ID = "opencodex";

export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

/**
 * The proxy speaks the OpenAI-compatible shape at /v1, which opencode reaches through
 * the AI SDK's openai-compatible package (the same wiring users hand-write today).
 */
const OPENCODE_PROVIDER_NPM = "@ai-sdk/openai-compatible";

/**
 * Env var carrying the proxy admission key to opencode. The config only ever holds the
 * `{env:...}` reference, so the secret never lands on disk. opencode substitutes it at
 * load time.
 */
export const OPENCODE_API_KEY_ENV = "OPENCODEX_OPENCODE_API_KEY";

/** Env reference shared by apiKey and the dedicated proxy admission header. */
export const OPENCODE_API_KEY_ENV_REF = `{env:${OPENCODE_API_KEY_ENV}}`;

/** Env var Pi interpolates. Pi takes bare `$NAME`, not opencode's `{env:NAME}`. */
export const PI_API_KEY_ENV = "OPENCODEX_API_KEY";

/** Pi's reference form for the admission key. Never the value. */
export const PI_API_KEY_ENV_REF = `$${PI_API_KEY_ENV}`;

/** Pi's wire-dialect selector for an OpenAI-compatible endpoint. */
const PI_API_DIALECT = "openai-completions";

/**
 * opencode's config schema rejects a `limit` block that carries `context` without
 * `output`, but CatalogModel has no authoritative per-model output field. Dropping
 * `limit` entirely would also throw away the authoritative context window we DO have,
 * so the block is emitted with this budget standing in for the missing half.
 *
 * The value matches REASONING_MAX_TOKENS_CEILING in src/adapters/anthropic.ts — the
 * project's existing "safe ceiling across current models" figure. It is a ceiling for
 * schema validity, NOT a claim about any specific model's true maximum, and it is
 * clamped to the context window so a small-context model can never be emitted with
 * output > context. Pi's `maxTokens` uses the same stand-in and the same clamp.
 */
export const SCHEMA_REQUIRED_OUTPUT_BUDGET = 32_000;

/** Deterministic loopback default for exported provider-block helpers in tests. */
export const OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

/**
 * Resolve the user's global opencode config path. opencode uses the XDG layout on every
 * platform (including Windows, where it is %USERPROFILE%\.config\opencode).
 */
export function opencodeGlobalConfigPath(
  env: OpencodeLaunchEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(xdg, "opencode", "opencode.json");
}

/** Compose the OpenAI-compatible proxy base URL from a live probe result. */
export function opencodeProxyBaseUrl(port: number, hostname?: string): string {
  return `http://${probeHostname(hostname)}:${port}/v1`;
}

/**
 * One proxy-routed model destined for a client config. Deliberately narrower than
 * `CatalogModel` so a serializer cannot reach for a field that does not survive the
 * `/api/models` boundary.
 */
export interface ExportModel {
  /** Canonical proxy selector: `provider/id`, or bare slug for native. */
  namespaced: string;
  provider: string;
  id: string;
  /** Native OpenAI entry. Read by the shared label rule. */
  native?: boolean;
  displayName?: string;
  contextWindow?: number;
  inputModalities?: string[];
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

export type ExportClientId = "opencode" | "pi";

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
}

/**
 * Authoritative context window, or undefined. Never guesses: a missing, non-finite, or
 * non-positive value means the serializer omits every context-derived field.
 */
function authoritativeContextWindow(contextWindow: number | undefined): number | undefined {
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.floor(contextWindow);
  }
  return undefined;
}

/** Schema-required output budget for a known context window. */
function outputBudgetFor(context: number): number {
  return Math.min(SCHEMA_REQUIRED_OUTPUT_BUDGET, context);
}

/**
 * Label shared by every client: `"<displayName|id> (<native|provider|routed>)"`. The
 * provider suffix is what makes two same-named models from different upstreams
 * distinguishable in a client's model picker.
 */
function exportModelLabel(model: OpencodeCatalogModel): string {
  const providerLabel = model.native ? "native" : (model.provider ?? "routed");
  const id = model.id ?? model.namespaced;
  if (model.displayName && model.displayName.length > 0) {
    return `${model.displayName} (${providerLabel})`;
  }
  return `${id} (${providerLabel})`;
}

function opencodeProviderOptions(baseURL: string, config: OcxConfig): OpencodeProviderBlock["options"] {
  const options: OpencodeProviderBlock["options"] = { baseURL };
  // Non-loopback binds accept proxy admission only via x-opencodex-api-key so Authorization
  // stays free for Codex Direct upstream credentials when applicable.
  if (shouldInjectApiAuthHeader(config)) {
    options.headers = { "x-opencodex-api-key": OPENCODE_API_KEY_ENV_REF };
    return options;
  }
  options.apiKey = OPENCODE_API_KEY_ENV_REF;
  return options;
}

/**
 * `opencodex` provider block for a resolved base URL.
 *
 * `limit.context` is emitted ONLY from an authoritative context window — never guessed.
 * When none is available the whole `limit` block is dropped and opencode keeps its own
 * defaults; when one is present, `limit.output` rides along (opencode's schema requires
 * the pair) clamped to the context window.
 */
function opencodeProviderBlock(
  baseURL: string,
  catalogModels: readonly OpencodeCatalogModel[],
  config: OcxConfig,
): OpencodeProviderBlock {
  const models: Record<string, OpencodeModelEntry> = {};
  for (const model of catalogModels) {
    const key = model.namespaced;
    if (models[key]) continue; // first entry wins; native rows lead /api/models
    const entry: OpencodeModelEntry = { name: exportModelLabel(model) };
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.limit = { context, output: outputBudgetFor(context) };
    }
    models[key] = entry;
  }
  return {
    npm: OPENCODE_PROVIDER_NPM,
    name: "OpenCodex",
    options: opencodeProviderOptions(baseURL, config),
    models,
  };
}

/**
 * Build the `opencodex` provider block from proxy catalog rows keyed by each row's
 * canonical `namespaced` selector. Used by the `ocx opencode` launcher, which injects
 * the block through OpenCode's inline runtime layer rather than any file.
 */
export function buildOpencodeProviderBlockFromCatalog(
  port: number,
  catalogModels: readonly OpencodeCatalogModel[],
  hostname?: string,
  config: OcxConfig = OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG,
): OpencodeProviderBlock {
  return opencodeProviderBlock(opencodeProxyBaseUrl(port, hostname), catalogModels, config);
}

/**
 * Shared precondition for every serializer: drop duplicate `namespaced` (first wins,
 * native rows lead `/api/models`) and sort by `namespaced` so two calls with the same
 * models produce identical bytes. Stability matters because the GUI shows a diffable
 * preview and agents may checksum the payload.
 */
export function normalizeExportModels(models: readonly ExportModel[]): ExportModel[] {
  const seen = new Set<string>();
  const unique: ExportModel[] = [];
  for (const model of models) {
    if (seen.has(model.namespaced)) continue;
    seen.add(model.namespaced);
    unique.push(model);
  }
  return unique.sort((a, b) => (a.namespaced < b.namespaced ? -1 : a.namespaced > b.namespaced ? 1 : 0));
}

/** OpenCode V1 document: our provider block plus `$schema`, and nothing else. */
function buildOpencodeClientConfig(ctx: ExportContext): OpencodeGeneratedConfig {
  const block = opencodeProviderBlock(
    ctx.baseUrl,
    normalizeExportModels(ctx.models),
    ctx.config ?? OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG,
  );
  return { $schema: OPENCODE_CONFIG_SCHEMA, provider: { [OPENCODE_PROVIDER_ID]: block } };
}

export interface PiModelEntry {
  id: string;
  name: string;
  input: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface PiProviderBlock {
  baseUrl: string;
  api: string;
  apiKey: string;
  models: PiModelEntry[];
}

export interface PiGeneratedConfig {
  providers: Record<string, PiProviderBlock>;
}

/**
 * Pi's `~/.pi/agent/models.json` shape. `models` is an ARRAY (identity lives in `id`),
 * unlike OpenCode's keyed object.
 *
 * Two fields are deliberately absent. `cost` requires all four price fields and we have
 * no price data at all, so emitting zeros would assert every routed model is free.
 * `reasoning` is a boolean in Pi while our catalog carries an effort list — mapping one
 * to the other would be a guess.
 *
 * Pi's schema is UNVERIFIED against a real installation (001 §2); this contract is ours,
 * not a claim about Pi's acceptance.
 */
function buildPiClientConfig(ctx: ExportContext): PiGeneratedConfig {
  const models: PiModelEntry[] = normalizeExportModels(ctx.models).map(model => {
    const entry: PiModelEntry = {
      id: model.namespaced,
      name: exportModelLabel(model),
      // Text is the one modality every routed model supports; anything richer must come
      // from the catalog rather than an assumption.
      input: model.inputModalities && model.inputModalities.length > 0 ? [...model.inputModalities] : ["text"],
    };
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.contextWindow = context;
      entry.maxTokens = outputBudgetFor(context);
    }
    return entry;
  });
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        baseUrl: ctx.baseUrl,
        api: PI_API_DIALECT,
        apiKey: PI_API_KEY_ENV_REF,
        models,
      },
    },
  };
}

export const EXPORT_CLIENTS: Record<ExportClientId, ExportClientSpec> = {
  opencode: {
    id: "opencode",
    filename: "opencode.json",
    destination: env => opencodeGlobalConfigPath(env),
    apiKeyEnv: OPENCODE_API_KEY_ENV,
    exportHint: `export ${OPENCODE_API_KEY_ENV}=<your key>`,
    build: buildOpencodeClientConfig,
  },
  pi: {
    id: "pi",
    filename: "pi-models.json",
    destination: () => join(homedir(), ".pi", "agent", "models.json"),
    apiKeyEnv: PI_API_KEY_ENV,
    exportHint: `export ${PI_API_KEY_ENV}=<your key>`,
    build: buildPiClientConfig,
  },
};

export const EXPORT_CLIENT_IDS: readonly ExportClientId[] = Object.keys(EXPORT_CLIENTS) as ExportClientId[];

export function isExportClientId(value: string): value is ExportClientId {
  return Object.prototype.hasOwnProperty.call(EXPORT_CLIENTS, value);
}

/** Single entry point every export surface calls. */
export function buildClientConfig(client: ExportClientId, ctx: ExportContext): unknown {
  return EXPORT_CLIENTS[client].build(ctx);
}

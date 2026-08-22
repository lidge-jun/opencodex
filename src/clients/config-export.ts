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
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { shouldInjectApiAuthHeader } from "../codex/inject";
import { FORMAT_MEDIA_TYPE, serializeDocument, type ConfigFormat } from "../integrations/serialize";
import { providerCodexAccountMode } from "../providers/registry";
import { sanitizeCodexReasoningEfforts } from "../reasoning-effort";
import { probeHostname } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";

export type { ConfigFormat };

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

/**
 * Hermes interpolates `${VAR}` anywhere in config.yaml, so the credential stays
 * in the environment exactly as it does for OpenCode.
 */
export const HERMES_API_KEY_ENV = "OPENCODEX_HERMES_API_KEY";
export const HERMES_API_KEY_ENV_REF = `\${${HERMES_API_KEY_ENV}}`;

/** OpenClaw interpolates `${UPPERCASE_VAR}` and fails closed when it is unset. */
export const OPENCLAW_API_KEY_ENV = "OPENCODEX_OPENCLAW_API_KEY";
export const OPENCLAW_API_KEY_ENV_REF = `\${${OPENCLAW_API_KEY_ENV}}`;

/**
 * Placeholder credential for loopback-only clients (Kimi, Pi). A loopback
 * bind needs no real admission key, so we emit the same placeholder the Grok
 * managed block uses rather than a user secret. Pi resolves `apiKey` before
 * building its model list and hides the provider when an env reference is unset.
 */
export const LOOPBACK_API_KEY_PLACEHOLDER = "opencodex-loopback";

/**
 * Gajae's `apiKeyEnv` is env-name-only and fail-closed. Its sibling `apiKey`
 * falls back to treating the literal text as the token when the variable is
 * unset, which would silently ship a bogus credential — so we never emit it.
 */
export const GAJAE_API_KEY_ENV = "OPENCODEX_GAJAE_API_KEY";

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

const OMP_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OMP_WINDOWS_RESERVED_PROFILE_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

function ompProfileName(env: OpencodeLaunchEnv): string | undefined {
  // OMP_PROFILE wins by presence, even when explicitly empty; PI_PROFILE is
  // only the legacy fallback when the canonical variable is undefined.
  const raw = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const profile = raw?.trim();
  if (!profile || profile === "default") return undefined;
  if (
    profile === "."
    || profile === ".."
    || profile.endsWith(".")
    || !OMP_PROFILE_NAME_RE.test(profile)
    || OMP_WINDOWS_RESERVED_PROFILE_RE.test(profile)
  ) {
    throw new ClientPathError(`Invalid OMP profile "${raw}"`);
  }
  return profile;
}

/**
 * Pi resolves its agent directory from `PI_CODING_AGENT_DIR`, falling back to
 * `~/.pi/agent`. `ompAgentDir` below already reads that variable — OMP is a Pi
 * derivative — so Pi's own resolver honoring it is what makes the two agree
 * rather than a new claim about Pi's contract.
 *
 * A relative override is refused for the same reason MCode's and ZCode's are: a
 * background proxy and a foreground client can have different working
 * directories, and would otherwise disagree about which file is named.
 */
export function piAgentDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  if (override) return absoluteClientPath(override, home, "PI_CODING_AGENT_DIR");
  return join(home, ".pi", "agent");
}

/** Pi's canonical custom-provider catalog. */
export function piConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(piAgentDir(env, home), "models.json");
}

/** Resolve the global Oh My Pi agent directory using OMP's own env precedence. */
export function ompAgentDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const profile = ompProfileName(env);
  if (!profile) {
    const override = env.PI_CODING_AGENT_DIR?.trim();
    if (override) return absoluteClientPath(override, home, "PI_CODING_AGENT_DIR");
  }
  // OMP treats PI_CONFIG_DIR as a directory name relative to the user's home,
  // even when the value starts with `/` or `~`. Mirror that path.join contract
  // exactly instead of assigning those values different filesystem semantics.
  const root = join(home, env.PI_CONFIG_DIR || ".omp");
  return profile ? join(root, "profiles", profile, "agent") : join(root, "agent");
}

/** OMP's canonical custom-provider catalog. */
export function ompModelsConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const agentDir = ompAgentDir(env, home);
  const yamlFallback = join(agentDir, "models.yaml");
  const canonical = join(agentDir, "models.yml");
  return !existsSync(canonical) && existsSync(yamlFallback) ? yamlFallback : canonical;
}

/** Compose the OpenAI-compatible proxy base URL from a live probe result. */
export function opencodeProxyBaseUrl(port: number, hostname?: string): string {
  return `http://${probeHostname(hostname)}:${port}/v1`;
}

/**
 * Hermes resolves its home the way cc-switch's writer does: an explicit
 * `HERMES_HOME`, then Windows `%LOCALAPPDATA%\hermes`, then `~/.hermes`.
 */
export function hermesHomeDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const override = env.HERMES_HOME?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    return join(local && local.length > 0 ? local : join(home, "AppData", "Local"), "hermes");
  }
  return join(home, ".hermes");
}

export function hermesConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(hermesHomeDir(env, home), "config.yaml");
}

/**
 * Expand `~` against the effective home; REFUSE anything still relative.
 *
 * A first attempt at this called `resolve()` and claimed the path would "mean
 * the same thing next time". It does not: `resolve()` only anchors the current
 * invocation, so applying from one directory and disabling from another still
 * resolved two different files — the second reported "not applied" and left
 * the managed block behind with nothing claiming it.
 *
 * There is no honest way to recover the other process's cwd, so a relative
 * selector is refused at the boundary instead of being silently anchored to
 * whichever directory we happened to start in. A `~` path IS stable, because
 * it anchors to the effective home rather than the cwd.
 */
export class ClientPathError extends Error {}

function absoluteClientPath(raw: string, home: string, variable: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(home, trimmed.slice(2));
  if (!isAbsolute(trimmed)) {
    throw new ClientPathError(
      `${variable} must be an absolute path or start with ~; "${trimmed}" depends on the working directory, `
      + "so opencodex and the client would disagree about which file it names.",
    );
  }
  return trimmed;
}

/**
 * OpenClaw's EFFECTIVE home: `OPENCLAW_HOME` outranks the OS home.
 *
 * Everything below derives from this, which is why it is separate: a profile
 * directory and the default state directory both hang off the effective home,
 * not off `homedir()`.
 */
function openclawEffectiveHome(env: OpencodeLaunchEnv, home: string): string {
  const override = env.OPENCLAW_HOME?.trim();
  return override ? absoluteClientPath(override, home, "OPENCLAW_HOME") : home;
}

/**
 * OpenClaw's state directory, in the gateway's own precedence order:
 *
 * 1. `OPENCLAW_STATE_DIR` — an explicit relocation wins outright.
 * 2. `OPENCLAW_PROFILE` — a named profile is `.openclaw-<profile>` under the
 *    effective home. `default` is the unnamed profile, so it stays
 *    `.openclaw`.
 * 3. `.openclaw` under the effective home (`OPENCLAW_HOME` or the OS home).
 *
 * This is also what "is it installed?" detection looks at, so it has to follow
 * the same selectors the gateway does — otherwise an operator running a
 * profile reads as not installed while their gateway runs fine. We honor the
 * ENVIRONMENT selectors only: a `--profile` flag passed to some other process
 * is not something we can observe, and guessing it would be worse than
 * following the same environment the user gave us.
 */
export function openclawHomeDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  const effectiveHome = openclawEffectiveHome(env, home);
  if (stateDir) return absoluteClientPath(stateDir, effectiveHome, "OPENCLAW_STATE_DIR");
  const profile = env.OPENCLAW_PROFILE?.trim();
  // OpenClaw compares the profile name case-insensitively, so `DEFAULT` is
  // still the unnamed profile rather than a `.openclaw-DEFAULT` directory.
  if (profile && profile.toLowerCase() !== "default") return join(effectiveHome, `.openclaw-${profile}`);
  /*
   * `.clawdbot` is not migration debris — OpenClaw still treats it as an
   * active runtime candidate, preferring the modern directory when it exists
   * and otherwise selecting the legacy one. Mirroring that order is not
   * guessing: an install that has not migrated is one this integration would
   * otherwise report as "not installed" while its gateway runs fine.
   */
  const modern = join(effectiveHome, ".openclaw");
  if (existsSync(modern)) return modern;
  const legacy = join(effectiveHome, ".clawdbot");
  if (existsSync(legacy)) return legacy;
  return modern;
}

/**
 * The config file OpenClaw actually reads.
 *
 * An explicit `OPENCLAW_CONFIG_PATH` wins outright — it is a file selector, so
 * it does NOT relocate the state directory that detection looks at. Otherwise
 * `openclaw.json` under the resolved state directory.
 *
 * Ignoring these selectors meant the toggle could report success after writing
 * `~/.openclaw/openclaw.json` while the running gateway read somewhere else —
 * and snapshot the wrong file, so the rollback promise pointed at a file
 * nobody loads.
 */
export function openclawConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return absoluteClientPath(explicit, openclawEffectiveHome(env, home), "OPENCLAW_CONFIG_PATH");
  /*
   * OpenClaw searches FILE candidates, not directories: a `.openclaw`
   * directory that exists but holds no config does not beat an actual
   * `.clawdbot/clawdbot.json`. Checking the directory first picked an
   * absent modern file over a real legacy one and wrote where nothing reads.
   *
   * An explicit state dir still scopes the search to that directory, because
   * the operator named it.
   */
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  const effectiveHome = openclawEffectiveHome(env, home);
  const profile = env.OPENCLAW_PROFILE?.trim();
  const scoped = stateOverride !== undefined && stateOverride !== ""
    || (profile !== undefined && profile !== "" && profile.toLowerCase() !== "default");
  const stateDir = openclawHomeDir(env, home);
  const candidates = scoped
    ? [join(stateDir, "openclaw.json"), join(stateDir, "clawdbot.json")]
    : [
      join(effectiveHome, ".openclaw", "openclaw.json"),
      join(effectiveHome, ".openclaw", "clawdbot.json"),
      join(effectiveHome, ".clawdbot", "openclaw.json"),
      join(effectiveHome, ".clawdbot", "clawdbot.json"),
    ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

export function kimiHomeDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const override = env.KIMI_CODE_HOME?.trim();
  return override && override.length > 0 ? override : join(home, ".kimi-code");
}

export function kimiConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(kimiHomeDir(env, home), "config.toml");
}

export function gajaeHomeDir(_env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(home, ".gjc");
}

export function gajaeConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(gajaeHomeDir(env, home), "agent", "models.yml");
}

/** DSH_HOME uses the raw nonblank value; trimming it would name a different path. */
export function dshHomeDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME;
  if (raw === undefined || raw.trim().length === 0) return join(home, ".dsh");
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(home, raw.slice(2));
  if (!isAbsolute(raw)) {
    throw new ClientPathError(
      `DSH_HOME must be an absolute path or start with ~; "${raw}" depends on the working directory, `
      + "so opencodex and DSH would disagree about which settings file it names.",
    );
  }
  // DSH calls node:path.resolve after tilde expansion. Preserve the raw value
  // for the decision above, then normalize the absolute spelling the same way
  // so both processes bind ownership and locks to one path string.
  return resolve(raw);
}

export function dshConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(dshHomeDir(env, home), "settings.yaml");
}

/**
 * MiniMax Code stores runtime state under `MINIMAX_DATA_DIR`, then the legacy
 * `MAVIS_DATA_DIR`, and finally `~/.minimax`. Relative overrides are refused
 * because a background proxy and a foreground client can have different CWDs.
 */
export function mcodeHomeDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const primary = env.MINIMAX_DATA_DIR?.trim();
  if (primary) return absoluteClientPath(primary, home, "MINIMAX_DATA_DIR");
  const legacy = env.MAVIS_DATA_DIR?.trim();
  if (legacy) return absoluteClientPath(legacy, home, "MAVIS_DATA_DIR");
  return join(home, ".minimax");
}

export function mcodeConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(mcodeHomeDir(env, home), "config.yaml");
}

/**
 * ZCode (Z.ai's desktop client) keeps everything under `~/.zcode`; custom
 * providers live in `v2/config.json`. `ZCODE_DATA_DIR` mirrors the other
 * clients' override convention; relative overrides are refused for the same
 * reason as MCode's.
 */
export function zcodeHomeDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const override = env.ZCODE_DATA_DIR?.trim();
  if (override) return absoluteClientPath(override, home, "ZCODE_DATA_DIR");
  return join(home, ".zcode");
}

export function zcodeConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(zcodeHomeDir(env, home), "v2", "config.json");
}

/**
 * Prime Agent resolves its agent directory from `PRIME_AGENT_CODING_AGENT_DIR`
 * — the brand-derived spelling of the `PI_CODING_AGENT_DIR` that `ompAgentDir`
 * already honors, because the agent builds that variable name from its own
 * `piConfig.name` — and otherwise falls back to `~/.prime/agent`. Relative
 * overrides are refused for the same reason as MCode's and ZCode's: a
 * background proxy and a foreground client can have different working
 * directories.
 */
export function primeAgentDir(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const override = env.PRIME_AGENT_CODING_AGENT_DIR?.trim();
  if (override) return absoluteClientPath(override, home, "PRIME_AGENT_CODING_AGENT_DIR");
  return join(home, ".prime", "agent");
}

/** Prime Agent's canonical custom-provider catalog. */
export function primeConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(primeAgentDir(env, home), "models.json");
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
  | "prime";

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

/**
 * Authoritative context window, or undefined. Never guesses: a missing, non-finite, or
 * non-positive value means the serializer omits every context-derived field.
 */
function authoritativeContextWindow(contextWindow: number | undefined): number | undefined {
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    const integer = Math.floor(contextWindow);
    return integer > 0 ? integer : undefined;
  }
  return undefined;
}

/** Schema-required output budget for a known context window. */
function outputBudgetFor(context: number): number {
  return Math.min(SCHEMA_REQUIRED_OUTPUT_BUDGET, context);
}

/**
 * Modalities a given client's schema will actually accept.
 *
 * Our internal vocabulary is `text | image | audio` (ALLOWED_INPUT_MODALITIES in
 * src/server/management/model-routes.ts). Pi and Gajae accept only
 * `text | image`, and both reject the WHOLE config file over one out-of-enum
 * value — Gajae reports `/providers/opencodex/models/N/input/2: Invalid option`
 * and falls back to its built-in list, Pi returns an empty model config. So a
 * single `audio` model takes every routed model down with it. That is not
 * hypothetical: zenmux/meta-muse-spark-1.1 advertises audio and did exactly
 * this. It is also the same defect the Codex catalog had with `video`, where
 * the app showed zero apps (tests/catalog-input-modality-enum.test.ts).
 *
 * UNKNOWN and INCOMPATIBLE are different inputs, and the Codex fix could
 * conflate them safely only because its enum is wider. A model with nothing
 * declared is unknown, and `text` is the honest floor — every routed model takes
 * prompts. A model declaring `["audio"]` and nothing else is incompatible with a
 * text|image client, and rewriting it to `["text"]` would advertise a capability
 * it does not have. That input is reachable three ways: `ocx models add
 * --modalities audio`, `/api/custom-models`, and provider discovery.
 *
 * So unknown falls back to text and incompatible returns null, which drops the
 * row. Omitting a model costs the user a line in a picker; fabricating `text`
 * costs them a model that fails at call time with no explanation.
 *
 * Deliberately NOT applied in `ExportModel` construction: the management and CLI
 * boundaries carry catalog modalities verbatim on purpose, and stripping `audio`
 * globally would destroy valid metadata before the destination is known.
 */
const CLIENT_INPUT_MODALITIES: Record<"pi" | "gajae", ReadonlySet<string>> = {
  pi: new Set(["text", "image"]),
  gajae: new Set(["text", "image"]),
};

/** `null` means the model cannot be represented for this client — drop the row. */
function inputModalitiesForClient(
  client: "pi" | "gajae",
  modalities: readonly string[] | undefined,
): string[] | null {
  const declared = modalities ?? [];
  if (declared.length === 0) return ["text"];
  const accepted = CLIENT_INPUT_MODALITIES[client];
  const kept: string[] = [];
  for (const value of declared) {
    if (accepted.has(value) && !kept.includes(value)) kept.push(value);
  }
  return kept.length > 0 ? kept : null;
}

/** DSH rc.6 accepts text/image; unknown values degrade to text, while audio-only cannot be represented. */
function dshInputModalities(modalities: readonly string[] | undefined): string[] | null {
  const declared = modalities ?? [];
  if (declared.length === 0) return ["text"];
  const kept: string[] = [];
  for (const value of declared) {
    if ((value === "text" || value === "image") && !kept.includes(value)) kept.push(value);
  }
  if (kept.length > 0) return kept;
  return declared.every(value => value === "audio") ? null : ["text"];
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
 * omp accepts a model-level API override. Keep the provider on Chat
 * Completions so routed providers retain their established wire format, while
 * native OpenAI models can use the lossless Responses surface.
 */
export interface OmpModelEntry extends PiModelEntry {
  api?: "openai-responses";
  /** omp requires this flag before it honors a thinking block. */
  reasoning?: true;
  thinking?: {
    mode: "effort";
    efforts: string[];
    defaultLevel?: string;
  };
}

export interface OmpProviderBlock {
  baseUrl: string;
  api: typeof PI_API_DIALECT;
  apiKey: string;
  models: OmpModelEntry[];
}

export interface OmpGeneratedConfig {
  providers: Record<string, OmpProviderBlock>;
}

/**
 * omp validates model entries strictly. These are its documented effort
 * values; omit an unknown value rather than invalidating the whole provider.
 */
const OMP_EFFORT_VOCABULARY = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function ompEfforts(model: ExportModel): string[] {
  const efforts: string[] = [];
  for (const effort of model.reasoningEfforts ?? []) {
    const normalized = effort.trim().toLowerCase();
    if (OMP_EFFORT_VOCABULARY.has(normalized) && !efforts.includes(normalized)) {
      efforts.push(normalized);
    }
  }
  return efforts;
}

/**
 * Hermes `~/.hermes/config.yaml`. We emit ONLY the provider entry — never
 * `model.default` — because hijacking the user's main model is not what a
 * connect action asks for.
 */
export interface HermesProviderBlock {
  api: string;
  api_key: string;
  api_mode: "chat_completions";
  /** We supply the list, so skip their live `/models` probe. */
  discover_models: false;
  models: string[];
  extra_headers?: Record<string, string>;
}

export interface HermesGeneratedConfig {
  providers: Record<string, HermesProviderBlock>;
}

export interface OpenclawModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface OpenclawProviderBlock {
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  models: OpenclawModelEntry[];
  headers?: Record<string, string>;
}

/** `mode: "merge"` keeps OpenClaw's bundled catalog alongside ours. */
export interface OpenclawGeneratedConfig {
  models: {
    mode: "merge";
    providers: Record<string, OpenclawProviderBlock>;
  };
}

export interface KimiProviderBlock {
  type: "openai";
  base_url: string;
  api_key: string;
}

/**
 * `max_context_size` is mandatory and must be positive, so a model with no
 * authoritative context window is omitted from the document entirely rather
 * than guessed at. `capabilities` is never emitted: our catalog does not
 * assert them, and Kimi's own inference works off OpenAI-style name prefixes
 * that a routed selector will not match.
 */
export interface KimiModelBlock {
  provider: string;
  model: string;
  max_context_size: number;
  display_name?: string;
}

export interface KimiGeneratedConfig {
  providers: Record<string, KimiProviderBlock>;
  models: Record<string, KimiModelBlock>;
}

export interface GajaeModelEntry {
  id: string;
  name: string;
  input: string[];
  contextWindow?: number;
  maxTokens?: number;
}

/** Gajae validates strictly: an unknown field fails the whole config. */
export interface GajaeProviderBlock {
  baseUrl: string;
  apiKeyEnv: string;
  api: "openai-completions";
  models: GajaeModelEntry[];
}

export interface GajaeGeneratedConfig {
  providers: Record<string, GajaeProviderBlock>;
}

export type DshReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type DshWireReasoningEffort = DshReasoningEffort | "ultra";

export interface DshModelEntry {
  id: string;
  name: string;
  input: string[];
  contextWindow?: number;
  reasoningEfforts?: Partial<Record<DshReasoningEffort, DshWireReasoningEffort>>;
}

export interface DshProviderBlock {
  displayName: "OpenCodex";
  api: "openai-responses";
  baseURL: string;
  headers: { Authorization: "Bearer ocx_data_dsh" };
  models: DshModelEntry[];
}

export interface DshGeneratedConfig {
  "llm-pi-ai": {
    providers: Record<string, DshProviderBlock>;
  };
}

export interface McodeProviderBlock {
  name: "OpenCodex";
  kind: "custom";
  enabled: true;
  api: "anthropic-messages";
  options: {
    apiKey: string;
    baseURL: string;
    authMode: "api-key";
  };
  models: Record<string, McodeModelEntry>;
}

export interface McodeModelEntry {
  /** MCode uses this value for context accounting and compaction. */
  limit?: { context: number };
  /** MCode exposes these exact levels in `/model` and sends the selected effort. */
  thinking?: { effortOptions: string[] };
}

export interface McodeGeneratedConfig {
  custom_provider: Record<string, McodeProviderBlock>;
}

/**
 * ZCode's `~/.zcode/v2/config.json` provider entry (observed schema, validated
 * live against ZCode 3.7.7 / 3.8.1). `kind: "openai-compatible"` selects the
 * OpenAI Chat Completions protocol, which the proxy serves at `/v1/chat/completions`.
 * `apiKeyRequired` keeps ZCode's UI from prompting for a key it does not need on
 * loopback; the serialized key is always the non-secret loopback placeholder.
 */
export interface ZcodeModelEntry {
  name?: string;
  limit?: { context: number; output?: number };
  modalities: { input: string[]; output: string[] };
}

export interface ZcodeProviderBlock {
  name: "OpenCodex";
  kind: "openai-compatible";
  enabled: true;
  source: "custom";
  options: {
    apiKey: string;
    baseURL: string;
    apiKeyRequired: true;
  };
  models: Record<string, ZcodeModelEntry>;
}

export interface ZcodeGeneratedConfig {
  provider: Record<string, ZcodeProviderBlock>;
}

/**
 * Pi's `~/.pi/agent/models.json` shape. `models` is an ARRAY (identity lives in `id`),
 * unlike OpenCode's keyed object.
 *
 * Two fields were deliberately absent once. `cost` still is: it requires all four price
 * fields and we have no price data at all, so emitting zeros would assert every routed
 * model is free. `reasoning` used to be omitted because Pi's boolean and the catalog's
 * effort ladder did not obviously map — but a NON-EMPTY ladder is the catalog's own
 * statement that the model accepts reasoning parameters (adapters honor `reasoning_effort`),
 * and an empty or absent ladder is the statement that it does not. Emitting `reasoning:
 * true` exactly for rows with a ladder is therefore not a guess; it is what makes Pi's
 * effort control appear for routed models at all. The export also emits a `thinkingLevelMap`
 * that hides every pi level outside the declared ladder, so pi never offers (and sends) an
 * effort the ladder does not contain — custom-row ladders are catalog advertisement only
 * and get no wire clamp, so this map is what keeps pi honest for those. Users who need a
 * different mapping can still hand-tune `thinkingLevelMap` afterwards.
 *
 * Pi's input enum IS verified: its documented model configuration accepts only
 * `text` and `image`, and a validation failure yields an EMPTY model config
 * rather than dropping the offending entry — one bad value costs every routed
 * model. The rest of this contract (omitting `cost`) is still ours rather than
 * a claim about Pi's acceptance.
 */
function buildPiClientConfig(ctx: ExportContext): PiGeneratedConfig {
  const models: PiModelEntry[] = [];
  for (const model of normalizeExportModels(ctx.models)) {
    // Text is the one modality every routed model supports; anything richer must come
    // from the catalog rather than an assumption — and must still be inside the enum
    // Pi accepts, because one rejected value empties the whole config.
    const input = inputModalitiesForClient("pi", model.inputModalities);
    // An audio-only model has no honest representation here; claiming `text`
    // would fail at call time instead, so the row is dropped.
    if (input === null) continue;
    const entry: PiModelEntry = {
      id: model.namespaced,
      name: exportModelLabel(model),
      input,
    };
    if (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0) {
      entry.reasoning = true;
      const efforts = model.reasoningEfforts;
      entry.thinkingLevelMap = {
        // pi's off level maps to the declared `none` sentinel (the proxy omits the
        // reasoning parameter for it); hidden when the ladder does not declare none.
        off: efforts.includes("none") ? "none" : null,
        minimal: efforts.includes("minimal") ? "minimal" : null,
        low: efforts.includes("low") ? "low" : null,
        medium: efforts.includes("medium") ? "medium" : null,
        high: efforts.includes("high") ? "high" : null,
        xhigh: efforts.includes("xhigh") ? "xhigh" : null,
        max: efforts.includes("max") ? "max" : efforts.includes("ultra") ? "ultra" : null,
      };
    }
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.contextWindow = context;
      entry.maxTokens = outputBudgetFor(context);
    }
    models.push(entry);
  }
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        baseUrl: ctx.baseUrl,
        api: PI_API_DIALECT,
        apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
        models,
      },
    },
  };
}

/**
 * omp's models.yml is Pi-like, but it supports effort metadata and a per-model
 * API dialect. Native OpenAI models use Responses; all routed models inherit
 * the provider's existing Chat Completions dialect.
 */
function buildOmpClientConfig(ctx: ExportContext): OmpGeneratedConfig {
  const models: OmpModelEntry[] = [];
  for (const model of normalizeExportModels(ctx.models)) {
    const input = inputModalitiesForClient("pi", model.inputModalities);
    if (input === null) continue;
    const entry: OmpModelEntry = {
      id: model.namespaced,
      name: exportModelLabel(model),
      input,
      ...(model.native && model.provider === "openai" ? { api: "openai-responses" } : {}),
    };
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.contextWindow = context;
      entry.maxTokens = outputBudgetFor(context);
    }
    const efforts = ompEfforts(model);
    if (efforts.length > 0) {
      const defaultLevel = model.defaultReasoningEffort?.trim().toLowerCase();
      entry.reasoning = true;
      entry.thinking = {
        mode: "effort",
        efforts,
        ...(defaultLevel && efforts.includes(defaultLevel) ? { defaultLevel } : {}),
      };
    }
    models.push(entry);
  }
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        baseUrl: ctx.baseUrl,
        api: PI_API_DIALECT,
        apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
        models,
      },
    },
  };
}

/** Extra headers a non-loopback bind needs, or nothing on loopback. */
function proxyAdmissionHeaders(config: OcxConfig | undefined, envRef: string): Record<string, string> | undefined {
  return shouldInjectApiAuthHeader(config) ? { "x-opencodex-api-key": envRef } : undefined;
}

function buildHermesClientConfig(ctx: ExportContext): HermesGeneratedConfig {
  const models = normalizeExportModels(ctx.models).map(model => model.namespaced);
  const headers = proxyAdmissionHeaders(ctx.config, HERMES_API_KEY_ENV_REF);
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        api: ctx.baseUrl,
        api_key: HERMES_API_KEY_ENV_REF,
        api_mode: "chat_completions",
        discover_models: false,
        models,
        ...(headers ? { extra_headers: headers } : {}),
      },
    },
  };
}

function buildOpenclawClientConfig(ctx: ExportContext): OpenclawGeneratedConfig {
  const models: OpenclawModelEntry[] = normalizeExportModels(ctx.models).map(model => {
    const context = authoritativeContextWindow(model.contextWindow);
    return {
      id: model.namespaced,
      name: exportModelLabel(model),
      ...(context !== undefined ? { contextWindow: context } : {}),
    };
  });
  const headers = proxyAdmissionHeaders(ctx.config, OPENCLAW_API_KEY_ENV_REF);
  return {
    models: {
      mode: "merge",
      providers: {
        [OPENCODE_PROVIDER_ID]: {
          baseUrl: ctx.baseUrl,
          apiKey: OPENCLAW_API_KEY_ENV_REF,
          api: "openai-completions",
          models,
          ...(headers ? { headers } : {}),
        },
      },
    },
  };
}

/** Kimi's model alias: one key per model, namespaced under our provider id. */
export function kimiModelAlias(namespaced: string): string {
  return `${OPENCODE_PROVIDER_ID}/${namespaced}`;
}

function buildKimiClientConfig(ctx: ExportContext): KimiGeneratedConfig {
  const models: Record<string, KimiModelBlock> = {};
  for (const model of normalizeExportModels(ctx.models)) {
    const context = authoritativeContextWindow(model.contextWindow);
    // `max_context_size` is mandatory and must be positive. We do not guess it,
    // so a model without an authoritative window is left out rather than
    // shipped with a number we invented.
    if (context === undefined) continue;
    models[kimiModelAlias(model.namespaced)] = {
      provider: OPENCODE_PROVIDER_ID,
      model: model.namespaced,
      max_context_size: context,
      ...(model.displayName ? { display_name: model.displayName } : {}),
    };
  }
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        type: "openai",
        base_url: ctx.baseUrl,
        api_key: LOOPBACK_API_KEY_PLACEHOLDER,
      },
    },
    models,
  };
}

function buildGajaeClientConfig(ctx: ExportContext): GajaeGeneratedConfig {
  const models: GajaeModelEntry[] = [];
  for (const model of normalizeExportModels(ctx.models)) {
    // Gajae's enum is text|image and it rejects the whole file over one bad
    // value, naming the offending index in the error.
    const input = inputModalitiesForClient("gajae", model.inputModalities);
    if (input === null) continue;
    const entry: GajaeModelEntry = {
      id: model.namespaced,
      name: exportModelLabel(model),
      input,
    };
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.contextWindow = context;
      entry.maxTokens = outputBudgetFor(context);
    }
    models.push(entry);
  }
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        baseUrl: ctx.baseUrl,
        apiKeyEnv: GAJAE_API_KEY_ENV,
        api: "openai-completions",
        models,
      },
    },
  };
}

const DSH_EFFORT_ORDER: readonly DshReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

function dshReasoningEfforts(model: ExportModel): DshModelEntry["reasoningEfforts"] {
  const offered = new Set<string>();
  for (const raw of model.reasoningEfforts ?? []) {
    const effort = raw.trim().toLowerCase();
    if (effort === "ultra" || DSH_EFFORT_ORDER.includes(effort as DshReasoningEffort)) offered.add(effort);
  }
  if (offered.size === 0) return undefined;
  const entries: Array<[DshReasoningEffort, DshWireReasoningEffort]> = [];
  for (const effort of DSH_EFFORT_ORDER) {
    if (effort !== "max") {
      if (offered.has(effort)) entries.push([effort, effort]);
      continue;
    }
    // DSH's key is the selectable level; the value is what it sends on the
    // wire. Preserve OpenCodex's `ultra` spelling when that is the only
    // highest effort, exactly like the rc.6 `max: ultra` contract.
    if (offered.has("max")) entries.push(["max", "max"]);
    else if (offered.has("ultra")) entries.push(["max", "ultra"]);
  }
  return Object.fromEntries(entries);
}

function isKnownSafeDshCombo(model: ExportModel, config: OcxConfig): boolean {
  const combos = (config as { combos?: unknown }).combos;
  if (typeof combos !== "object" || combos === null || Array.isArray(combos)) return false;
  const combo = (combos as Record<string, unknown>)[model.id];
  if (typeof combo !== "object" || combo === null || Array.isArray(combo)) return false;
  const targets = (combo as { targets?: unknown }).targets;
  if (!Array.isArray(targets) || targets.length === 0) return false;
  return targets.every(target => {
    if (typeof target !== "object" || target === null || Array.isArray(target)) return false;
    const provider = (target as { provider?: unknown }).provider;
    const modelId = (target as { model?: unknown }).model;
    return typeof provider === "string"
      && provider.length > 0
      && provider === provider.trim()
      && provider !== "openai"
      && typeof modelId === "string"
      && modelId.length > 0
      && modelId === modelId.trim();
  });
}

function buildDshClientConfig(ctx: ExportContext): DshGeneratedConfig {
  const direct = providerCodexAccountMode("openai", ctx.config?.providers?.openai) === "direct";
  const models: DshModelEntry[] = [];
  for (const model of normalizeExportModels(ctx.models)) {
    if (direct && (model.native === true || model.provider === "openai")) continue;
    if (direct && model.provider === "combo" && (!ctx.config || !isKnownSafeDshCombo(model, ctx.config))) continue;
    const input = dshInputModalities(model.inputModalities);
    if (input === null) continue;
    const contextWindow = authoritativeContextWindow(model.contextWindow);
    const reasoningEfforts = dshReasoningEfforts(model);
    models.push({
      id: model.namespaced,
      name: exportModelLabel(model),
      input,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
    });
  }
  return {
    "llm-pi-ai": {
      providers: {
        [OPENCODE_PROVIDER_ID]: {
          displayName: "OpenCodex",
          api: "openai-responses",
          baseURL: ctx.baseUrl,
          headers: { Authorization: "Bearer ocx_data_dsh" },
          models,
        },
      },
    },
  };
}

/**
 * MiniMax Code's `provider add` command persists custom providers under
 * `custom_provider.<id>`. Its current model schema reads `limit.context` for
 * context accounting and `thinking.effortOptions` for the `/model` effort
 * control. Do not emit the removed `thinking.effort` / `defaultEffort` fields:
 * MCode 0.1.6 migrates those into options and keeps the selected effort in the
 * session. Do not emit `defaultModel` either: connecting a client must not
 * silently replace the user's current model selection.
 */
function buildMcodeClientConfig(ctx: ExportContext): McodeGeneratedConfig {
  const models: Record<string, McodeModelEntry> = {};
  for (const model of normalizeExportModels(ctx.models)) {
    const entry: McodeModelEntry = {};
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) entry.limit = { context };
    // `none` is an internal Codex catalog sentinel, not an MCode effort. MCode
    // forwards every option as `output_config.effort` while keeping adaptive
    // thinking enabled, and the Anthropic ingress deliberately accepts only
    // minimal..ultra. Advertising `none` would therefore create a selectable
    // value that cannot disable reasoning and is not forwarded as an effort.
    const efforts = sanitizeCodexReasoningEfforts(model.reasoningEfforts)
      ?.filter(effort => effort !== "none");
    if (efforts && efforts.length > 0) entry.thinking = { effortOptions: efforts };
    models[model.namespaced] = entry;
  }
  return {
    custom_provider: {
      [OPENCODE_PROVIDER_ID]: {
        name: "OpenCodex",
        kind: "custom",
        enabled: true,
        api: "anthropic-messages",
        options: {
          apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
          baseURL: ctx.baseUrl.replace(/\/v1\/?$/, ""),
          authMode: "api-key",
        },
        models,
      },
    },
  };
}

/**
 * ZCode dials the OpenAI Chat Completions surface (`openai-compatible`), which
 * appends `/chat/completions` to `baseURL`. We supply `baseURL` with the `/v1`
 * suffix so requests land on `/v1/chat/completions`. Model ids are the proxy's canonical
 * `provider/id` selectors, which `/v1/chat/completions` resolves directly. Context
 * limits follow the authoritative-window rule: a model without one ships
 * without `limit` rather than guessing. Modalities are ZCode's observed
 * `text`-floor vocabulary; image-capable rows advertise image input.
 */
function buildZcodeClientConfig(ctx: ExportContext): ZcodeGeneratedConfig {
  const models: Record<string, ZcodeModelEntry> = {};
  for (const model of normalizeExportModels(ctx.models)) {
    const input = inputModalitiesForClient("pi", model.inputModalities);
    if (input === null) continue;
    const entry: ZcodeModelEntry = {
      name: exportModelLabel(model),
      modalities: { input, output: ["text"] },
    };
    // `limit.context` follows the authoritative-window rule. `output` is
    // deliberately absent: ZCode's schema makes it optional and we have no
    // authoritative output budget to assert (reviewer finding: an emitted
    // stand-in would be a guessed capability, exactly what "no metadata is
    // guessed" forbids).
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.limit = { context };
    }
    models[model.namespaced] = entry;
  }
  return {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        name: "OpenCodex",
        kind: "openai-compatible",
        enabled: true,
        source: "custom",
        options: {
          apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
          baseURL: ctx.baseUrl.replace(/\/v1\/?$/, "") + "/v1",
          apiKeyRequired: true,
        },
        models,
      },
    },
  };
}

/**
 * Per-client model counts, read back off the SERIALIZED document rather than
 * recomputed from the input rows: `modelsWithoutLimits` drives a GUI line about
 * the bytes the user actually receives, so a parallel reimplementation of the
 * "authoritative context window" rule would be free to drift from it.
 */
function summarizeOpencode(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = Object.values((document as OpencodeGeneratedConfig | undefined)?.provider?.[OPENCODE_PROVIDER_ID]?.models ?? {});
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => !model.limit).length };
}

function summarizePi(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as PiGeneratedConfig | undefined)?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? [];
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

function summarizeOmp(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as OmpGeneratedConfig | undefined)?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? [];
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

function summarizeHermes(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as HermesGeneratedConfig | undefined)?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? [];
  // Hermes carries selectors only; it has no per-model limit to be missing.
  return { modelCount: models.length, modelsWithoutLimits: 0 };
}

function summarizeOpenclaw(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as OpenclawGeneratedConfig | undefined)?.models?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? [];
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

function summarizeKimi(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = Object.values((document as KimiGeneratedConfig | undefined)?.models ?? {});
  // A model with no authoritative window is omitted entirely, so every model
  // present carries max_context_size by construction.
  return { modelCount: models.length, modelsWithoutLimits: 0 };
}

function summarizeGajae(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as GajaeGeneratedConfig | undefined)?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? [];
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

function summarizeDsh(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as DshGeneratedConfig | undefined)?.["llm-pi-ai"]?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? [];
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

function summarizeMcode(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = Object.values((document as McodeGeneratedConfig | undefined)?.custom_provider?.[OPENCODE_PROVIDER_ID]?.models ?? {});
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => !model.limit).length };
}

function summarizeZcode(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = Object.values((document as ZcodeGeneratedConfig | undefined)?.provider?.[OPENCODE_PROVIDER_ID]?.models ?? {});
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => !model.limit).length };
}

/** One fragment at `path`, built from this client's own document. */
function singleFragment(clientId: ExportClientId, path: readonly string[], value: unknown): ManagedContribution {
  return { clientId, fragments: [{ path, value }] };
}

function buildOpencodeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildOpencodeClientConfig(ctx);
  return singleFragment("opencode", ["provider", OPENCODE_PROVIDER_ID], doc.provider[OPENCODE_PROVIDER_ID]);
}

function buildPiContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildPiClientConfig(ctx);
  return singleFragment("pi", ["providers", OPENCODE_PROVIDER_ID], doc.providers[OPENCODE_PROVIDER_ID]);
}

function buildOmpContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildOmpClientConfig(ctx);
  return singleFragment("omp", ["providers", OPENCODE_PROVIDER_ID], doc.providers[OPENCODE_PROVIDER_ID]);
}

function buildHermesContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildHermesClientConfig(ctx);
  return singleFragment("hermes", ["providers", OPENCODE_PROVIDER_ID], doc.providers[OPENCODE_PROVIDER_ID]);
}

function buildOpenclawContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildOpenclawClientConfig(ctx);
  return singleFragment("openclaw", ["models", "providers", OPENCODE_PROVIDER_ID], doc.models.providers[OPENCODE_PROVIDER_ID]);
}

/**
 * Kimi is why a contribution is a LIST: it owns the provider block AND one
 * `models` entry per model. A writer that only knew about the provider would
 * strand every model entry on disable.
 */
function buildKimiContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildKimiClientConfig(ctx);
  const fragments: ManagedFragment[] = [
    { path: ["providers", OPENCODE_PROVIDER_ID], value: doc.providers[OPENCODE_PROVIDER_ID] },
  ];
  for (const [alias, block] of Object.entries(doc.models)) {
    fragments.push({ path: ["models", alias], value: block });
  }
  return { clientId: "kimi", fragments };
}

function buildGajaeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildGajaeClientConfig(ctx);
  return singleFragment("gajae", ["providers", OPENCODE_PROVIDER_ID], doc.providers[OPENCODE_PROVIDER_ID]);
}

function buildDshContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildDshClientConfig(ctx);
  return singleFragment("dsh", ["llm-pi-ai", "providers", OPENCODE_PROVIDER_ID], doc["llm-pi-ai"].providers[OPENCODE_PROVIDER_ID]);
}

function buildMcodeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildMcodeClientConfig(ctx);
  return singleFragment("mcode", ["custom_provider", OPENCODE_PROVIDER_ID], doc.custom_provider[OPENCODE_PROVIDER_ID]);
}

function buildZcodeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildZcodeClientConfig(ctx);
  return singleFragment("zcode", ["provider", OPENCODE_PROVIDER_ID], doc.provider[OPENCODE_PROVIDER_ID]);
}

/**
 * Prime Agent (PrimeIntellect) is the pi coding agent shipped under a different
 * brand rather than a lookalike: its package declares a `piConfig` block, and
 * the agent derives its config directory (`.prime/agent`) and env prefix from
 * that block alone. `models.json` is therefore the SAME contract Pi reads, so
 * this client reuses Pi's builder and summarizer verbatim. Restating the shape
 * here would create a second copy of one fact, which is exactly how the
 * "anything that is not OpenCode must be Pi" summarizer bug happened.
 *
 * The one thing that could still differ is the path we own, and it does not:
 * Prime keeps our entries under the same `providers.<id>` key. So the only new
 * code is stamping the right client id on the ownership record.
 */
function buildPrimeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildPiClientConfig(ctx);
  return singleFragment("prime", ["providers", OPENCODE_PROVIDER_ID], doc.providers[OPENCODE_PROVIDER_ID]);
}

export const EXPORT_CLIENTS: Record<ExportClientId, ExportClientSpec> = {
  opencode: {
    id: "opencode",
    filename: "opencode.json",
    destination: env => opencodeGlobalConfigPath(env),
    apiKeyEnv: OPENCODE_API_KEY_ENV,
    exportHint: `export ${OPENCODE_API_KEY_ENV}=<your key>`,
    build: buildOpencodeClientConfig,
    format: "json",
    summarize: summarizeOpencode,
    buildContribution: buildOpencodeContribution,
    // carries the dedicated header in provider options
    loopbackOnly: false,
  },
  pi: {
    id: "pi",
    filename: "pi-models.json",
    destination: env => piConfigPath(env),
    apiKeyEnv: "",
    exportHint: "Pi reads a non-secret placeholder from models.json; loopback needs no key.",
    build: buildPiClientConfig,
    format: "json",
    summarize: summarizePi,
    buildContribution: buildPiContribution,
    // No header field in Pi's provider block, so there is nowhere to put the
    // dedicated admission header a remote bind requires.
    loopbackOnly: true,
  },
  omp: {
    id: "omp",
    filename: "omp-models.yaml",
    destination: env => ompModelsConfigPath(env),
    apiKeyEnv: "",
    exportHint: "OMP reads a non-secret placeholder from models.yml; loopback needs no key.",
    build: buildOmpClientConfig,
    format: "yaml",
    summarize: summarizeOmp,
    buildContribution: buildOmpContribution,
    // OMP supports provider-level headers, but remote credential wiring is
    // intentionally deferred from this initial loopback-only integration.
    loopbackOnly: true,
  },
  hermes: {
    id: "hermes",
    filename: "hermes-config.yaml",
    destination: env => hermesConfigPath(env),
    apiKeyEnv: HERMES_API_KEY_ENV,
    exportHint: `export ${HERMES_API_KEY_ENV}=<your key>`,
    build: buildHermesClientConfig,
    format: "yaml",
    summarize: summarizeHermes,
    buildContribution: buildHermesContribution,
    // extra_headers carries the dedicated header
    loopbackOnly: false,
  },
  openclaw: {
    id: "openclaw",
    filename: "openclaw.json5",
    destination: env => openclawConfigPath(env),
    apiKeyEnv: OPENCLAW_API_KEY_ENV,
    exportHint: `export ${OPENCLAW_API_KEY_ENV}=<your key>`,
    build: buildOpenclawClientConfig,
    format: "json5",
    summarize: summarizeOpenclaw,
    buildContribution: buildOpenclawContribution,
    // headers carries the dedicated header
    loopbackOnly: false,
  },
  kimi: {
    id: "kimi",
    filename: "kimi-config.toml",
    destination: env => kimiConfigPath(env),
    // Kimi reads credentials only from its own file, so there is no env var to
    // export: a loopback bind uses the placeholder, and a remote bind is
    // refused rather than handed the user's real key.
    apiKeyEnv: "",
    exportHint: "Kimi Code reads credentials from its config file; loopback needs no key.",
    build: buildKimiClientConfig,
    format: "toml",
    summarize: summarizeKimi,
    buildContribution: buildKimiContribution,
    // no header field, and credentials come only from this file
    loopbackOnly: true,
  },
  gajae: {
    id: "gajae",
    filename: "gajae-models.yaml",
    destination: env => gajaeConfigPath(env),
    apiKeyEnv: GAJAE_API_KEY_ENV,
    exportHint: `export ${GAJAE_API_KEY_ENV}=<your key>`,
    build: buildGajaeClientConfig,
    format: "yaml",
    summarize: summarizeGajae,
    buildContribution: buildGajaeContribution,
    // strict schema with no header field, so the dedicated header has nowhere to go
    loopbackOnly: true,
  },
  dsh: {
    id: "dsh",
    filename: "settings.yaml",
    destination: env => dshConfigPath(env),
    apiKeyEnv: "",
    exportHint: "DSH uses a non-secret loopback bearer placeholder in settings.yaml; loopback needs no key.",
    build: buildDshClientConfig,
    format: "yaml",
    summarize: summarizeDsh,
    buildContribution: buildDshContribution,
    loopbackOnly: true,
  },
  mcode: {
    id: "mcode",
    filename: "mcode-config.yaml",
    destination: env => mcodeConfigPath(env),
    apiKeyEnv: "",
    exportHint: "MiniMax Code reads a non-secret placeholder from config.yaml; loopback needs no key.",
    build: buildMcodeClientConfig,
    format: "yaml",
    summarize: summarizeMcode,
    buildContribution: buildMcodeContribution,
    // MCode persists this credential and exposes no dedicated proxy-admission
    // header field, so real keys are never serialized and remote binds refuse.
    loopbackOnly: true,
  },
  zcode: {
    id: "zcode",
    filename: "config.json",
    destination: env => zcodeConfigPath(env),
    apiKeyEnv: "",
    exportHint: "ZCode reads a non-secret placeholder from v2/config.json; loopback needs no key.",
    build: buildZcodeClientConfig,
    format: "json",
    summarize: summarizeZcode,
    buildContribution: buildZcodeContribution,
    // ZCode persists the credential in its own file and has no dedicated
    // proxy-admission header field, so real keys are never serialized and
    // remote binds refuse — same reasoning as MCode.
    loopbackOnly: true,
  },
  prime: {
    id: "prime",
    filename: "prime-models.json",
    destination: env => primeConfigPath(env),
    apiKeyEnv: "",
    exportHint: "Prime Agent reads a non-secret placeholder from models.json; loopback needs no key.",
    build: buildPiClientConfig,
    format: "json",
    summarize: summarizePi,
    buildContribution: buildPrimeContribution,
    // Prime's provider block does accept `headers`, so a dedicated admission
    // header has somewhere to live, but remote credential wiring is deferred
    // from this initial loopback-only integration — same stance as OMP's.
    loopbackOnly: true,
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

/**
 * The bytes a user actually receives, plus what they are. One place turns a
 * client id into text so the CLI, the API and the GUI cannot disagree about
 * format or media type — and so no consumer has to infer either from a
 * filename.
 */
export function buildClientConfigText(
  client: ExportClientId,
  ctx: ExportContext,
): { document: unknown; text: string; format: ConfigFormat; mediaType: string } {
  const spec = EXPORT_CLIENTS[client];
  const document = spec.build(ctx);
  return {
    document,
    text: serializeDocument(document, spec.format),
    format: spec.format,
    mediaType: FORMAT_MEDIA_TYPE[spec.format],
  };
}

/** The fragments opencodex owns in a client's config (writer-side). */
export function buildClientContribution(client: ExportClientId, ctx: ExportContext): ManagedContribution {
  return EXPORT_CLIENTS[client].buildContribution(ctx);
}

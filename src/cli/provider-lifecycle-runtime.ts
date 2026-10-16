/** Explicit live lifecycle writes; the server remains the persistence authority. */
import { isValidProviderName } from "../config/provider-name";
import { providerRelativeSendPathConfigError } from "../config/provider-relative-send-path";
import { modelCapabilitiesConfigError, providerBaseUrlConfigError } from "../config/provider-validation";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers-destination";
import { parseProviderEditorConfigDTO, providerManagementConfigError } from "../server/auth-cors";
import type { OcxProviderConfig } from "../types";
import { printProviderReceipt, runProviderAction } from "./provider-result";
import { serializeManagementJson } from "./json-input";
import {
  CliUsageError, runtimeBaseUrl, runtimeRequest, takeFlag, takeOptionWithSyntax,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx provider add <name> --live [--adapter <id>] [--base-url <url>]
      [--api-key <key>] [--api-key-transport <x-api-key|bearer>]
      [--auth-mode <key|forward|oauth|local>] [--responses-path <path>]
      [--default-model <id>] [--model <id> --text-only]
      [--google-tool-schema-policy <compatible|reject-lossy>]
      [--allow-private-network] [--set-default] [--force] [--json]
  ocx provider set-default <name> --live [--json]
  ocx provider remove <name> --live --yes [--json]
Add checks the target roster before writing; a concurrent change can still win the upsert race.
--force permits overwriting an observed provider. --sync is not supported with --live.
Remove uses server default reassignment, dependency checks and account/custom-model cleanup.`;
const AUTH_MODES = new Set(["key", "forward", "oauth", "local"]);
const OPTION_FIELDS = {
  "--adapter": "adapter", "--base-url": "baseUrl", "--api-key": "apiKey",
  "--api-key-transport": "apiKeyTransport", "--auth-mode": "authMode",
  "--responses-path": "responsesPath", "--default-model": "defaultModel",
  "--google-tool-schema-policy": "googleToolSchemaPolicy",
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(message: string): never { throw new CliUsageError(message, USAGE); }
function flag(args: string[], name: string): boolean {
  if (args.filter(arg => arg === name).length > 1) invalid("An option was given more than once.");
  return takeFlag(args, name);
}
function checkExplicitFields(fields: Record<string, unknown>): void {
  if (typeof fields.baseUrl === "string" && providerBaseUrlConfigError(fields.baseUrl)) invalid("Invalid provider base URL.");
  if (providerRelativeSendPathConfigError("responsesPath", fields.responsesPath)) invalid("Invalid responses path.");
  if (fields.authMode !== undefined && !AUTH_MODES.has(String(fields.authMode))) invalid("Invalid auth mode.");
  if (fields.apiKeyTransport !== undefined && !["x-api-key", "bearer"].includes(String(fields.apiKeyTransport))) invalid("Invalid API key transport.");
  if (fields.googleToolSchemaPolicy !== undefined && !["compatible", "reject-lossy"].includes(String(fields.googleToolSchemaPolicy))) invalid("Invalid Google tool schema policy.");
}
function parseAdd(args: string[]) {
  const force = flag(args, "--force");
  const setDefault = flag(args, "--set-default");
  const allowPrivateNetwork = flag(args, "--allow-private-network");
  const textOnly = flag(args, "--text-only");
  const model = takeOptionWithSyntax(args, "--model")?.value;
  const fields: Record<string, unknown> = {};
  for (const [option, field] of Object.entries(OPTION_FIELDS)) {
    const value = takeOptionWithSyntax(args, option)?.value;
    if (value !== undefined) {
      if (!value.trim()) invalid("Provider options require nonempty values.");
      fields[field] = value;
    }
  }
  if (allowPrivateNetwork) fields.allowPrivateNetwork = true;
  if (args.length) invalid("Unexpected provider argument or option.");
  if (model !== undefined && !textOnly) invalid("--model requires --text-only.");
  if (model !== undefined && modelCapabilitiesConfigError({ [model]: { inputModalities: ["text"] } })) invalid("Invalid model capability selection.");
  checkExplicitFields(fields);
  return { force, setDefault, fields, textOnly, model };
}

function presetSeed(name: string, payload: unknown): Record<string, unknown> | undefined {
  if (!record(payload) || !Array.isArray(payload.providers)
    || payload.providers.some(row => !record(row) || typeof row.id !== "string")) {
    throw new Error("Invalid provider preset response.");
  }
  const matches = payload.providers.filter(row => row.id === name);
  if (matches.length > 1) throw new Error("Ambiguous provider preset response.");
  const preset = matches[0] as Record<string, unknown> | undefined;
  if (!preset) return undefined;
  // The target catalog's custom row is a form placeholder, not a provider seed.
  if (name === "custom" && preset.baseUrl === "") return undefined;
  if (name === "openai") {
    const seed = preset.provider;
    if (!record(seed) || typeof seed.baseUrl !== "string"
      || !isCanonicalOpenAiForwardProvider(seed as unknown as OcxProviderConfig)
      || !["pool", "direct"].includes(String(seed.codexAccountMode))
      || Object.hasOwn(seed, "allowPrivateNetwork")
      || !parseProviderEditorConfigDTO({ defaultProvider: name, providers: { [name]: seed } }).ok
      || providerRelativeSendPathConfigError("responsesPath", seed.responsesPath)) {
      throw new Error("Invalid canonical provider preset.");
    }
    // Use the selected target's seed verbatim, never a local registry fallback.
    return structuredClone(seed);
  }
  if (typeof preset.adapter !== "string" || !preset.adapter.trim()
    || typeof preset.baseUrl !== "string" || providerBaseUrlConfigError(preset.baseUrl)
    || typeof preset.auth !== "string" || !AUTH_MODES.has(preset.auth)) {
    throw new Error("Invalid provider preset.");
  }
  const seed: Record<string, unknown> = { adapter: preset.adapter, baseUrl: preset.baseUrl, authMode: preset.auth };
  for (const field of ["responsesPath", "chatCompletionsPath", "defaultModel"] as const) {
    if (preset[field] !== undefined) {
      if (typeof preset[field] !== "string" || !preset[field].trim()) throw new Error("Invalid provider preset.");
      seed[field] = preset[field];
    }
  }
  return seed;
}

async function add(name: string, options: ReturnType<typeof parseAdd>, wantsJson: boolean, deps: RuntimeApiDeps): Promise<number> {
  const roster = await runtimeRequest<unknown>("/api/providers", { redirect: "error" }, deps);
  if (!Array.isArray(roster) || roster.some(row => !record(row) || typeof row.name !== "string" || !isValidProviderName(row.name))) {
    throw new Error("Invalid provider roster response.");
  }
  if (!options.force && roster.some(row => row.name === name)) {
    console.error("Provider already exists on this target. Use --force to permit overwrite.");
    return 5;
  }
  const presets = await runtimeRequest("/api/provider-presets", { redirect: "error" }, deps);
  const seed = presetSeed(name, presets);
  if (!seed && (name === "openai" || !options.fields.adapter || !options.fields.baseUrl)) {
    throw new Error("Target preset unavailable. Custom providers require --adapter and --base-url.");
  }
  const provider = { ...seed, ...options.fields };
  if (provider.googleToolSchemaPolicy !== undefined && provider.adapter !== "google") {
    invalid("--google-tool-schema-policy requires the google adapter.");
  }
  if (provider.apiKey !== undefined && provider.authMode !== undefined && provider.authMode !== "key") {
    invalid("--api-key requires key authentication; use the provider login workflow for account authentication.");
  }
  if (options.textOnly) {
    const model = options.model ?? provider.defaultModel;
    if (typeof model !== "string") invalid("--text-only requires --model or a default model.");
    const capabilities = { [model]: { inputModalities: ["text"] } };
    if (modelCapabilitiesConfigError(capabilities)) invalid("Invalid model capability selection.");
    provider.modelCapabilities = capabilities;
  }
  if (name !== "openai" && providerManagementConfigError(name, provider)) invalid("Invalid provider configuration.");
  const result = await runtimeRequest("/api/providers", {
    method: "POST", redirect: "error",
    body: serializeManagementJson({ name, provider, ...(options.setDefault ? { setDefault: true } : {}) }),
  }, deps);
  return printProviderReceipt(result, wantsJson, "added");
}

export async function handleProviderLifecycleRuntimeCommand(
  sub: "add" | "remove" | "set-default", argv: string[], deps: RuntimeApiDeps = {},
): Promise<number> {
  return runProviderAction(async () => {
    const args = [...argv];
    const wantsJson = flag(args, "--json");
    const name = args.shift();
    if (!name || !isValidProviderName(name)) invalid("A valid provider name is required.");
    const options = sub === "add" ? parseAdd(args) : undefined;
    const yes = sub === "remove" ? flag(args, "--yes") : false;
    if (args.length) invalid("Unexpected provider argument or option.");
    if (sub === "remove" && !yes) invalid("Live removal requires --yes.");
    if (name === "openai" && options && (Object.keys(options.fields).length || options.textOnly)) {
      invalid("Canonical OpenAI uses the target preset unchanged; add flags cannot override its seed.");
    }
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    if (options) return add(name, options, wantsJson, pinned);
    const result = await runtimeRequest(`/api/providers?name=${encodeURIComponent(name)}`, {
      method: sub === "remove" ? "DELETE" : "PATCH", redirect: "error",
      ...(sub === "set-default" ? { body: JSON.stringify({ setDefault: true }) } : {}),
    }, pinned);
    return printProviderReceipt(result, wantsJson, sub === "remove" ? "removed" : "set-default");
  });
}

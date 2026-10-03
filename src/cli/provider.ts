/**
 * `ocx provider` subcommand — non-interactive provider management.
 *
 * Subcommands:
 *   list          List configured and available registry providers
 *   add <name>    Add a provider from the registry or with custom flags
 *   remove <name> Remove a configured provider
 *   show <name>   Show provider config details (secrets masked)
 *   set-default <name>  Change the default provider
 */
import { hasOwnProvider, isValidProviderName, loadConfig, sanitizeModelCostsForDisplay, saveConfig } from "../config";
import { apiKeyTransportConfigError, modelCapabilitiesConfigError, mergeModelCapabilities } from "../config/provider-validation";
import { hasHelpFlag, printSubcommandUsage } from "./help";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../providers/registry";
import { providerConfigSeed } from "../providers/derive";
import { dropProviderCustomModels } from "../providers/provider-id-rewrite";
import type { OcxProviderConfig } from "../types";
import { findLiveProxy } from "../server/proxy-liveness";
import { syncModelsToCodex } from "../codex/sync";
import { codexAccountNamespaceProviderCollisionError } from "../codex/account-namespace-match";
import { modelSelectionGuidance, modelSelectionNextSteps } from "./model-selection-guidance";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers-destination";
import { providerRelativeSendPathConfigError } from "../config/provider-relative-send-path";
import type { RuntimeApiDeps } from "./runtime-api";
import { projectLocalSyncResult, type LocalSyncResult } from "./local-sync-result";
import { providerManagementConfigError } from "../server/auth-cors";

export interface ProviderCommandDeps extends RuntimeApiDeps {
  syncModels?: typeof syncModelsToCodex;
}

// ---------------------------------------------------------------------------
// Arg helpers
// ---------------------------------------------------------------------------

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function consumeFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

/** Reject any leftover args (unknown flags or trailing values). */
function rejectUnknownArgs(args: string[], usage: string): void {
  if (args.length === 0) return;
  const unknown = args.filter(a => a.startsWith("-"));
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(", ")}`);
  } else {
    console.error(`Unexpected argument(s): ${args.join(", ")}`);
  }
  console.error(usage);
  process.exit(1);
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Validation helper (F1 fix: validate before saveConfig)
// ---------------------------------------------------------------------------

function validateAndSave(config: ReturnType<typeof loadConfig>): void {
  if (!config.providers || Object.keys(config.providers).length === 0) {
    console.error("Error: config would have no providers. Aborting.");
    process.exit(1);
  }
  if (!hasOwnProvider(config.providers, config.defaultProvider)) {
    console.error(`Error: defaultProvider "${config.defaultProvider}" does not exist in providers. Aborting.`);
    process.exit(1);
  }
  saveConfig(config);
}

// ---------------------------------------------------------------------------
// provider list
// ---------------------------------------------------------------------------

function handleList(args: string[]): void {
  const wantsJson = consumeFlag(args, "--json");
  const wantsJsonl = consumeFlag(args, "--jsonl");
  rejectUnknownArgs(args, "Usage: ocx provider list [--json|--jsonl]");

  if (wantsJson && wantsJsonl) {
    console.error("Use only one of --json or --jsonl.");
    process.exit(1);
  }

  const config = loadConfig();
  const configured = Object.keys(config.providers);
  const entries = configured.map(name => {
    const prov = config.providers[name];
    const registryEntry = getProviderRegistryEntry(name);
    return {
      name,
      adapter: prov.adapter,
      baseUrl: prov.baseUrl,
      authMode: prov.authMode ?? "key",
      defaultModel: prov.defaultModel ?? null,
      isDefault: name === config.defaultProvider,
      source: registryEntry ? "registry" : "custom",
      models: prov.models ?? [],
    };
  });

  if (wantsJsonl) {
    for (const entry of entries) console.log(JSON.stringify(entry));
    return;
  }

  if (wantsJson) {
    console.log(JSON.stringify({ configured: entries, registryCount: PROVIDER_REGISTRY.length }, null, 2));
    return;
  }

  console.log("Configured providers:\n");
  for (const name of configured) {
    const prov = config.providers[name];
    const isDefault = name === config.defaultProvider ? " (default)" : "";
    const registryEntry = getProviderRegistryEntry(name);
    const source = registryEntry ? "" : " [custom]";
    const model = prov.defaultModel ? ` model=${prov.defaultModel}` : "";
    console.log(`  ${name}${isDefault}${source}  adapter=${prov.adapter}${model}`);
  }

  const available = PROVIDER_REGISTRY.filter(e => !configured.includes(e.id));
  if (available.length > 0) {
    console.log(`\nAvailable from registry (${available.length}):\n`);
    for (const entry of available) {
      const auth = entry.authKind === "forward" ? "chatgpt-login" : entry.authKind;
      console.log(`  ${entry.id.padEnd(24)} ${entry.label}  (${auth})`);
    }
    console.log(`\nAdd with: ocx provider add <name> [--api-key <key>]`);
  }
}

// ---------------------------------------------------------------------------
// provider add
// ---------------------------------------------------------------------------

const ADD_USAGE = "Usage: ocx provider add <name> [--adapter <adapter>] [--base-url <url>] [--responses-path <path>] [--auth-mode <key|forward|oauth|local>] [--api-key <key>] [--api-key-transport <x-api-key|bearer>] [--default-model <model>] [--model <id> --text-only] [--google-tool-schema-policy <compatible|reject-lossy>] [--allow-private-network] [--set-default] [--force] [--json] [--sync | --live]";

async function handleAdd(args: string[], deps: ProviderCommandDeps): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith("-")) {
    console.error(ADD_USAGE);
    process.exit(1);
  }

  if (!isValidProviderName(name)) {
    console.error(`Invalid provider name: "${name}". Use letters, numbers, dots, underscores, or hyphens.`);
    process.exit(1);
  }

  const restArgs = args.slice(1);
  const force = consumeFlag(restArgs, "--force");
  const setDefault = consumeFlag(restArgs, "--set-default");
  const wantsJson = consumeFlag(restArgs, "--json");
  const wantsSync = consumeFlag(restArgs, "--sync");
  const allowPrivateNetwork = consumeFlag(restArgs, "--allow-private-network");
  const apiKey = consumeFlagValue(restArgs, "--api-key");
  const apiKeyTransport = consumeFlagValue(restArgs, "--api-key-transport");
  const adapter = consumeFlagValue(restArgs, "--adapter");
  const baseUrl = consumeFlagValue(restArgs, "--base-url");
  const defaultModel = consumeFlagValue(restArgs, "--default-model");
  const responsesPath = consumeFlagValue(restArgs, "--responses-path");
  const authMode = consumeFlagValue(restArgs, "--auth-mode");
  const googleToolSchemaPolicy = consumeFlagValue(restArgs, "--google-tool-schema-policy");
  const textOnly = consumeFlag(restArgs, "--text-only");
  const capabilityModel = consumeFlagValue(restArgs, "--model");
  rejectUnknownArgs(restArgs, ADD_USAGE);
  if (capabilityModel !== undefined && !textOnly) {
    console.error("Error: --model requires --text-only for provider add.");
    process.exit(1);
  }

  const pathError = providerRelativeSendPathConfigError("responsesPath", responsesPath);
  if (pathError || (authMode !== undefined && !["key", "forward", "oauth", "local"].includes(authMode))) {
    console.error(pathError ? `Error: ${pathError}.` : "Error: --auth-mode must be key, forward, oauth, or local.");
    process.exit(1);
  }

  const config = loadConfig();

  const namespaceCollision = codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, name);
  if (namespaceCollision) {
    console.error(`Error: ${namespaceCollision}.`);
    process.exit(1);
  }

  if (hasOwnProvider(config.providers, name) && !force) {
    console.error(`Provider "${name}" already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  let provConfig: OcxProviderConfig;
  const registryEntry = getProviderRegistryEntry(name);

  if (registryEntry) {
    provConfig = providerConfigSeed(registryEntry);
    if (apiKey) {
      if ((authMode ?? registryEntry.authKind) === "forward") {
        console.warn(`Warning: provider "${name}" uses ChatGPT login (forward auth); --api-key is ignored.`);
      } else if ((authMode ?? registryEntry.authKind) === "oauth") {
        console.warn(`Warning: provider "${name}" uses OAuth auth; --api-key is ignored. Run: ocx login ${name}`);
      } else {
        provConfig.apiKey = apiKey;
      }
    }
    if (defaultModel) provConfig.defaultModel = defaultModel;
    if (adapter) provConfig.adapter = adapter;
    if (baseUrl) provConfig.baseUrl = baseUrl;
  } else {
    if (!adapter || !baseUrl) {
      console.error(`Provider "${name}" is not in the registry. --adapter and --base-url are required.`);
      console.error("Usage: ocx provider add <name> --adapter <adapter> --base-url <url> [--api-key <key>]");
      process.exit(1);
    }
    provConfig = {
      adapter,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(defaultModel ? { defaultModel } : {}),
    };
  }

  if (responsesPath !== undefined) provConfig.responsesPath = responsesPath;
  if (authMode !== undefined) provConfig.authMode = authMode as OcxProviderConfig["authMode"];
  if (name === "openai" && (authMode !== undefined || responsesPath !== undefined)
    && !isCanonicalOpenAiForwardProvider(provConfig)) {
    console.error("Error: Canonical OpenAI must keep its built-in forward destination and authentication. Use a separate provider name for a custom endpoint.");
    process.exitCode = 2;
    return;
  }

  if (apiKeyTransport !== undefined) {
    if (apiKeyTransport !== "x-api-key" && apiKeyTransport !== "bearer") {
      console.error('Error: --api-key-transport must be "x-api-key" or "bearer".');
      process.exit(1);
    }
    const transportError = apiKeyTransportConfigError({ ...provConfig, apiKeyTransport });
    if (transportError) {
      console.error(`Error: ${transportError}.`);
      process.exit(1);
    }
    provConfig.apiKeyTransport = apiKeyTransport;
  }
  if (googleToolSchemaPolicy !== undefined) {
    if (googleToolSchemaPolicy !== "compatible" && googleToolSchemaPolicy !== "reject-lossy") {
      console.error('Error: --google-tool-schema-policy must be "compatible" or "reject-lossy".');
      process.exit(1);
    }
    if (provConfig.adapter !== "google") {
      console.error("Error: --google-tool-schema-policy requires the google adapter.");
      process.exit(1);
    }
    provConfig.googleToolSchemaPolicy = googleToolSchemaPolicy;
  }

  const existingProvider = config.providers[name];
  if (existingProvider?.modelCapabilities !== undefined && provConfig.modelCapabilities === undefined) {
    provConfig.modelCapabilities = structuredClone(existingProvider.modelCapabilities);
  }
  if (existingProvider?.modelContextTiers !== undefined && provConfig.modelContextTiers === undefined) {
    provConfig.modelContextTiers = structuredClone(existingProvider.modelContextTiers);
  }
  if (textOnly) {
    const modelId = capabilityModel ?? defaultModel ?? provConfig.defaultModel;
    if (!modelId) {
      console.error("Error: --text-only requires --model or a default model.");
      process.exit(1);
    }
    const declaration = { [modelId]: { inputModalities: ["text"] } };
    const error = modelCapabilitiesConfigError(declaration);
    if (error) { console.error(`Error: ${error}.`); process.exit(1); }
    provConfig.modelCapabilities = mergeModelCapabilities(provConfig.modelCapabilities, declaration);
  }
  // A --force overwrite rotates the key/endpoint but must not drop a
  // user-configured price overlay (same rule as the /api/providers path and
  // the login paths); there is no explicit clear/replace flag yet.
  if (existingProvider?.modelCosts !== undefined && provConfig.modelCosts === undefined) {
    provConfig.modelCosts = existingProvider.modelCosts;
  }
  if (allowPrivateNetwork) provConfig.allowPrivateNetwork = true;
  // New auth/path overrides use the management owner's completed-row contract.
  // Validate before registration state changes; legacy local adds without these
  // options keep their existing config semantics.
  if ((authMode !== undefined || responsesPath !== undefined)
    && providerManagementConfigError(name, provConfig)) {
    console.error("Error: Invalid provider configuration. Authentication, destination and provider options must satisfy the provider's management rules.");
    process.exitCode = 2;
    return;
  }
  const { initializeProviderModelSelection } = await import("../providers/initial-model-selection");
  initializeProviderModelSelection(name, provConfig, existingProvider, config);
  config.providers[name] = provConfig;
  if (setDefault) config.defaultProvider = name;

  validateAndSave(config);

  let sync: LocalSyncResult | undefined;
  if (wantsSync) {
    try {
      const live = await (deps.findLiveProxy ?? findLiveProxy)();
      if (!live) sync = { status: "not-running", ok: false };
      else {
        const result = await (deps.syncModels ?? syncModelsToCodex)(live.port, config, null);
        sync = projectLocalSyncResult(result);
      }
    } catch {
      // Dependency errors can contain keys, paths or request details. Keep a fixed outcome.
      sync = { status: "failed", ok: false };
    }
    if (!sync.ok || sync.status === "refused") process.exitCode = 1;
  }
  const synced = sync?.status === "applied" && sync.ok;
  if (wantsJson) {
    console.log(JSON.stringify({
      action: "added",
      modelSelection: modelSelectionNextSteps(name),
      provider: name,
      adapter: provConfig.adapter,
      baseUrl: provConfig.baseUrl,
      defaultModel: provConfig.defaultModel ?? null,
      isDefault: config.defaultProvider === name,
      source: registryEntry ? "registry" : "custom",
      needsSync: !synced,
      ...(sync ? { sync } : {}),
    }, null, 2));
    return;
  }

  const registryLabel = registryEntry ? ` (${registryEntry.label})` : "";
  console.log(`✅ Provider "${name}"${registryLabel} added.`);
  for (const line of modelSelectionGuidance(name)) console.log(line);
  if (setDefault) console.log(`   Set as default provider.`);
  if (registryEntry?.authKind === "oauth") {
    console.log(`   Authenticate with: ocx login ${name}`);
  }
  if (registryEntry?.authKind === "key" && !apiKey) {
    const envKey = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
    console.log(`   Set API key with: ocx provider add ${name} --api-key <key> --force`);
    console.log(`   Or set env var: ${envKey}`);
  }
  if (synced) console.log("   Models synced to Codex.");
  else {
    if (sync) {
      console.log(sync.configApplied && !sync.ok
        ? "   Provider saved; sync remains incomplete despite config injection."
        : `   Provider saved; client sync outcome: ${sync.status}.`);
      if (sync.catalog && !sync.catalog.converged) console.log("   Model catalog did not converge; inspect the target before retrying.");
    }
    console.log("   Apply to Codex: ocx sync");
  }
}

// ---------------------------------------------------------------------------
// provider remove
// ---------------------------------------------------------------------------

function handleRemove(args: string[]): void {
  const restArgs = [...args];
  const wantsJson = consumeFlag(restArgs, "--json");
  const name = restArgs[0];
  if (!name || name.startsWith("-")) {
    console.error("Usage: ocx provider remove <name> [--json]");
    process.exit(1);
  }
  rejectUnknownArgs(restArgs.slice(1), "Usage: ocx provider remove <name> [--json]");

  const config = loadConfig();
  if (!hasOwnProvider(config.providers, name)) {
    console.error(`Provider "${name}" is not configured.`);
    process.exit(1);
  }

  if (name === config.defaultProvider) {
    console.error(`Cannot remove "${name}" — it is the default provider. Change the default first: ocx provider set-default <other>`);
    process.exit(1);
  }

  if (Object.keys(config.providers).length <= 1) {
    console.error("Cannot remove the last provider.");
    process.exit(1);
  }

  const dependentCombos = Object.entries(config.combos ?? {})
    .filter(([, combo]) => combo.targets.some(target => target.provider === name))
    .map(([id]) => id)
    .sort();
  if (dependentCombos.length > 0) {
    console.error(`Cannot remove "${name}" — combo(s) depend on it: ${dependentCombos.join(", ")}`);
    process.exit(1);
  }

  delete config.providers[name];
  const droppedCustomModels = dropProviderCustomModels(config, name);
  validateAndSave(config);


  if (wantsJson) {
    console.log(JSON.stringify({
      action: "removed",
      provider: name,
      remainingProviders: Object.keys(config.providers),
      defaultProvider: config.defaultProvider,
      needsSync: true,
      ...(droppedCustomModels > 0 ? { droppedCustomModels } : {}),
    }, null, 2));
    return;
  }

  console.log(`✅ Provider "${name}" removed.`);
  if (droppedCustomModels > 0) {
    const plural = droppedCustomModels === 1 ? "model" : "models";
    console.log(`   Also removed ${droppedCustomModels} custom ${plural} that belonged to it.`);
  }
}

// ---------------------------------------------------------------------------
// provider show
// ---------------------------------------------------------------------------

function handleShow(args: string[]): void {
  const restArgs = [...args];
  const wantsJson = consumeFlag(restArgs, "--json");
  const name = restArgs[0];
  if (!name || name.startsWith("-")) {
    console.error("Usage: ocx provider show <name> [--json]");
    process.exit(1);
  }
  rejectUnknownArgs(restArgs.slice(1), "Usage: ocx provider show <name> [--json]");

  const config = loadConfig();
  if (!hasOwnProvider(config.providers, name)) {
    console.error(`Provider "${name}" is not configured.`);
    process.exit(1);
  }

  const prov = config.providers[name];
  const display = {
    ...prov,
    ...(prov.modelCosts !== undefined ? { modelCosts: sanitizeModelCostsForDisplay(prov.modelCosts) } : {}),
    ...(prov.apiKey ? { apiKey: maskSecret(prov.apiKey) } : {}),
    ...(prov.apiKeyPool ? { apiKeyPool: prov.apiKeyPool.map(e => ({ ...e, key: maskSecret(e.key) })) } : {}),
  };

  if (wantsJson) {
    console.log(JSON.stringify({ name, isDefault: name === config.defaultProvider, ...display }, null, 2));
    return;
  }

  console.log(`Provider: ${name}${name === config.defaultProvider ? " (default)" : ""}`);
  console.log(`  adapter:      ${display.adapter}`);
  console.log(`  baseUrl:      ${display.baseUrl}`);
  if (display.authMode) console.log(`  authMode:     ${display.authMode}`);
  if (display.apiKey) console.log(`  apiKey:       ${display.apiKey}`);
  if (display.defaultModel) console.log(`  defaultModel: ${display.defaultModel}`);
  if (display.models?.length) console.log(`  models:       ${display.models.join(", ")}`);
}

// ---------------------------------------------------------------------------
// provider set-default
// ---------------------------------------------------------------------------

function handleSetDefault(args: string[]): void {
  const restArgs = [...args];
  const wantsJson = consumeFlag(restArgs, "--json");
  const name = restArgs[0];
  if (!name || name.startsWith("-")) {
    console.error("Usage: ocx provider set-default <name> [--json]");
    process.exit(1);
  }
  rejectUnknownArgs(restArgs.slice(1), "Usage: ocx provider set-default <name> [--json]");

  const config = loadConfig();
  if (!hasOwnProvider(config.providers, name)) {
    console.error(`Provider "${name}" is not configured. Add it first: ocx provider add ${name}`);
    process.exit(1);
  }

  if (config.defaultProvider === name) {
    if (wantsJson) {
      console.log(JSON.stringify({ action: "noop", provider: name, defaultProvider: name, needsSync: false }, null, 2));
    } else {
      console.log(`"${name}" is already the default provider.`);
    }
    return;
  }

  config.defaultProvider = name;
  validateAndSave(config);


  if (wantsJson) {
    console.log(JSON.stringify({ action: "set-default", provider: name, defaultProvider: name, needsSync: true }, null, 2));
    return;
  }

  console.log(`✅ Default provider set to "${name}".`);
}

// ---------------------------------------------------------------------------
// Router (F2 fix: handle help flags internally, like service/codex-shim)
// ---------------------------------------------------------------------------


export async function handleProviderCommand(args: string[], deps: ProviderCommandDeps = {}): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "help" || hasHelpFlag(args)) {
    printSubcommandUsage("provider");
    process.exit(0);
  }

  const subArgs = args.slice(1);
  const liveArgs = subArgs.filter(arg => arg === "--live" || arg.startsWith("--live="));
  if (liveArgs.length) {
    if (liveArgs.length !== 1 || liveArgs[0] !== "--live" || !["add", "remove", "set-default"].includes(sub)) {
      console.error("Error: --live is a single boolean flag for provider add, remove, or set-default.");
      process.exitCode = 2;
      return;
    }
    subArgs.splice(subArgs.indexOf("--live"), 1);
    const { handleProviderLifecycleRuntimeCommand } = await import("./provider-lifecycle-runtime");
    process.exitCode = await handleProviderLifecycleRuntimeCommand(sub as "add" | "remove" | "set-default", subArgs, deps);
    return;
  }
  if (sub === "snapshot" || sub === "apply") {
    const { handleProviderBatchCommand } = await import("./provider-batch");
    process.exitCode = await handleProviderBatchCommand(sub, subArgs, deps);
    return;
  }
  if (sub === "pacing") {
    const { handleProviderPacingCommand } = await import("./provider-settings");
    process.exitCode = await handleProviderPacingCommand(subArgs, deps);
    return;
  }

  switch (sub) {
    case "list":
      handleList(subArgs);
      break;
    case "add":
      await handleAdd(subArgs, deps);
      break;
    case "remove":
      handleRemove(subArgs);
      break;
    case "show":
      handleShow(subArgs);
      break;
    case "set-default":
      handleSetDefault(subArgs);
      break;
    default: {
      const { handleProviderRuntimeCommand } = await import("./provider-runtime");
      const code = await handleProviderRuntimeCommand(sub, subArgs, deps);
      if (code !== null) {
        process.exitCode = code;
        break;
      }
      console.error(`Unknown provider subcommand: ${sub}`);
      printSubcommandUsage("provider", undefined, { write: console.error });
      process.exit(1);
    }
  }
}

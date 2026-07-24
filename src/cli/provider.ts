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
import { hasOwnProvider, isValidProviderName, loadConfig, saveConfig } from "../config";
import { hasHelpFlag } from "./help";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../providers/registry";
import { providerConfigSeed } from "../providers/derive";
import type { OcxProviderConfig } from "../types";
import { findLiveProxy } from "../server/proxy-liveness";
import { syncModelsToCodex } from "../codex/sync";

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
  rejectUnknownArgs(args, "Usage: ocx provider list [--json]");

  const config = loadConfig();
  const configured = Object.keys(config.providers);

  if (wantsJson) {
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

const ADD_USAGE = "Usage: ocx provider add <name> [--adapter <adapter>] [--base-url <url>] [--api-key <key>] [--default-model <model>] [--allow-private-network] [--set-default] [--force] [--json] [--sync]";

async function handleAdd(args: string[]): Promise<void> {
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
  const adapter = consumeFlagValue(restArgs, "--adapter");
  const baseUrl = consumeFlagValue(restArgs, "--base-url");
  const defaultModel = consumeFlagValue(restArgs, "--default-model");
  rejectUnknownArgs(restArgs, ADD_USAGE);

  const config = loadConfig();

  if (hasOwnProvider(config.providers, name) && !force) {
    console.error(`Provider "${name}" already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  let provConfig: OcxProviderConfig;
  const registryEntry = getProviderRegistryEntry(name);

  if (registryEntry) {
    provConfig = providerConfigSeed(registryEntry);
    if (apiKey) {
      if (registryEntry.authKind === "forward") {
        console.warn(`Warning: provider "${name}" uses ChatGPT login (forward auth); --api-key is ignored.`);
      } else if (registryEntry.authKind === "oauth") {
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

 config.providers[name] = provConfig;
  if (allowPrivateNetwork) provConfig.allowPrivateNetwork = true;
 if (setDefault) config.defaultProvider = name;

  validateAndSave(config);

  if (wantsJson) {
    console.log(JSON.stringify({
      action: "added",
      provider: name,
      adapter: provConfig.adapter,
      baseUrl: provConfig.baseUrl,
      defaultModel: provConfig.defaultModel ?? null,
      isDefault: config.defaultProvider === name,
      source: registryEntry ? "registry" : "custom",
      needsSync: true,
    }, null, 2));
    return;
  }

  if (wantsSync) {
    const live = await findLiveProxy();
    if (live) {
      await syncModelsToCodex(live.port).catch(e => {
        console.error(`Warning: sync failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }

  const registryLabel = registryEntry ? ` (${registryEntry.label})` : "";
  console.log(`✅ Provider "${name}"${registryLabel} added.`);
  if (setDefault) console.log(`   Set as default provider.`);
  if (registryEntry?.authKind === "oauth") {
    console.log(`   Authenticate with: ocx login ${name}`);
  }
  if (registryEntry?.authKind === "key" && !registryEntry.keyOptional && !apiKey) {
    const envKey = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
    console.log(`   Set API key with: ocx provider add ${name} --api-key <key> --force`);
    console.log(`   Or set env var: ${envKey}`);
  }
  if (wantsSync) {
    console.log(`   Models synced to Codex.`);
  } else {
    console.log(`   Apply to Codex: ocx sync`);
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

  delete config.providers[name];
  validateAndSave(config);


  if (wantsJson) {
    console.log(JSON.stringify({
      action: "removed",
      provider: name,
      remainingProviders: Object.keys(config.providers),
      defaultProvider: config.defaultProvider,
      needsSync: true,
    }, null, 2));
    return;
  }

  console.log(`✅ Provider "${name}" removed.`);
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

const PROVIDER_USAGE = `Usage: ocx provider <subcommand>

Subcommands:
  list                  List configured and available providers
  add <name>            Add a provider (registry or custom)
  remove <name>         Remove a configured provider
  show <name>           Show provider config details
  set-default <name>    Change the default provider

Examples:
  ocx provider list
  ocx provider add anthropic --api-key sk-ant-...
  ocx provider add my-ollama --adapter openai-chat --base-url http://localhost:11434/v1
  ocx provider show anthropic --json
  ocx provider set-default anthropic
  ocx provider remove my-ollama`;

export async function handleProviderCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "help" || hasHelpFlag(args)) {
    console.log(PROVIDER_USAGE);
    process.exit(0);
  }

  const subArgs = args.slice(1);

  switch (sub) {
    case "list":
      handleList(subArgs);
      break;
    case "add":
      await handleAdd(subArgs);
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
    default:
      console.error(`Unknown provider subcommand: ${sub}`);
      console.error(PROVIDER_USAGE);
      process.exit(1);
  }
}

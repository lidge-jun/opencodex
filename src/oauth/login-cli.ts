import * as readline from "node:readline";
import { openUrl } from "../lib/open-url";
import { loadConfig, saveConfig } from "../config";
import { findLiveProxy } from "../server/proxy-liveness";
import {
  requestBoundLocalProviderReload,
  type LocalProviderReloadResult,
} from "../server/local-provider-reload-client";
import { isPublicOAuthProvider, listOAuthProviders, runLogin } from "./index";
import { KEY_LOGIN_PROVIDERS, isKeyLoginProvider, validateApiKey, type KeyLoginProvider } from "./key-providers";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { configuredAdminToken } from "../lib/admin-secrets";
import { codexAccountNamespaceProviderCollisionError } from "../codex/account-namespace-match";

const LIVE_RELOAD_PROVIDERS = new Set<string>([
  ...listOAuthProviders(),
  ...Object.keys(KEY_LOGIN_PROVIDERS),
]);

export function runningProxyUpdateHeaders(): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const adminToken = configuredAdminToken();
  if (adminToken) headers.set("X-OpenCodex-API-Key", adminToken);
  return headers;
}

/**
 * Ask the attested runtime to reload one already-persisted provider.
 *
 * Returns the outcome instead of swallowing it. A running proxy that predates
 * attested reload — or one whose runtime record no longer matches — cannot adopt
 * the new credential, and the caller has to say so: the credential is on disk, but
 * the live process keeps routing with the old one until it restarts. Silently
 * printing success there is how a login appears to work and then does not.
 */
export async function notifyRunningProxy(name: string): Promise<LocalProviderReloadResult | null> {
  if (!LIVE_RELOAD_PROVIDERS.has(name)) return null;
  const live = await findLiveProxy();
  if (!live) return null;
  return await requestBoundLocalProviderReload(live, name);
}

/**
 * After `runLogin()` has persisted the merged provider (including preserved apiKey /
 * apiKeyPool / authMode), ask the attested proxy to reload that exact on-disk entry.
 */
export async function notifyRunningProxyAfterOAuthLogin(name: string): Promise<LocalProviderReloadResult | null> {
  if (!loadConfig().providers[name]) return null;
  return await notifyRunningProxy(name);
}

/**
 * A live proxy was found but could not adopt the credential. `null` means there was
 * nothing to notify (no running proxy, or a provider that never reloads live), which
 * is not a warning-worthy state.
 */
export function warnIfLiveReloadSkipped(result: LocalProviderReloadResult | null): void {
  if (!result || result.kind === "reloaded") return;
  console.warn(
    `\n⚠️  A proxy is running but could not reload this provider (${result.reason}).`
    + `\n   The credential is saved to disk; the running proxy keeps using the previous one.`
    + `\n   Restart it to pick this up: ocx restart`,
  );
}

export async function handleLogin(provider?: string): Promise<void> {
  const name = (provider ?? "").trim().toLowerCase();
  if (isPublicOAuthProvider(name)) return handleOAuthLogin(name);
  if (isKeyLoginProvider(name)) return handleKeyLogin(name);
  console.error(
    `Usage: ocx login <provider>\n` +
      `  OAuth login:   ${listOAuthProviders().join(", ")}\n` +
      `  API-key login: ${Object.keys(KEY_LOGIN_PROVIDERS).join(", ")}`,
  );
  process.exit(1);
}

async function handleOAuthLogin(name: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runLogin(name, {
      onAuth: ({ url, instructions }) => {
        console.log(`\n🔐 Opening browser for ${name} login...\n${url}\n`);
        if (instructions) console.log(instructions);
        openUrl(url);
      },
      onProgress: (m) => console.log(`   ${m}`),
      onManualCodeInput: () =>
        new Promise((res) => rl.question("Paste redirect URL or code (or wait for browser): ", res)),
    });
  } finally {
    rl.close();
  }
  const reload = await notifyRunningProxyAfterOAuthLogin(name);
  console.log(`\n✅ Logged in to ${name}. Try: ocx sync`);
  warnIfLiveReloadSkipped(reload);
}

export function providerConfigFromKeyLoginProvider(def: KeyLoginProvider, key: string, baseUrlOverride?: string): OcxProviderConfig {
  return {
    adapter: def.adapter,
    baseUrl: baseUrlOverride ?? def.baseUrl,
    apiKey: key,
    ...(def.apiKeyTransport !== undefined ? { apiKeyTransport: def.apiKeyTransport } : {}),
    ...(def.defaultModel ? { defaultModel: def.defaultModel } : {}),
    ...(def.models ? { models: [...def.models] } : {}),
    ...(def.contextWindow !== undefined ? { contextWindow: def.contextWindow } : {}),
    ...(def.modelContextWindows ? { modelContextWindows: { ...def.modelContextWindows } } : {}),
    ...(def.modelMaxInputTokens ? { modelMaxInputTokens: { ...def.modelMaxInputTokens } } : {}),
    ...(def.defaultMaxOutputTokens !== undefined ? { defaultMaxOutputTokens: def.defaultMaxOutputTokens } : {}),
    ...(def.modelMaxOutputTokens ? { modelMaxOutputTokens: { ...def.modelMaxOutputTokens } } : {}),
    ...(def.modelInputModalities ? { modelInputModalities: cloneRecordOfArrays(def.modelInputModalities) } : {}),
    ...(def.reasoningEfforts ? { reasoningEfforts: [...def.reasoningEfforts] } : {}),
    ...(def.modelReasoningEfforts ? { modelReasoningEfforts: cloneRecordOfArrays(def.modelReasoningEfforts) } : {}),
    ...(def.reasoningEffortMap ? { reasoningEffortMap: { ...def.reasoningEffortMap } } : {}),
    ...(def.modelReasoningEffortMap ? { modelReasoningEffortMap: cloneNestedRecord(def.modelReasoningEffortMap) } : {}),
    ...(def.noVisionModels ? { noVisionModels: [...def.noVisionModels] } : {}),
    ...(def.noReasoningModels ? { noReasoningModels: [...def.noReasoningModels] } : {}),
    ...(def.noTemperatureModels ? { noTemperatureModels: [...def.noTemperatureModels] } : {}),
    ...(def.noTopPModels ? { noTopPModels: [...def.noTopPModels] } : {}),
    ...(def.noPenaltyModels ? { noPenaltyModels: [...def.noPenaltyModels] } : {}),
    ...(def.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...def.autoToolChoiceOnlyModels] } : {}),
    ...(def.preserveReasoningContentModels ? { preserveReasoningContentModels: [...def.preserveReasoningContentModels] } : {}),
    ...(def.requiresReasoningPlaceholderModels ? { requiresReasoningPlaceholderModels: [...def.requiresReasoningPlaceholderModels] } : {}),
    ...(def.escapeBuiltinToolNames !== undefined ? { escapeBuiltinToolNames: def.escapeBuiltinToolNames } : {}),
  };
}

/**
 * Merge a freshly built key-login provider row with a previously saved row,
 * carrying operator-owned fields the key-provider preset cannot know about.
 * Currently that is the user-configured modelCosts overlay: rotating the API
 * key must not silently revert Logs/Usage estimates to catalog prices.
 */
export function mergeKeyLoginProviderRow(
  provider: OcxProviderConfig,
  existing: OcxProviderConfig | undefined,
): OcxProviderConfig {
  return {
    ...provider,
    ...(existing?.modelCosts !== undefined ? { modelCosts: existing.modelCosts } : {}),
  };
}

/**
 * Commit a fresh key-login provider row: merge operator-owned fields from the
 * existing row (currently the modelCosts overlay), persist the merged row, and
 * push the SAME merged row to a running proxy so its live config cannot diverge
 * from disk (e.g. by replacing the overlay with catalog prices until reload).
 * Returns the merged row that was persisted and notified.
 */
export async function commitKeyLoginProvider(
  config: OcxConfig,
  name: string,
  provider: OcxProviderConfig,
  onLiveReload?: (result: LocalProviderReloadResult | null) => void,
): Promise<OcxProviderConfig> {
  const mergedProvider = mergeKeyLoginProviderRow(provider, config.providers[name]);
  config.providers[name] = mergedProvider;
  saveConfig(config);
  // Evaluate the reload BEFORE the optional call: `onLiveReload?.(await ...)` short-circuits
  // the whole argument list when no callback is supplied, so the reload would never fire for
  // callers that do not care about the outcome.
  const reloadResult = await notifyRunningProxy(name);
  onLiveReload?.(reloadResult);
  return mergedProvider;
}

async function handleKeyLogin(name: string): Promise<void> {
  const def = KEY_LOGIN_PROVIDERS[name];
  const preflightConfig = loadConfig();
  const namespaceCollision = codexAccountNamespaceProviderCollisionError(preflightConfig.codexAccountNamespaces, name);
  if (namespaceCollision) {
    console.error(`Error: ${namespaceCollision}.`);
    process.exit(1);
  }
  console.log(`\n🔑 ${def.label} — opening ${def.dashboardUrl} so you can create/copy an API key...`);
  openUrl(def.dashboardUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = (await new Promise<string>((res) => rl.question(`Paste your ${def.label} API key: `, res))).trim();
  // Template URL with placeholders needs resolution before saving.
  let baseUrl = def.baseUrl;
  if (/\{[^}]*\}/.test(baseUrl)) {
    const resolved = (await new Promise<string>((res) => rl.question(`Your endpoint URL (${baseUrl}): `, res))).trim();
    if (!resolved) {
      rl.close();
      console.error("A resolved URL is required — replace the {placeholder} with your actual value.");
      process.exit(1);
    }
    baseUrl = resolved;
  }
  rl.close();
  if (!key) {
    console.error("No key entered.");
    process.exit(1);
  }
  process.stdout.write("   validating… ");
  const valid = await validateApiKey(name, { ...def, baseUrl }, key);
  console.log(valid === true ? "valid ✅" : valid === false ? "INVALID ❌" : "couldn't validate (may still work)");
  if (valid === false) {
    console.error("Provider rejected the key. Not saved.");
    process.exit(1);
  }
  const provider = providerConfigFromKeyLoginProvider(def, key, baseUrl);
  const config = loadConfig();
  const commitCollision = codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, name);
  if (commitCollision) {
    console.error(`Error: ${commitCollision}.`);
    process.exit(1);
  }
  let reload: LocalProviderReloadResult | null = null;
  await commitKeyLoginProvider(config, name, provider, result => { reload = result; });
  console.log(`✅ ${def.label} added. Try: ocx sync`);
  warnIfLiveReloadSkipped(reload);
}

function cloneRecordOfArrays(input: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, [...value]]));
}

function cloneNestedRecord(input: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { ...value }]));
}

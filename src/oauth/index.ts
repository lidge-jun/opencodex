import type { OAuthController, OAuthCredentials } from "./types";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { loadConfig, resolveEnvValue, saveConfig } from "../config";
import { getCredential, saveCredential } from "./store";
import { loginXai, refreshXaiToken } from "./xai";
import { ANTHROPIC_OAUTH_BETA, loginAnthropic, refreshAnthropicToken } from "./anthropic";
import { loginKimi, refreshKimiToken } from "./kimi";
import { deriveOAuthDefaultModel, deriveOAuthProviderConfig } from "../providers/derive";

const REFRESH_SKEW_MS = 60_000;

interface OAuthProviderDef {
  login(ctrl: OAuthController): Promise<OAuthCredentials>;
  refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials>;
  /** provider entry written into config.json on first login. */
  providerConfig: OcxProviderConfig;
  defaultModel: string;
}

function oauthConfig(id: string): OcxProviderConfig {
  const config = deriveOAuthProviderConfig(id);
  if (!config) throw new Error(`OAuth provider missing from registry: ${id}`);
  return config;
}

function oauthDefaultModel(id: string): string {
  const model = deriveOAuthDefaultModel(id);
  if (!model) throw new Error(`OAuth provider missing default model in registry: ${id}`);
  return model;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  xai: {
    login: (ctrl) => loginXai(ctrl, { importLocal: "fallback" }),
    refresh: refreshXaiToken,
    providerConfig: oauthConfig("xai"),
    defaultModel: oauthDefaultModel("xai"),
  },
  anthropic: {
    login: (ctrl) => loginAnthropic(ctrl, { importLocal: "fallback" }),
    refresh: refreshAnthropicToken,
    providerConfig: oauthConfig("anthropic"),
    defaultModel: oauthDefaultModel("anthropic"),
  },
  kimi: {
    login: (ctrl) => loginKimi(ctrl),
    refresh: refreshKimiToken,
    providerConfig: oauthConfig("kimi"),
    defaultModel: oauthDefaultModel("kimi"),
  },
};

export function isOAuthProvider(name: string): boolean {
  return name in OAUTH_PROVIDERS;
}

/** Provider ids that support real OAuth login (drives the GUI's "Log in with …" buttons). */
export function listOAuthProviders(): string[] {
  return Object.keys(OAUTH_PROVIDERS);
}

/** Return a valid access token, refreshing + persisting if expired. Throws if not logged in. */
export async function getValidAccessToken(provider: string): Promise<string> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);
  const cred = getCredential(provider);
  if (!cred) throw new Error(`Not logged in to ${provider}. Run: ocx login ${provider}`);
  if (cred.expires > Date.now() + REFRESH_SKEW_MS) return cred.access;
  const fresh = await def.refresh(cred.refresh);
  saveCredential(provider, fresh);
  return fresh.access;
}

/**
 * Shared bearer-token resolver for /models listing — used by BOTH server.ts:fetchAllModels and
 * codex-catalog.ts:fetchProviderModels so OAuth providers' models are listed once logged in.
 * Returns undefined for forward-mode or oauth-not-logged-in (caller skips).
 */
export async function resolveModelsAuthToken(name: string, prov: OcxProviderConfig): Promise<string | undefined> {
  if (prov.authMode === "forward") return undefined;
  if (prov.authMode === "oauth") {
    try {
      return await getValidAccessToken(name);
    } catch {
      return undefined;
    }
  }
  return resolveEnvValue(prov.apiKey);
}

/**
 * Provider-correct `GET /models` request (URL + headers), so both model-listing paths fetch the
 * LIVE catalog correctly per adapter. Anthropic is the special case: its endpoint is `/v1/models`
 * (not `/models`), it needs `anthropic-version`, and it authenticates with `x-api-key` (key) or
 * `Authorization: Bearer` + the OAuth beta (oauth) — not a bare Bearer. Everyone else uses the
 * OpenAI-style `/models` + Bearer. Response shape is `{ data: [{ id, owned_by? }] }` for both.
 */
export function buildModelsRequest(prov: OcxProviderConfig, apiKey: string | undefined): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...(prov.headers ?? {}) };
  if (prov.adapter === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (prov.authMode === "oauth") {
      headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    return { url: `${prov.baseUrl}/v1/models?limit=1000`, headers };
  }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return { url: `${prov.baseUrl}/models`, headers };
}

/**
 * Refresh OAuth-managed provider presets (`models`, `noReasoningModels`, and a stale `defaultModel`)
 * from the registry so a proxy update that revises a provider's models — e.g. dropping deprecated
 * Claude snapshots or adding a new grok endpoint not in the live `/models` — reaches EXISTING
 * configs on the next `ocx start`, instead of only fresh installs. The live `/models` fetch stays
 * the primary source; this keeps the static fallback (and models-not-in-/models) current.
 *
 * Only touches providers that are registry-managed AND still `authMode: "oauth"`, and only the
 * preset fields (never apiKey/baseUrl/user toggles). Persists + returns true when anything changed.
 */
function cloneProviderField(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}

const OAUTH_RECONCILE_FIELDS: (keyof OcxProviderConfig)[] = [
  "models",
  "contextWindow",
  "modelContextWindows",
  "modelInputModalities",
  "noReasoningModels",
  "noVisionModels",
  "reasoningEfforts",
  "modelReasoningEfforts",
  "reasoningEffortMap",
  "modelReasoningEffortMap",
  "noTemperatureModels",
  "noTopPModels",
  "noPenaltyModels",
  "autoToolChoiceOnlyModels",
  "preserveReasoningContentModels",
];

export function reconcileOAuthProviders(config: OcxConfig): boolean {
  let changed = false;
  for (const [name, prov] of Object.entries(config.providers)) {
    const def = OAUTH_PROVIDERS[name];
    if (!def || prov.authMode !== "oauth") continue;
    const preset = def.providerConfig;
    for (const field of OAUTH_RECONCILE_FIELDS) {
      if (JSON.stringify(prov[field]) === JSON.stringify(preset[field])) continue;
      if (preset[field] !== undefined) {
        prov[field] = cloneProviderField(preset[field]) as never;
      } else {
        delete prov[field];
      }
      changed = true;
    }
    // Heal a defaultModel that no longer exists in the refreshed list (e.g. a deprecated snapshot).
    if (prov.defaultModel && preset.defaultModel && !(prov.models ?? []).includes(prov.defaultModel)) {
      prov.defaultModel = preset.defaultModel;
      changed = true;
    }
  }
  if (changed) saveConfig(config);
  return changed;
}

/** Add/refresh an OAuth provider's config entry on a config object (does not persist). */
export function upsertOAuthProvider(config: OcxConfig, provider: string): void {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return;
  config.providers[provider] = { ...def.providerConfig };
}

/** Run the login flow, persist the credential + upsert the provider entry to disk, return cred. */
export async function runLogin(provider: string, ctrl: OAuthController): Promise<OAuthCredentials> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);
  const cred = await def.login(ctrl);
  saveCredential(provider, cred);
  const config = loadConfig();
  upsertOAuthProvider(config, provider);
  saveConfig(config);
  return cred;
}

/**
 * GUI async login: start the flow, return the auth URL EARLY (the flow keeps running in the
 * background until the callback server captures the redirect), with a concurrency guard and an
 * error surfaced via getLoginStatus().
 */
const loginState = new Map<string, { error?: string; done: boolean }>();

export function getLoginStatus(provider: string): { loggedIn: boolean; email?: string; error?: string } {
  const cred = getCredential(provider);
  const st = loginState.get(provider);
  return { loggedIn: !!cred, email: cred?.email, error: st?.error };
}

export function clearLoginState(provider: string): void {
  loginState.delete(provider);
}

export async function startLoginFlow(provider: string): Promise<{ url: string; instructions?: string }> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);
  const existing = loginState.get(provider);
  if (existing && !existing.done) {
    throw new Error(`A login for ${provider} is already in progress`);
  }
  loginState.set(provider, { done: false });
  return new Promise((resolve, reject) => {
    let urlResolved = false;
    const ctrl: OAuthController = {
      onAuth: ({ url, instructions }) => {
        urlResolved = true;
        resolve({ url, instructions });
      },
      onProgress: () => {},
    };
    // Background: runLogin persists the credential + upserts the provider entry to disk config.
    runLogin(provider, ctrl)
      .then(() => {
        loginState.set(provider, { done: true });
        // Local-token import (grok-cli / Claude Code keychain) completes WITHOUT firing onAuth —
        // resolve so the GUI call returns instead of hanging.
        if (!urlResolved) resolve({ url: "", instructions: "Logged in via an existing local CLI/keychain token — no browser needed." });
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        loginState.set(provider, { done: true, error: msg });
        if (!urlResolved) reject(e);
      });
  });
}

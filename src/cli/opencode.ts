/**
 * `ocx opencode [opencode args...]` — launch opencode wired to the local proxy.
 *
 * Mirrors `ocx claude` (src/cli/claude.ts): ensure the proxy is running, then exec the
 * client with stdio inherited. The wiring channel differs — opencode reads providers
 * from merged JSON config layers rather than env slots.
 *
 * The launcher never copies or rewrites the user's opencode config files. It may read
 * global/project config to detect an existing `provider.opencodex` override, then injects
 * only the generated provider block through OpenCode's inline runtime layer
 * (`OPENCODE_CONFIG_CONTENT`), which outranks project/global/custom config and avoids
 * duplicating API keys, MCP credentials, or breaking relative `{file:…}` paths.
 *
 * The admission key is never serialized into that inline config. The provider block
 * carries opencode's documented `{env:VAR}` reference and the real value is passed
 * only through the child process environment.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../config";
import {
  OPENCODE_API_KEY_ENV,
  OPENCODE_CONFIG_SCHEMA,
  OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG,
  OPENCODE_PROVIDER_ID,
  buildOpencodeProviderBlockFromCatalog,
  opencodeGlobalConfigPath,
} from "../clients/config-export";
import type {
  OpencodeCatalogModel,
  OpencodeGeneratedConfig,
  OpencodeLaunchEnv,
  OpencodeProviderBlock,
} from "../clients/config-export";
import { visibleNativeSlugs } from "../codex/catalog";
import { commandInvocation } from "../lib/win-exec";
import { loadServiceTokenFromFile, serviceApiTokenFilePath } from "../lib/service-secrets";
import { providerCodexAccountMode } from "../providers/registry";
import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { selfLaunchArgv } from "../lib/self-launch-argv";

/**
 * The provider-block serializer, its constants, and the config-path helpers now live in
 * `src/clients/config-export.ts`, shared with every other client-config export surface.
 * They are re-exported here so the launcher's long-standing import surface is unchanged.
 */
export {
  OPENCODE_API_KEY_ENV,
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG,
  OPENCODE_PROVIDER_ID,
  SCHEMA_REQUIRED_OUTPUT_BUDGET,
  buildOpencodeProviderBlockFromCatalog,
  opencodeGlobalConfigPath,
  opencodeProxyBaseUrl,
} from "../clients/config-export";
export type {
  OpencodeCatalogModel,
  OpencodeGeneratedConfig,
  OpencodeLaunchEnv,
  OpencodeModelEntry,
  OpencodeProviderBlock,
} from "../clients/config-export";

/** One proxy-routed model destined for the generated provider block. */
export interface OpencodeRoutedModel {
  provider: string;
  id: string;
  /** Authoritative context window (CatalogModel.contextWindow); optional. */
  contextWindow?: number;
  /** Authoritative display label (CatalogModel.displayName); optional. */
  displayName?: string;
}

/** Row shape from authenticated GET /api/models on the running proxy. */
export interface OpencodeProxyModelRow {
  provider?: string;
  id?: string;
  namespaced?: string;
  native?: boolean;
  disabled?: boolean;
  displayName?: string;
  contextWindow?: number;
}

const PROJECT_CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const;

/**
 * OpenCode's inline runtime config layer. It merges after project/global/custom config
 * and carries only the generated provider block for this launch.
 */
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip `//` and block comments outside string literals. Escape-aware so a quote inside
 * an escaped sequence cannot flip string state and expose config text to the stripper.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      // Newlines are preserved so JSON.parse error positions stay meaningful.
      if (ch === "\n") out += ch;
      else if (ch === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const escaped = text[i + 1];
        if (escaped !== undefined) { out += escaped; i++; }
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === "/" && next === "/") { inLine = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
}

/** Drop commas that sit directly before `}` or `]`, ignoring string contents. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const escaped = text[i + 1];
        if (escaped !== undefined) { out += escaped; i++; }
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/**
 * opencode documents opencode.json as JSONC, so a valid user config may carry comments
 * or trailing commas. Strict JSON.parse runs first and untouched — the tolerant path is
 * only attempted when that throws, keeping well-formed configs away from the stripper.
 */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  }
}

/** Model key as the proxy routes it: `provider/id` for routed models, bare slug for native OpenAI entries. */
export function opencodeModelKey(provider: string, id: string): string {
  return provider === "native" ? id : `${provider}/${id}`;
}

/**
 * Native OpenAI slugs advertised to opencode. Omitted in Codex Direct mode because native
 * chat-completions require the caller's real ChatGPT OAuth bearer, not proxy admission.
 */
export function opencodeLaunchNativeSlugs(config: OcxConfig): string[] {
  if (providerCodexAccountMode("openai", config.providers?.openai) === "direct") return [];
  return [...visibleNativeSlugs(config)];
}

/** Back-compat helper for unit tests that assemble slugs/routed rows directly. */
export function buildOpencodeProviderBlock(
  port: number,
  nativeSlugs: readonly string[],
  routedModels: readonly OpencodeRoutedModel[],
  nativeContextWindow: (slug: string) => number | undefined = () => undefined,
  hostname?: string,
  config: OcxConfig = OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG,
): OpencodeProviderBlock {
  const catalog: OpencodeCatalogModel[] = [
    ...nativeSlugs.map(id => ({
      namespaced: id,
      native: true,
      provider: "openai",
      id,
      contextWindow: nativeContextWindow(id),
    })),
    ...routedModels.map(model => ({
      namespaced: opencodeModelKey(model.provider, model.id),
      native: false,
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
      displayName: model.displayName,
    })),
  ];
  return buildOpencodeProviderBlockFromCatalog(port, catalog, hostname, config);
}

/** Default deadline for authenticated GET /api/models during `ocx opencode` launch. */
export const OPENCODE_PROXY_MODELS_TIMEOUT_MS = 8_000;

/** Fetch the live model catalog from a running proxy's management API. */
export async function fetchOpencodeProxyModels(
  live: LiveProxy,
  apiKey: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpencodeProxyModelRow[]> {
  const baseUrl = `http://${probeHostname(live.hostname)}:${live.port}`;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = new Headers({ Accept: "application/json" });
  const token = apiKey.trim();
  if (token) headers.set("X-OpenCodex-API-Key", token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? OPENCODE_PROXY_MODELS_TIMEOUT_MS);
  const abortIfTimedOut = (): Promise<never> => new Promise((_, reject) => {
    if (controller.signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    controller.signal.addEventListener(
      "abort",
      () => reject(new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    );
  });

  let response: Response;
  let text: string;
  try {
    response = await Promise.race([
      fetchImpl(`${baseUrl}/api/models`, {
        headers,
        signal: controller.signal,
      }),
      abortIfTimedOut(),
    ]);
    text = await Promise.race([response.text(), abortIfTimedOut()]);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new Error(
      timedOut
        ? "Management API timed out while fetching /api/models."
        : `Management API is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = text; }
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
      ? (body as Record<string, string>).error
      : `Management request failed (${response.status})`;
    throw new Error(message);
  }
  if (!Array.isArray(body)) {
    throw new Error("Management API returned an unexpected /api/models payload.");
  }
  return body as OpencodeProxyModelRow[];
}

/**
 * Visible OpenCode catalog entries from proxy /api/models rows. Disabled rows are omitted;
 * native rows are omitted in Codex Direct mode.
 */
export function opencodeCatalogFromProxyRows(
  rows: readonly OpencodeProxyModelRow[],
  config: OcxConfig,
): OpencodeCatalogModel[] {
  const omitNative = providerCodexAccountMode("openai", config.providers?.openai) === "direct";
  const seen = new Set<string>();
  const catalog: OpencodeCatalogModel[] = [];
  for (const row of rows) {
    const namespaced = row.namespaced?.trim();
    if (!namespaced || row.disabled === true) continue;
    if (omitNative && row.native === true) continue;
    if (seen.has(namespaced)) continue;
    seen.add(namespaced);
    catalog.push({
      namespaced,
      native: row.native === true,
      provider: row.provider,
      id: row.id,
      contextWindow: row.contextWindow,
      displayName: row.displayName,
    });
  }
  return catalog;
}

export type OpencodeRuntimeConfigError = { error: string };

/** True when mergeOpencodeRuntimeConfig rejected inherited inline config. */
export function isOpencodeRuntimeConfigError(
  value: OpencodeGeneratedConfig | OpencodeRuntimeConfigError,
): value is OpencodeRuntimeConfigError {
  return "error" in value;
}

/**
 * Merge inherited `OPENCODE_CONFIG_CONTENT` and override only `provider.opencodex`.
 * When no inline layer is present, emit the minimal runtime object for this launcher.
 */
export function mergeOpencodeRuntimeConfig(
  inheritedContent: string | undefined,
  providerBlock: OpencodeProviderBlock,
): OpencodeGeneratedConfig | OpencodeRuntimeConfigError {
  if (!inheritedContent?.trim()) {
    return {
      $schema: OPENCODE_CONFIG_SCHEMA,
      provider: { [OPENCODE_PROVIDER_ID]: providerBlock },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inheritedContent);
  } catch {
    return { error: "OPENCODE_CONFIG_CONTENT is not valid JSON." };
  }
  if (!isRecord(parsed)) {
    return { error: "OPENCODE_CONFIG_CONTENT must be a JSON object." };
  }
  const existingProvider = parsed.provider;
  if (existingProvider !== undefined && !isRecord(existingProvider)) {
    return { error: "OPENCODE_CONFIG_CONTENT provider must be a JSON object when present." };
  }
  return {
    ...parsed,
    $schema: typeof parsed.$schema === "string" ? parsed.$schema : OPENCODE_CONFIG_SCHEMA,
    provider: {
      ...(isRecord(existingProvider) ? existingProvider : {}),
      [OPENCODE_PROVIDER_ID]: providerBlock,
    },
  } as OpencodeGeneratedConfig;
}

/** Inline runtime config carrying only the provider block this launcher owns. */
export function buildOpencodeConfig(
  port: number,
  nativeSlugs: readonly string[],
  routedModels: readonly OpencodeRoutedModel[],
  nativeContextWindow: (slug: string) => number | undefined = () => undefined,
  hostname?: string,
  config: OcxConfig = OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG,
): OpencodeGeneratedConfig {
  const merged = mergeOpencodeRuntimeConfig(
    undefined,
    buildOpencodeProviderBlock(port, nativeSlugs, routedModels, nativeContextWindow, hostname, config),
  );
  if (isOpencodeRuntimeConfigError(merged)) {
    throw new Error(merged.error);
  }
  return merged;
}

/** Serialize the inline runtime config OpenCode merges on launch. */
export function serializeOpencodeRuntimeConfig(config: OpencodeGeneratedConfig): string {
  return JSON.stringify(config);
}

function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function configFileDefinesProvider(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = parseJsonc(readFileSync(path, "utf8"));
    return isRecord(parsed) && isRecord(parsed.provider) && OPENCODE_PROVIDER_ID in parsed.provider;
  } catch {
    return false;
  }
}

/**
 * Detect global or project-level opencode.json/jsonc that defines our provider key.
 * Informational only: the inline runtime layer from `OPENCODE_CONFIG_CONTENT` outranks both.
 */
export function opencodeProviderOverridePath(
  cwd: string,
  env: OpencodeLaunchEnv = process.env,
  home: string = homedir(),
): string | null {
  const globalPath = opencodeGlobalConfigPath(env, home);
  if (configFileDefinesProvider(globalPath)) return globalPath;

  const gitRoot = findGitRoot(cwd);
  let dir = cwd;
  while (true) {
    for (const name of PROJECT_CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (configFileDefinesProvider(candidate)) return candidate;
    }
    if (gitRoot && dir === gitRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** @deprecated Use {@link opencodeProviderOverridePath}. */
export function projectConfigOverridesProvider(cwd: string): string | null {
  return opencodeProviderOverridePath(cwd);
}

function serviceTokenLookupEnv(env: OpencodeLaunchEnv): OpencodeLaunchEnv {
  if (env.OCX_API_TOKEN_FILE?.trim()) return env;
  return { ...env, OCX_API_TOKEN_FILE: serviceApiTokenFilePath() };
}

/**
 * Child env for a detached `ocx start` from `ocx opencode`. When the admission token is
 * not already in the environment, pass through an existing `OCX_API_TOKEN_FILE` or the
 * default hardened service token path so `handleStart` can load it before bind.
 */
export function opencodeProxyStartEnv(base: OpencodeLaunchEnv = process.env): OpencodeLaunchEnv {
  const withTokenFile = base.OPENCODEX_API_AUTH_TOKEN?.trim()
    ? base
    : serviceTokenLookupEnv(base);
  return { ...withTokenFile, OCX_SERVICE: "1" };
}

/**
 * Env assembly (unit-tested). Inherited inline config is merged and only
 * `provider.opencodex` is replaced; disk config layers stay untouched. The admission
 * key travels in the child env rather than in the inline config payload.
 */
export function buildOpencodeEnv(
  providerBlock: OpencodeProviderBlock,
  apiKey: string,
  base: OpencodeLaunchEnv,
): OpencodeLaunchEnv | OpencodeRuntimeConfigError {
  const runtimeConfig = mergeOpencodeRuntimeConfig(base[OPENCODE_CONFIG_CONTENT_ENV], providerBlock);
  if (isOpencodeRuntimeConfigError(runtimeConfig)) return runtimeConfig;
  return {
    ...base,
    [OPENCODE_CONFIG_CONTENT_ENV]: serializeOpencodeRuntimeConfig(runtimeConfig),
    [OPENCODE_API_KEY_ENV]: apiKey,
  };
}

/**
 * Admission key for the proxy: env token, hardened service token file, configured API
 * key, then the open-loopback placeholder. Never serialized into runtime config.
 */
export function opencodeApiKey(config: OcxConfig, env: OpencodeLaunchEnv = process.env): string {
  const envToken = env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (envToken) return envToken;
  const serviceToken = loadServiceTokenFromFile(serviceTokenLookupEnv(env));
  if (serviceToken) return serviceToken;
  return config.apiKeys?.[0]?.key || "ocx";
}

async function ensureProxyForOpencode(config: OcxConfig): Promise<LiveProxy | null> {
  const live = await findLiveProxy();
  if (live) return live;
  const cfgPort = config.port;
  const pinPort = typeof cfgPort === "number" && cfgPort > 0 ? cfgPort : 10100;
  const child = spawn(process.execPath, selfLaunchArgv(["start", "--port", String(pinPort)]), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: withProcessRuntimeProvenance(opencodeProxyStartEnv(process.env) as NodeJS.ProcessEnv),
  });
  // Without a listener an 'error' (bad argv[1], EMFILE, AV denial) throws synchronously
  // and kills this process; the health poll below already reports the failure properly.
  child.on("error", () => { /* handled by the deadline loop returning null */ });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const started = await findLiveProxy();
    if (started) return started;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

const OPENCODE_INSTALL_HINT = "❌ `opencode` CLI not found. Install it first: npm install -g opencode-ai";

/**
 * cmd.exe reports command-not-found as exit 9009 (the win32 launcher routes `.cmd`
 * shims through cmd.exe, so ENOENT never fires there). Signal exits are not hints.
 * Same contract as claudeNotFoundHint (devlog 260715_cross_platform_audit/020).
 */
export function opencodeNotFoundHint(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === "win32" && code === 9009 && !signal ? OPENCODE_INSTALL_HINT : null;
}

export async function cmdOpencode(args: string[]): Promise<number> {
  const config = loadConfig();
  const live = await ensureProxyForOpencode(config);
  if (!live) {
    console.error("❌ Proxy did not become healthy after starting.");
    return 1;
  }

  const apiKey = opencodeApiKey(config);
  let proxyModels: OpencodeProxyModelRow[];
  try {
    proxyModels = await fetchOpencodeProxyModels(live, apiKey);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`❌ Could not fetch the model catalog from the proxy: ${reason}`);
    return 1;
  }
  const catalog = opencodeCatalogFromProxyRows(proxyModels, config);
  const providerBlock = buildOpencodeProviderBlockFromCatalog(
    live.port,
    catalog,
    live.hostname,
    config,
  );
  const baseUrl = providerBlock.options.baseURL;
  const modelCount = catalog.length;
  console.error(`✅ opencode wired to ${baseUrl} — ${modelCount} model(s) under provider \`${OPENCODE_PROVIDER_ID}\`.`);
  console.error("   Your existing opencode config files are left untouched; only the runtime provider block is injected.");
  const providerOverride = opencodeProviderOverridePath(process.cwd());
  if (providerOverride) {
    console.error(`ℹ ${providerOverride} also defines provider.${OPENCODE_PROVIDER_ID}; the runtime layer from ocx opencode overrides it for this launch.`);
  }

  const builtEnv = buildOpencodeEnv(providerBlock, apiKey, process.env);
  if ("error" in builtEnv) {
    console.error(`❌ ${builtEnv.error}`);
    return 1;
  }
  const env = builtEnv;
  return await new Promise<number>(resolve => {
    const inv = commandInvocation("opencode", args);
    const child = spawn(inv.file, inv.args, { stdio: "inherit", env: env as NodeJS.ProcessEnv, ...inv.options });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error(OPENCODE_INSTALL_HINT);
      } else {
        console.error(`❌ Failed to launch opencode: ${err.message}`);
      }
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      const hint = opencodeNotFoundHint(code, signal);
      if (hint) console.error(hint);
      resolve(signal ? 1 : code ?? 0);
    });
  });
}

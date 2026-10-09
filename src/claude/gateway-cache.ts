/**
 * Claude Code gateway-model cache writer (devlog 260712 030).
 *
 * Claude Code 2.1.207 refreshes ~/.claude/cache/gateway-models.json ONLY when it
 * holds a credential (q5l(): `if(!ANTHROPIC_AUTH_TOKEN && !apiKey) return`). Our
 * subscription-preserving launch deliberately sets no token, so the CLI can never
 * refresh its picker list itself — it reads whatever cache exists. We therefore
 * pre-write the cache in the exact on-disk schema the CLI uses:
 *   { baseUrl, fetchedAt, models: [{ id, display_name?, description? }] }  (mode 0600)
 * mirroring the picker rule that the id must contain `claude` or `anthropic`.
 * Current aliases are `ocx-claude-*`, so an anchored `^(claude|anthropic)` filter
 * would drop every newly minted routed model. The picker validates
 * only `baseUrl === ANTHROPIC_BASE_URL`, so a foreign base URL is simply ignored.
 * `description` replaces the picker's generic "From gateway" line (Claude Code >= 2.1.257).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { localAdmissionToken, localInferenceDestination } from "../lib/local-destinations";
import { assertNotRealClaudeConfigUnderTest } from "../lib/test-home-guard";
import type { OcxConfig } from "../types";

export interface GatewayModelRow {
  id: string;
  display_name?: string;
  description?: string;
}

export interface GatewayModelCacheRefreshOptions {
  timeoutMs?: number;
  configDir?: string;
  /**
   * Admission credential source AND local destination source: the cache file's `baseUrl` must
   * equal the `ANTHROPIC_BASE_URL` the CLI is launched with or Claude Code ignores the whole
   * cache, so this has to resolve the same loopback listener `buildClaudeEnv` resolves (#4236).
   */
  admissionConfig?: Pick<OcxConfig, "apiKeys" | "hostname" | "unauthenticatedLoopbackListener">;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface GatewayModelTarget {
  baseUrl: string;
  admissionToken: string;
}

/** Claude Code config dir (CLAUDE_CONFIG_DIR override honored, like the CLI). */
export function claudeConfigDir(): string {
  const custom = process.env.CLAUDE_CONFIG_DIR;
  return custom && custom.length > 0 ? custom : join(currentUserHome(), ".claude");
}

/**
 * The home Claude Code itself resolves. Claude Code runs on Node, whose `os.homedir()`
 * consults HOME (POSIX) or USERPROFILE (Windows) at call time when it is set; Bun's
 * `os.homedir()` keeps the value it read at startup. In production the two agree. Under
 * the test preload, which rewrites HOME after Bun has started, only this one follows the
 * sandbox — the cached value is the developer's real home (#6775). Exported for tests.
 */
export function currentUserHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const fromEnv = platform === "win32" ? env.USERPROFILE : env.HOME;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : homedir();
}

/** Write the cache file; returns its path or null (best-effort, never throws). */
export function writeGatewayModelCache(baseUrl: string, models: readonly GatewayModelRow[], configDir = claudeConfigDir()): string | null {
  // Outside the best-effort catch: an armed test process must not write here, and must
  // fail loudly rather than degrade to "returned null".
  // The file itself too: writeFileSync follows a link at gateway-models.json.
  assertNotRealClaudeConfigUnderTest(configDir, join(configDir, "cache"), join(configDir, "cache", "gateway-models.json"));
  try {
    // Mirror the CLI's usable-id filter so our file matches what it would cache.
    const usable = models.filter(m => /(claude|anthropic)/i.test(m.id));
    const cacheDir = join(configDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const path = join(cacheDir, "gateway-models.json");
    const payload = {
      baseUrl,
      fetchedAt: Date.now(),
      models: usable.map(m => ({
        id: m.id,
        ...(m.display_name === undefined ? {} : { display_name: m.display_name }),
        ...(m.description === undefined ? {} : { description: m.description }),
      })),
    };
    writeFileSync(path, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

export interface GatewayModelSnapshot { baseUrl: string; models: GatewayModelRow[] }

/** Acquire fresh exposure independently of whether the local cache is writable. */
export async function fetchGatewayModels(
  portOrTarget: number | GatewayModelTarget,
  options: GatewayModelCacheRefreshOptions = {},
): Promise<GatewayModelSnapshot | null> {
  try {
    const headers = new Headers({ "anthropic-version": "2023-06-01" });
    // A wildcard/non-loopback listener requires data-plane admission even for a
    // request sent to its local 127.0.0.1 address. Reuse the same dedicated
    // credential domain as /v1/models admission; never place it in Authorization,
    // which can belong to an upstream provider on other data-plane surfaces.
    // Env token, then the hardened service token file (a service install writes the admission
    // token to disk rather than the interactive environment), then a configured key — one
    // shared ladder, so this cannot drift from what `buildClaudeEnv` puts in the launch env.
    const admissionToken = typeof portOrTarget === "number"
      ? localAdmissionToken(options.admissionConfig, options.env ?? process.env)
      : portOrTarget.admissionToken;
    if (admissionToken) headers.set("x-opencodex-api-key", admissionToken);

    const baseUrl = typeof portOrTarget === "number"
      ? localInferenceDestination(options.admissionConfig, portOrTarget).origin
      : new URL(portOrTarget.baseUrl).origin;

    // ?ids=cli pins the readable claude-ocx id family deterministically (audit 051
    // #5): the cache prewrite must not depend on UA sniffing.
    const res = await (options.fetchImpl ?? fetch)(`${baseUrl}/v1/models?limit=1000&ids=cli`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { data?: unknown };
    if (!Array.isArray(body.data)) return null;
    const models: GatewayModelRow[] = body.data
      .filter(m => m && typeof m === "object" && typeof m.id === "string" && m.id.length > 0)
      .map(m => ({
        id: m.id as string,
        display_name: typeof m.display_name === "string" ? m.display_name : undefined,
        description: typeof m.description === "string" ? m.description : undefined,
      }));
    return { baseUrl, models };
  } catch {
    return null;
  }
}

/** Preserve the cache-refresh API used by launchers and profile application. */
export async function refreshGatewayModelCacheFromProxy(
  portOrTarget: number | GatewayModelTarget,
  options: GatewayModelCacheRefreshOptions = {},
): Promise<string | null> {
  const snapshot = await fetchGatewayModels(portOrTarget, options);
  return snapshot ? writeGatewayModelCache(snapshot.baseUrl, snapshot.models, options.configDir) : null;
}

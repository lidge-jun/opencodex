import { mutatePersistedConfig } from "../config";
import { registerStateSweepAfterTick } from "../lib/state-store-sweeper";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { providerCodexAccountMode } from "../providers/registry";
import type { OcxConfig } from "../types";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import { getAccountQuota, isCodexQuotaExhausted, type StoredAccountQuota } from "./quota";

export interface DesktopAuthlessAutoDeps {
  getQuota?: (accountId: string) => StoredAccountQuota | null;
  refreshQuota?: (config: OcxConfig, accountId: string) => Promise<void>;
  persistSetting?: (config: OcxConfig, enabled: boolean) => boolean;
  applyInjection?: (config: OcxConfig) => Promise<{ applied: boolean }>;
  restartClients?: () => Promise<unknown>;
}

export interface DesktopAuthlessAutoResult {
  acted: boolean;
  exhausted?: boolean;
  authless?: boolean;
}

let inFlight: Promise<DesktopAuthlessAutoResult> | null = null;

/** Load upstream quota metadata only when a recovery actually needs a fresh read. */
async function refreshQuota(config: OcxConfig, accountId: string): Promise<void> {
  const { refreshCodexQuotaForActivation } = await import("./auth-api");
  await refreshCodexQuotaForActivation(config, accountId);
}

/**
 * Persist the failover decision with the same shape the settings route writes: `true` sets
 * the key, `false` deletes it, because absent is the documented default and a written
 * `false` would survive as a decision nobody made.
 */
function persistSetting(config: OcxConfig, enabled: boolean): boolean {
  try {
    const outcome = mutatePersistedConfig(persisted => {
      if (enabled) {
        if (persisted.codexDesktopAuthless === true) return { changed: false, value: false };
        persisted.codexDesktopAuthless = true;
        return { changed: true, value: true };
      }
      if (persisted.codexDesktopAuthless === undefined) return { changed: false, value: false };
      delete persisted.codexDesktopAuthless;
      return { changed: true, value: true };
    });
    if (outcome.status === "unavailable" || !outcome.value) return false;
    if (enabled) config.codexDesktopAuthless = true;
    else delete config.codexDesktopAuthless;
    return true;
  } catch {
    return false;
  }
}

/** Rewrite ~/.codex/config.toml now rather than at the next `ocx sync`. */
async function applyInjection(config: OcxConfig): Promise<{ applied: boolean }> {
  const { applyCodexConfigInjection } = await import("./desktop-switches");
  return applyCodexConfigInjection(config);
}

/** Restart Codex clients so the rewritten routing takes effect. Best-effort. */
async function restartClients(): Promise<unknown> {
  const { performCodexRestart } = await import("./app-server-restart-service");
  return performCodexRestart();
}

/**
 * Engage desktop-authless routing while the main Codex quota reports exhausted, and release
 * it once the window recovers — the automatic form of the manual `codexDesktopAuthless`
 * switch. Only transitions act: a sweep whose desired state already matches the stored
 * setting is a no-op, so quota hovering near the boundary cannot flap the config.
 *
 * Recovery is confirmed against a forced upstream read, never the possibly stale cache:
 * flipping back on stale data would re-arm the Desktop account gate while the window is
 * still exhausted. Every failure path returns instead of throwing; a failover that could
 * break the sweep it runs on would be worse than a missed transition, which the next sweep
 * retries.
 */
export async function runDesktopAuthlessAuto(
  config: OcxConfig,
  deps: DesktopAuthlessAutoDeps = {},
): Promise<DesktopAuthlessAutoResult> {
  if (config.codexDesktopAuthlessAuto !== true) return { acted: false };
  // A client-role process never owns the Codex home, so it must not rewrite it.
  if (config.runtimeRole === "client") return { acted: false };
  const openai = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!openai || openai.disabled === true || !isCanonicalOpenAiForwardProvider(openai)) {
    return { acted: false };
  }
  if (providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, openai) !== "pool") return { acted: false };
  if (inFlight) return inFlight;
  const quotaFor = deps.getQuota ?? getAccountQuota;
  inFlight = (async (): Promise<DesktopAuthlessAutoResult> => {
    const quota = quotaFor(MAIN_CODEX_ACCOUNT_ID);
    const exhausted = isCodexQuotaExhausted(quota);
    const stored = config.codexDesktopAuthless === true;
    if (exhausted === stored) return { acted: false, exhausted, authless: stored };
    if (!exhausted) {
      try {
        await (deps.refreshQuota ?? refreshQuota)(config, MAIN_CODEX_ACCOUNT_ID);
      } catch {
        return { acted: false, exhausted: false, authless: stored };
      }
      if (isCodexQuotaExhausted(quotaFor(MAIN_CODEX_ACCOUNT_ID))) {
        return { acted: false, exhausted: true, authless: stored };
      }
    }
    const persist = deps.persistSetting ?? persistSetting;
    if (!persist(config, exhausted)) {
      console.warn("[desktop-authless-auto] quota transition observed but the setting could not be persisted; retry on the next sweep");
      return { acted: false, exhausted, authless: stored };
    }
    try {
      const injection = await (deps.applyInjection ?? applyInjection)(config);
      if (!injection.applied) {
        console.warn("[desktop-authless-auto] setting persisted but ~/.codex/config.toml was not rewritten; run 'ocx sync' to apply it");
      }
    } catch (error) {
      console.warn(`[desktop-authless-auto] config injection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await (deps.restartClients ?? restartClients)();
    } catch (error) {
      console.warn(`[desktop-authless-auto] Codex client restart failed: ${error instanceof Error ? error.message : String(error)}; restart Codex manually to adopt the new routing`);
    }
    console.warn(`[desktop-authless-auto] ${exhausted ? "engaged authless routing: main Codex quota exhausted" : "released authless routing: main Codex quota recovered"}`);
    return { acted: true, exhausted, authless: exhausted };
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Attach failover to the shared minute sweep and return its owner-scoped cleanup. */
export function registerDesktopAuthlessAutoWorker(config: OcxConfig): () => void {
  return registerStateSweepAfterTick({
    name: "desktop-authless-auto",
    afterTick: () => { void runDesktopAuthlessAuto(config); },
  });
}

/** Clear single-flight state between isolated test cases. */
export function resetDesktopAuthlessAutoForTests(): void {
  inFlight = null;
}

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { expandUserPath, getConfigDir } from "../config/paths";
import { isVisionEligibleModel } from "../vision/eligibility";
import type { RequestTransformContext, RequestTransformFn, RequestTransformModule } from "./types";

const transformCache = new Map<string, Promise<RequestTransformFn | null>>();

/**
 * Validate that an object returned by a dynamic transform matches the minimal required
 * structure of an OcxParsedRequest before replacing the active request.
 */
function isValidParsedRequest(val: unknown): val is OcxParsedRequest {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const candidate = val as Record<string, unknown>;
  return (
    typeof candidate.modelId === "string" &&
    candidate.context !== null &&
    typeof candidate.context === "object" &&
    Array.isArray((candidate.context as Record<string, unknown>).messages)
  );
}

/**
 * Resolve a transform specifier into an absolute file path or module identifier.
 * Checks against the config directory (~/.opencodex) first, then current working directory.
 */
export function resolveTransformPath(specifier: string, configDir: string = getConfigDir()): string {
  const expanded = expandUserPath(specifier.trim());
  if (isAbsolute(expanded)) {
    return expanded;
  }
  const fromConfig = resolve(configDir, expanded);
  if (existsSync(fromConfig)) {
    return fromConfig;
  }
  const fromCwd = resolve(process.cwd(), expanded);
  if (existsSync(fromCwd)) {
    return fromCwd;
  }
  return expanded;
}

/**
 * Dynamically import and cache a request transform handler function.
 * Supports modules exporting either a default function or a named "transform" function.
 */
export async function loadTransform(
  specifier: string,
  configDir: string = getConfigDir(),
): Promise<RequestTransformFn | null> {
  const resolved = resolveTransformPath(specifier, configDir);
  const existing = transformCache.get(resolved);
  if (existing) return existing;

  const flight = (async (): Promise<RequestTransformFn | null> => {
    try {
      const isFile = existsSync(resolved);
      const importTarget = isFile ? pathToFileURL(resolved).href : resolved;
      const mod = (await import(importTarget)) as RequestTransformModule;
      const fn = mod.transform ?? mod.default;
      if (typeof fn === "function") {
        return fn;
      }
      console.warn(
        `[opencodex] request transform "${specifier}" did not export a default function or "transform" function.`,
      );
      return null;
    } catch (err) {
      console.warn(`[opencodex] failed to load request transform "${specifier}":`, err);
      return null;
    }
  })();

  transformCache.set(resolved, flight);
  return flight;
}

/**
 * Execute all configured global and provider-scoped request transforms sequentially on the request.
 * Operates once per turn and guards against duplicate execution across retries or replays.
 */
export async function applyRequestTransforms(args: {
  parsed: OcxParsedRequest;
  providerName: string;
  modelId: string;
  providerConfig: OcxProviderConfig;
  config: OcxConfig;
}): Promise<OcxParsedRequest> {
  const { parsed, providerName, modelId, providerConfig, config } = args;

  if (parsed._requestTransformsApplied) {
    return parsed;
  }

  const specifiers: string[] = [
    ...(config.requestTransforms ?? []),
    ...(providerConfig.requestTransforms ?? []),
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0);

  if (specifiers.length === 0) {
    parsed._requestTransformsApplied = true;
    return parsed;
  }

  let acceptsImageInput = false;
  try {
    acceptsImageInput = isVisionEligibleModel(config, {
      provider: providerName,
      id: modelId,
    });
  } catch {
    acceptsImageInput = false;
  }

  const context: RequestTransformContext = {
    providerName,
    modelId,
    providerConfig,
    config,
    acceptsImageInput,
  };

  const configDir = getConfigDir();
  let currentParsed = parsed;

  for (const specifier of specifiers) {
    const fn = await loadTransform(specifier, configDir);
    if (!fn) continue;
    try {
      const result = await fn(currentParsed, context);
      if (result && typeof result === "object") {
        if (isValidParsedRequest(result)) {
          currentParsed = result;
        } else {
          console.warn(
            `[opencodex] request transform "${specifier}" returned an invalid request object; retaining current request.`,
          );
        }
      }
    } catch (err) {
      console.warn(`[opencodex] error running request transform "${specifier}":`, err);
    }
  }

  currentParsed._requestTransformsApplied = true;
  return currentParsed;
}

/**
 * Clear the internal transform import cache. Intended for test suite isolation.
 */
export function clearTransformCacheForTests(): void {
  transformCache.clear();
}


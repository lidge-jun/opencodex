import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { expandUserPath, getConfigDir } from "../config/paths";
import { isVisionEligibleModel } from "../vision/eligibility";
import type { RequestTransformContext, RequestTransformFn, RequestTransformModule } from "./types";
import { syncTransformedResponsesBody } from "./responses-body";

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
    typeof candidate.stream === "boolean" &&
    candidate.options !== null &&
    typeof candidate.options === "object" &&
    !Array.isArray(candidate.options) &&
    candidate.context !== null &&
    typeof candidate.context === "object" &&
    !Array.isArray(candidate.context) &&
    Array.isArray((candidate.context as Record<string, unknown>).messages)
  );
}

/** Freeze an isolated configuration snapshot, including nested records and arrays. */
function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeSnapshot(child);
  }
  return value;
}

/** Isolate hook-editable data without detaching shared proxy-owned replay holders. */
function transformCandidate(parsed: OcxParsedRequest): OcxParsedRequest {
  return {
    ...parsed,
    context: structuredClone(parsed.context),
    options: structuredClone(parsed.options),
    _rawBody: structuredClone(parsed._rawBody),
  };
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
    } catch {
      console.warn(`[opencodex] failed to load request transform "${specifier}".`);
      return null;
    }
  })();

  transformCache.set(resolved, flight);
  return flight;
}

/**
 * Execute all configured global and provider-scoped request transforms sequentially on the request.
 * Runs once per parsed request; internal retries that reuse it do not re-run the handlers.
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

  const context: RequestTransformContext = freezeSnapshot(structuredClone({
    providerName,
    modelId,
    providerConfig,
    config,
    acceptsImageInput,
  }));

  const configDir = getConfigDir();
  let currentParsed = parsed;

  for (const specifier of specifiers) {
    const fn = await loadTransform(specifier, configDir);
    if (!fn) continue;
    try {
      const candidate = transformCandidate(currentParsed);
      const result = await fn(candidate, context);
      if (!isValidParsedRequest(result === undefined ? candidate : result)) {
        console.warn(
          `[opencodex] request transform "${specifier}" produced an invalid request; retaining last valid request.`,
        );
        continue;
      }
      // Omitted fields retain their current value; explicit undefined clears them.
      // Proxy-owned holders remain shared rather than being structured-cloned.
      const next = result === undefined ? candidate : { ...candidate, ...result };
      // Synchronization is part of the transaction: a malformed nested edit may throw here.
      syncTransformedResponsesBody(currentParsed, next);
      if (isDeepStrictEqual(next._rawBody, currentParsed._rawBody)) next._rawBody = currentParsed._rawBody;
      currentParsed = next;
    } catch {
      console.warn(`[opencodex] request transform "${specifier}" failed; retaining last valid request.`);
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

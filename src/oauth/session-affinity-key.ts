import { createHash } from "node:crypto";

/** Shared conversation identity precedence; Desktop cohort cache keys never bind sessions. */
export function oauthSessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  clientThreadId?: string | null;
  /** When true, prompt_cache_key is a shared Desktop cohort — ignore it for affinity. */
  promptCacheKeyIsSharedCohort?: boolean;
}): string | null {
  const preferred = input.clientThreadId?.trim()
    || input.sessionIdHeader?.trim()
    || input.threadIdHeader?.trim()
    || "";
  if (preferred) {
    return preferred.length <= 128 ? preferred : createHash("sha256").update(preferred).digest("hex");
  }
  if (input.promptCacheKeyIsSharedCohort) return null;
  const cacheKey = input.promptCacheKey?.trim() ?? "";
  if (!cacheKey) return null;
  return cacheKey.length <= 128 ? cacheKey : createHash("sha256").update(cacheKey).digest("hex");
}

import { readBoundedResponseBody } from "../lib/bounded-body";

const COMMAND_CODE_MODEL_EFFORTS = {
  "deepseek/deepseek-v4-pro": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-pro",
  },
  "deepseek/deepseek-v4-flash": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-flash",
  },
  // Ox Alpha (stealth preview, added in Command Code v1.31.0): free 1M-context
  // reasoning model on every plan. The profile does not publish an effort ladder,
  // so mirror the OpenRouter contract (reasoning mandatory; max/high/low).
  "stealth/ox-alpha": {
    efforts: ["low", "high", "max"],
    profileUrl: "https://commandcode.ai/models/ox-alpha",
  },
  // Keys must match the EXACT upstream /provider/v1/models ids (GLM ships as
  // `zai-org/GLM-5.3`, not `zai-org/glm-5.3`). The table doubles as the router's
  // known-ids decode source (via `knownModelIdsForProvider`), so a case mismatch
  // makes the Codex-facing slug `commandcode/zai-org-GLM-5.3` pass through
  // undecoded and upstream rejects it with `unsupported_model`.
  "zai-org/GLM-5": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5",
  },
  "zai-org/GLM-5.1": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-1",
  },
  "zai-org/GLM-5.2": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-2",
  },
  "zai-org/GLM-5.2-Fast": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-2-fast",
  },
  "zai-org/GLM-5.3": {
    efforts: ["low", "high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-3",
  },
  // Muse Spark: CLI currently prints "has no adjustable reasoning effort" and
  // blocks --effort locally, but the upstream /alpha/generate endpoint accepts
  // reasoning_effort low..max for meta/muse-spark-1.2-contributor (verified
  // 2026-08-13: direct upstream POST with low/medium/high/xhigh/max all 200,
  // ultra 400; reasoningTokens differentiated 114..253; proxy previously stripped
  // the field so effort changes had no effect).
  "meta/muse-spark-1.2": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/meta-muse-spark-1.2",
  },
  "meta/muse-spark-1.2-contributor": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/meta-muse-spark-1.2-contributor",
  },
  "meta/muse-spark-1.1": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/meta-muse-spark-1.1",
  },
} as const;

/**
 * Official Command Code model-profile facts, not a model catalog. Models remain
 * account-scoped and come exclusively from the authenticated /provider/v1/models endpoint.
 */
export const COMMAND_CODE_MODEL_REASONING_EFFORTS: Record<string, string[]> = Object.fromEntries(
  Object.entries(COMMAND_CODE_MODEL_EFFORTS).map(([id, row]) => [id, [...row.efforts]]),
);

const refreshedEfforts = new Map<string, string[]>();

function keyFor(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export function commandCodeReasoningEfforts(modelId: string): readonly string[] | undefined {
  const key = keyFor(modelId);
  const refreshed = refreshedEfforts.get(key);
  if (refreshed !== undefined) return refreshed;
  // Case-insensitive: the table keys match the EXACT upstream ids (e.g. `zai-org/GLM-5.3`),
  // but callers may pass either case.
  for (const [id, efforts] of Object.entries(COMMAND_CODE_MODEL_REASONING_EFFORTS)) {
    if (keyFor(id) === key) return efforts;
  }
  return undefined;
}

function parsedProfileEfforts(page: string): string[] | undefined {
  const match = page.match(/Reasoning efforts\s+([^.;]+?)\s+are supported;\s*([^.]*)/i);
  if (!match) return undefined;
  const listed = match[1]!.toLowerCase().match(/\b(?:low|medium|high|xhigh|max)\b/g) ?? [];
  const mapped = match[2]!.toLowerCase().match(/\b(?:low|medium|high|xhigh|max)\s+maps to\s+(?:low|medium|high|xhigh|max)\b/g) ?? [];
  const normalized = new Set(listed);
  for (const mapping of mapped) {
    const [, source, target] = mapping.match(/(low|medium|high|xhigh|max)\s+maps to\s+(low|medium|high|xhigh|max)/) ?? [];
    if (source && target) {
      normalized.delete(source);
      normalized.add(target);
    }
  }
  return normalized.size > 0 ? [...normalized] : [];
}

/**
 * Refresh one stale effort record only after the upstream rejects an effort request.
 * A failed or unparseable public profile deliberately leaves the known table unchanged.
 */
export async function refreshCommandCodeReasoningEfforts(
  modelId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<readonly string[] | undefined> {
  const key = keyFor(modelId);
  let profile: { efforts: readonly string[]; profileUrl: string } | undefined;
  for (const [id, row] of Object.entries(COMMAND_CODE_MODEL_EFFORTS)) {
    if (keyFor(id) === key) {
      profile = row;
      break;
    }
  }
  if (!profile) return undefined;
  try {
    const response = await fetchFn(profile.profileUrl, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    // Bound the profile page before parsing: a large or malformed page must not
    // allocate unbounded memory on the request path.
    const observed = await readBoundedResponseBody(response, { maxBytes: 256 * 1024 });
    if (!observed.displaySafe) return undefined;
    const efforts = parsedProfileEfforts(observed.text);
    if (efforts === undefined) return undefined;
    refreshedEfforts.set(key, efforts);
    return efforts;
  } catch {
    return undefined;
  }
}

export function resetCommandCodeReasoningEffortsForTest(): void {
  refreshedEfforts.clear();
}

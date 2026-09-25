import { readBoundedResponseBody } from "../lib/bounded-body";

/*
 * Keys must match the EXACT upstream /provider/v1/models ids (GLM ships as `zai-org/GLM-5.3`, not
 * `zai-org/glm-5.3`). The table doubles as the router's known-ids decode source (via
 * `knownModelIdsForProvider`), so a case mismatch makes a Codex-facing slug such as
 * `commandcode/zai-org-GLM-5.3` pass through undecoded and upstream rejects it with
 * `unsupported_model`.
 *
 * PROVENANCE. commandcode.ai renders each /models/<slug> profile client-side, but the delivered HTML
 * carries the loader data as a React Router payload: one `streamController.enqueue("<json>")` call
 * whose JSON is an indexed value table. A model record's `reasoningEfforts` field points at an array
 * of indices that resolve to effort names (for example the 2026-08-29 glm-5-3-flash page resolved
 * 224=low, 225=medium, 226=high, 227=xhigh, 569=max, cross-checked six for six against committed
 * rows). Rows marked "captured 2026-09-23" were read from that payload. On the same date a live
 * `refreshCommandCodeReasoningEfforts` pass reproduced every other row except GLM-5, GLM-5.1 and
 * GLM-5.2-Fast (their payload ladders are empty, so the static rows stay) and the Muse 1.x rows.
 *
 * The profile is Command Code's per-model statement, but /alpha/generate validates effort against
 * one global enum (low..max) and accepts rungs a profile omits: `max` on muse-spark-1.2 and
 * 1.3-contributor, and `high` and `max` on Qwen3.8-Flash, all returned 200 on 2026-09-23 while
 * `ultra` returned 400. A correction therefore adds the rungs a profile newly lists and keeps the
 * rungs the upstream measurably accepts; dropping them would strip an effort that works today,
 * including Codex's default `high`. The refresh path decodes the same payload, so it narrows a row
 * only after the upstream actually rejects a rung.
 */
const COMMAND_CODE_MODEL_EFFORTS = {
  // Captured profile payload 2026-09-23: claude-fable-5-1.html.
  "claude-fable-5-1": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/claude-fable-5-1",
  },
  // Captured profile payload 2026-09-23: claude-opus-5-5.html.
  "claude-opus-5-5": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/claude-opus-5-5",
  },
  "deepseek/deepseek-v4-flash": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-flash",
  },
  "deepseek/deepseek-v4-flash-vision-exp": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-flash-vision-exp",
  },
  // Captured profile payload 2026-09-23: deepseek-v4-flash-fast.html.
  "deepseek/deepseek-v4-flash-fast": {
    efforts: ["low", "high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-flash-fast",
  },
  // Captured profile payload 2026-09-23: deepseek-v4-1-flash.html.
  "deepseek/deepseek-v4.1-flash": {
    efforts: ["low", "high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-1-flash",
  },
  "gpt-5.6-luna": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/gpt-5-6-luna",
  },
  "google/gemini-3.7-flash": {
    efforts: ["low", "medium", "high"],
    profileUrl: "https://commandcode.ai/models/gemini-3-7-flash",
  },
  // Captured profile payload 2026-09-23: gemini-3-8-flash.html.
  "google/gemini-3.8-flash": {
    efforts: ["low", "medium", "high"],
    profileUrl: "https://commandcode.ai/models/gemini-3-8-flash",
  },
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
  "z-ai/glm-5.3-flash": {
    efforts: ["low", "high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-3-flash",
  },
  // Captured profile payload 2026-09-23: glm-5-3-flashx.html.
  "z-ai/glm-5.3-flashx": {
    efforts: ["low", "high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-3-flashx",
  },
  // Captured profile payload 2026-09-23: muse-spark-1-3.html.
  // Muse Spark: the Command Code CLI prints "has no adjustable reasoning effort", but /alpha/generate
  // accepts reasoning_effort for these routes (verified 2026-08-13 on 1.2-contributor: low..max 200,
  // ultra 400), so the table, not the CLI, is the ladder authority.
  "meta/muse-spark-1.3": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/muse-spark-1-3",
  },
  // Captured profile payload 2026-09-23 lists low..xhigh; max stays because /alpha/generate accepts it.
  "meta/muse-spark-1.3-contributor": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/muse-spark-1-3-contributor",
  },
  "meta/muse-spark-1.2": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/muse-spark-1-2",
  },
  "meta/muse-spark-1.2-contributor": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/muse-spark-1-2-contributor",
  },
  "meta/muse-spark-1.1": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/muse-spark-1-1",
  },
  // Captured profile payload 2026-09-23 lists low, medium, xhigh; high and max stay because
  // /alpha/generate accepts both (measured 2026-09-11 and 2026-09-23).
  "Qwen/Qwen3.8-Flash": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/qwen3-8-flash",
  },
  // Captured profile payload 2026-09-23: qwen3-8-omni-flash.html.
  "Qwen/Qwen3.8-Omni-Flash": {
    efforts: ["low", "medium", "xhigh"],
    profileUrl: "https://commandcode.ai/models/qwen3-8-omni-flash",
  },
  // Captured profile payload 2026-09-23: qwen3-8-max-0902.html.
  "Qwen/Qwen3.8-Max-0902": {
    efforts: ["low", "medium", "xhigh"],
    profileUrl: "https://commandcode.ai/models/qwen3-8-max-0902",
  },
  // Captured profile payload 2026-09-23: step-5-preview.html.
  "stepfun/Step-5-Preview": {
    efforts: ["low", "medium", "high"],
    profileUrl: "https://commandcode.ai/models/step-5-preview",
  },
  // Captured profile payload 2026-09-23: hy4-preview.html.
  "tencent/hy4-preview": {
    efforts: ["low", "medium", "high"],
    profileUrl: "https://commandcode.ai/models/hy4-preview",
  },
  // Captured profile payload 2026-09-23: grok-4-7.html.
  "xai/grok-4.7": {
    efforts: ["low", "medium", "high", "xhigh"],
    profileUrl: "https://commandcode.ai/models/grok-4-7",
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
const rejectedEfforts = new Map<string, Set<string>>();
const DEFAULT_EFFORT_DESTINATION = "https://api.commandcode.ai";

function keyFor(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function cacheKey(modelId: string, destination: string): string {
  let normalized = destination.trim().replace(/\/+$/, "");
  try {
    const url = new URL(destination);
    normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch { /* Config validation owns malformed destinations. */ }
  return JSON.stringify([normalized, keyFor(modelId)]);
}

export function commandCodeReasoningEfforts(
  modelId: string,
  destination = DEFAULT_EFFORT_DESTINATION,
): readonly string[] | undefined {
  const key = cacheKey(modelId, destination);
  const rejected = rejectedEfforts.get(key);
  const refreshed = refreshedEfforts.get(key);
  if (refreshed !== undefined) return rejected ? refreshed.filter(effort => !rejected.has(effort)) : refreshed;
  // Case-insensitive: the table keys match the EXACT upstream ids (e.g. `zai-org/GLM-5.3`),
  // but callers may pass either case.
  for (const [id, efforts] of Object.entries(COMMAND_CODE_MODEL_REASONING_EFFORTS)) {
    if (keyFor(id) === keyFor(modelId)) return rejected ? efforts.filter(effort => !rejected.has(effort)) : efforts;
  }
  return undefined;
}

/** Upper bound for one fetched profile page. */
export const PROFILE_PAGE_MAX_BYTES = 512 * 1024;

const PROFILE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function parsedRouterEfforts(page: string, modelId: string): string[] | undefined {
  // React Router serializes the loader as a JSON string of an indexed value table.
  // Object keys such as _125 and array elements are references into that table.
  const flights = [...page.matchAll(/window\.__reactRouterContext\.streamController\.enqueue\(("(?:\\.|[^"\\])*")\);/g)];
  if (flights.length !== 1) return undefined;
  let values: unknown;
  try {
    values = JSON.parse(JSON.parse(flights[0]![1]!));
  } catch {
    return undefined;
  }
  if (!Array.isArray(values)) return undefined;
  const table: unknown[] = values;
  const dereference = (ref: unknown): unknown =>
    Number.isInteger(ref) && (ref as number) >= 0 && (ref as number) < table.length
      ? table[ref as number] : undefined;
  let matched: string[] | undefined;
  for (const value of table) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const fields = new Map<string, unknown>();
    let conflicting = false;
    for (const [key, ref] of Object.entries(value)) {
      if (!/^_\d+$/.test(key)) continue;
      const name = dereference(Number(key.slice(1)));
      if (typeof name !== "string") continue;
      // Two keys decoding to one field name is not a record this parser understands.
      if (fields.has(name)) conflicting = true;
      fields.set(name, ref);
    }
    if (conflicting && (fields.has("id") || fields.has("reasoningEfforts"))) return undefined;
    const id = dereference(fields.get("id"));
    if (typeof id !== "string" || keyFor(id) !== keyFor(modelId)) continue;
    const refs = dereference(fields.get("reasoningEfforts"));
    if (!Array.isArray(refs) || refs.length === 0) return undefined;
    const efforts = refs.map(dereference);
    if (efforts.some(effort => typeof effort !== "string" || !PROFILE_EFFORTS.has(effort)) ||
        new Set(efforts).size !== efforts.length) return undefined;
    const complete = efforts as string[];
    if (matched && JSON.stringify(matched) !== JSON.stringify(complete)) return undefined;
    matched = complete;
  }
  return matched;
}

function parsedProfileEfforts(page: string, modelId: string): string[] | undefined {
  if (page.includes("window.__reactRouterContext.streamController.enqueue(")) {
    return parsedRouterEfforts(page, modelId);
  }
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
  rejectedEffort?: string,
  destination = DEFAULT_EFFORT_DESTINATION,
): Promise<readonly string[] | undefined> {
  const key = cacheKey(modelId, destination);
  let profile: { efforts: readonly string[]; profileUrl: string } | undefined;
  for (const [id, row] of Object.entries(COMMAND_CODE_MODEL_EFFORTS)) {
    if (keyFor(id) === keyFor(modelId)) {
      profile = row;
      break;
    }
  }
  if (!profile) return undefined;
  if (rejectedEffort) {
    const rejected = rejectedEfforts.get(key) ?? new Set<string>();
    rejected.add(rejectedEffort);
    rejectedEfforts.set(key, rejected);
  }
  try {
    const response = await fetchFn(profile.profileUrl, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    // Bound the profile page before parsing: a large or malformed page must not
    // allocate unbounded memory on the request path. Live profiles measured 240-259 KB on
    // 2026-09-23, so the cap leaves room for growth; a truncated page fails to parse and keeps
    // the static row.
    const observed = await readBoundedResponseBody(response, { maxBytes: PROFILE_PAGE_MAX_BYTES });
    if (!observed.displaySafe) return undefined;
    const efforts = parsedProfileEfforts(observed.text, modelId);
    if (efforts === undefined) return undefined;
    const accepted = commandCodeReasoningEfforts(modelId, destination) ?? [];
    const merged = [...new Set([...accepted, ...efforts])]
      .filter(effort => !rejectedEfforts.get(key)?.has(effort));
    refreshedEfforts.set(key, merged);
    return merged;
  } catch {
    return undefined;
  }
}

export function resetCommandCodeReasoningEffortsForTest(): void {
  refreshedEfforts.clear();
  rejectedEfforts.clear();
}

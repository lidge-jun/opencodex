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
  /*
   * Three live routes that reached the catalog without an effort ladder (#2647).
   * Without a row here the model advertises no efforts at all, so a client that
   * sends one gets it stripped or rejected rather than honored.
   *
   * PROVENANCE, stated plainly: these three ladders are the reporter's
   * (darwintree, #2647), recorded as reported and NOT independently verified.
   * All three profileUrls return HTTP 200, but commandcode.ai renders these
   * pages client-side and ships the ladder inside a serialized React payload
   * whose `reasoningEfforts` array is EMPTY in the delivered HTML. There is no
   * fetchable statement of these ladders to check them against.
   *
   * Do not assume the refresh path launders this. It does not:
   * `parsedProfileEfforts` below matches prose of the form
   * "Reasoning efforts ... are supported;", and `grep -c -i 'reasoning efforts'`
   * against the live pages returns 0 — for these three AND for the older rows
   * (deepseek-v4-pro, GLM-5.3, muse-spark-1.2 all measured 0 on 2026-08-27).
   * So `refreshCommandCodeReasoningEfforts` returns undefined and the caller
   * keeps whatever is written here, indefinitely. The self-correction mechanism
   * is currently dead for EVERY row in this table, which is a pre-existing
   * defect worth its own fix (teach the parser to read the embedded payload),
   * not something these three rows introduced.
   *
   * The practical consequence: a wrong ladder here stays wrong until a human
   * changes it. It degrades safely — an effort the upstream rejects surfaces as
   * an error rather than silent corruption — but it does not self-heal.
   */
  "deepseek/deepseek-v4-flash-vision-exp": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-flash-vision-exp",
  },
  "gpt-5.6-luna": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/gpt-5-6-luna",
  },
  "google/gemini-3.7-flash": {
    efforts: ["low", "medium", "high"],
    profileUrl: "https://commandcode.ai/models/gemini-3-7-flash",
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
  /*
   * GLM-5.3-Flash (#2883). Reported as advertising NO efforts at all: the live
   * route is `z-ai/glm-5.3-flash`, which shares neither vendor prefix nor model
   * id with `zai-org/GLM-5.3` above, so `modelRecordValue` cannot bridge them
   * (exact / colon-family / case-folded only — by design; a substring match here
   * would merge two genuinely different models across two vendor namespaces).
   *
   * PROVENANCE: unlike the #2647 rows above, this ladder is MEASURED, not
   * reported. commandcode.ai renders the profile client-side, but the delivered
   * HTML ships a serialized React payload whose string table can be read
   * directly: in the 2026-08-29 fetch of /models/glm-5-3-flash (HTTP 200,
   * 228749 bytes) the indices resolve as 224=low, 225=medium, 226=high,
   * 227=xhigh, 569=max, and this model's array is [224,226,569].
   *
   * The index map was cross-validated against every row in this table that the
   * same page carries: deepseek-v4-pro and -flash [226,569], gpt-5.6-luna
   * [224,225,226,227,569], gemini-3.7-flash [224,225,226], GLM-5.2 [226,569],
   * GLM-5.3 [224,226,569] — six for six against the values already committed
   * here. No authenticated upstream generate probe was performed.
   */
  "z-ai/glm-5.3-flash": {
    efforts: ["low", "high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-3-flash",
  },
  // Muse Spark: CLI currently prints "has no adjustable reasoning effort" and
  // blocks --effort locally, but the upstream /alpha/generate endpoint accepts
  // reasoning_effort low..max for meta/muse-spark-1.2-contributor (verified
  // 2026-08-13: direct upstream POST with low/medium/high/xhigh/max all 200,
  // ultra 400; reasoningTokens differentiated 114..253; proxy previously stripped
  // the field so effort changes had no effect).
  //
  // 1.3 shipped 2026-09-02 as the same-shaped successor to 1.2 (Command Code
  // publishes meta/muse-spark-1.3 and meta/muse-spark-1.3-contributor alongside
  // the 1.2 pair, and Zen serves muse-spark-1.3-contributor over the same
  // /responses wire). It carries the 1.2 ladder because it IS the 1.2 spec: the
  // upstream ladder statement is per-family, and a narrower guess here would
  // strip an effort the gateway accepts. Additive — 1.2 and 1.1 stay live.
  "meta/muse-spark-1.3": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/meta-muse-spark-1.3",
  },
  "meta/muse-spark-1.3-contributor": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/meta-muse-spark-1.3-contributor",
  },
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

/**
 * Dependency-free JEV decision-service contract shared by the server and the dashboard bundle.
 * Keep it import-free: `gui/` imports it directly, so anything added here ships to the browser.
 */

/** Canonical TypeSafe decision service; valid as `decisionProvider` even without a provider row. */
export const CANONICAL_JEV_DECISION_PROVIDER = "jev";
export const JEV_DECISION_TIMEOUT_MIN_MS = 1_000;
export const JEV_DECISION_TIMEOUT_MAX_MS = 120_000;
/** Decision deadline when a combo sets no `decisionTimeoutMs`. */
export const JEV_DECISION_TIMEOUT_DEFAULT_MS = 4_000;

/** Whether a self-hosted decision endpoint follows the documented Jev `/systemone` path. */
export function isSystemOneEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).pathname.replace(/\/+$/, "").endsWith("/systemone");
  } catch {
    return false;
  }
}

/**
 * Quota tiers a quota-aware JEV decision (`decisionQuotaSignals: true`) may attach to a target,
 * worst relevant window first: under 70% used, 70% to under 90%, and 90% or more.
 */
export const JEV_QUOTA_TIERS = ["healthy", "limited", "nearly_exhausted"] as const;
export type JevQuotaTier = (typeof JEV_QUOTA_TIERS)[number];

/** JEV decision modes: `route` asks for target and effort together, `level` asks only for a demand level. */
export const JEV_DECISION_MODES = ["route", "level"] as const;
export type JevDecisionMode = (typeof JEV_DECISION_MODES)[number];

/** Selection within a classified level: `order` takes the first usable candidate, `route` asks the backend. */
export const JEV_LEVEL_SELECTS = ["order", "route"] as const;
export type JevLevelSelect = (typeof JEV_LEVEL_SELECTS)[number];

/** Outcome of `route` selection: the routed pick applied, or the `order` pick was kept. */
export const JEV_LEVEL_SELECT_PATHS = ["route", "order_fallback"] as const;
export type JevLevelSelectPath = (typeof JEV_LEVEL_SELECT_PATHS)[number];

/** Demand levels a level-mode decision classifies the next model call into, in canonical order. */
export const JEV_LEVEL_IDS = ["trivial", "routine", "hard", "deep", "agentic_heavy", "agentic_light"] as const;
export type JevLevelId = (typeof JEV_LEVEL_IDS)[number];

/** Level used when the classified level has no usable candidate and no `decisionFallbackLevel` is set. */
export const JEV_DEFAULT_FALLBACK_LEVEL: JevLevelId = "routine";

/** Built-in level criteria, validated against a labelled routing eval; a level `description` overrides one. */
export const JEV_LEVEL_DEFAULT_DESCRIPTIONS: Record<JevLevelId, string> = {
  trivial: "A quick lookup, one-line answer, tiny mechanical edit, or reporting a simple tool result.",
  routine: "An ordinary, well-scoped coding or writing task: one function or file, small feature, tests, config, a review of a small diff.",
  hard: "A hard engineering problem: concurrency bugs, races, leaks, crashes, performance, security fixes, large refactors or migrations that must stay correct.",
  deep: "Deep design or analysis with no code yet: architecture, distributed-systems protocols, proofs, threat models, long careful reports.",
  agentic_heavy: "A long multi-step job in a terminal: set up, upgrade, build, run, debug and iterate many times until everything passes.",
  agentic_light: "A short command run: run tests or a script once, start a server, check status, and report the output.",
};

/** Upper bound on candidates in one level; each must name a distinct target and effort pair. */
export const JEV_LEVEL_MAX_CANDIDATES = 32;

/**
 * How a level-mode selection ended: `chosen` used the classified level, `fallback_level` the
 * fallback level, and `fail_open` the first eligible target (no usable candidate, or no decision).
 */
export const JEV_LEVEL_PATHS = ["chosen", "fallback_level", "fail_open"] as const;
export type JevLevelPath = (typeof JEV_LEVEL_PATHS)[number];

/** Level-mode instructions sent with the `level` choice question. */
export const JEV_LEVEL_INSTRUCTIONS = "Classify how demanding the work for the next model call is. Judge from the task and any tool evidence.";

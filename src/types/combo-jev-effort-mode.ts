/**
 * Who owns the wire effort on a JEV combo (`jevEffortMode` in config.json).
 *
 * `decide` (default) lets the decision set the effort and override the caller, which is what
 * a capability-routing combo wants. `client` takes only the decision's target choice and
 * leaves effort to ordinary Combo policy (caller effort, target ladder, `defaultEffort` and
 * `defaultEffortMode`), for providers that must hold one tier to keep their prompt cache
 * warm: one whose effort swaps the upstream model id per tier pays a cache miss on every
 * re-tier. Rationale: `structure/decisions/ADR-8041-jev-effort-mode.md`.
 */
export type OcxComboJevEffortMode = "decide" | "client";

export const MULTI_AGENT_MODE_HINT_RECOMMENDATION = {
  revision: "proactive-trigger-v1",
  text: [
    "Proactive multi-agent delegation is active.",
    "Only the delegation trigger changes: a separate explicit request is no longer required.",
    "All existing user, authority, task-scope, and collaboration-tool rules continue to apply.",
    "Delegate eligible independent work when parallel execution could materially improve speed or quality.",
    "User requests override this hint.",
    "This mode remains active until a later multi-agent mode developer message changes it.",
  ].join(" "),
} as const;

/** Byte-exact presets previously written by OpenCodex dashboard releases. */
export const LEGACY_OPENCODEX_MODE_HINTS = [
  "Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies. Use sub-agents when parallel work would materially improve speed or quality. This mode remains active until a later multi-agent mode developer message changes it.",
  "Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies. Delegate independent sub-tasks to sub-agents whenever parallel work would materially improve speed or quality — do not serialize work that can run concurrently. Each sub-agent runs in its own context and can use all available tools; prefer spawning specialists over doing everything yourself. This mode remains active until a later multi-agent mode developer message changes it.",
] as const;

/** Upgrade only known OpenCodex-owned values; user-authored variants stay byte-identical. */
export function canonicalizeOpenCodexModeHint(text: string): string {
  return LEGACY_OPENCODEX_MODE_HINTS.some(legacy => legacy === text)
    ? MULTI_AGENT_MODE_HINT_RECOMMENDATION.text
    : text;
}

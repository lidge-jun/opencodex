/** Whitelisted usage fields from the October 2026 shape; no account or credential data. */
export const weeklyReset = "2026-11-05T14:59:59Z";
export const legacyMax20xUsage = {
  five_hour: { utilization: 12, resets_at: "2026-11-01T12:00:00Z" },
  seven_day: { utilization: 53, resets_at: weeklyReset },
  seven_day_fable: { utilization: 0, resets_at: weeklyReset },
};
export const ultraUsage = {
  five_hour: null,
  seven_day: { utilization: 53, resets_at: weeklyReset },
  limits: [
    { kind: "weekly_all", percent: 53, resets_at: weeklyReset, is_active: true },
    { kind: "weekly_scoped", percent: 0, resets_at: weeklyReset, is_active: false,
      scope: { model: { display_name: "Fable" } } },
  ],
};
export const inactiveSessionUsage = {
  five_hour: { utilization: 0, resets_at: null },
  seven_day: { utilization: 100, resets_at: weeklyReset },
  limits: [
    { kind: "session", percent: 0, resets_at: null, is_active: false },
    { kind: "weekly_all", percent: 100, resets_at: weeklyReset, is_active: true },
    { kind: "weekly_scoped", percent: 0, resets_at: weeklyReset, is_active: false,
      scope: { model: { display_name: "Fable" } } },
  ],
};
export const noResetGrant = {
  eligible: false, ineligible_reason: "no_grant", grants: [],
  weekly_resets_at: weeklyReset, cooldown_until: null, next_grant_id: null,
  event_props: { tier: "claude_max_20x", billing: "google_play" },
};

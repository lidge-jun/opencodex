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

export const maxTeamInactiveWeeklyUsage = {
  five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 55, resets_at: weeklyReset },
  limits: [{ kind: "session", percent: 0, resets_at: null, is_active: true },
    { kind: "weekly_all", percent: 55, resets_at: weeklyReset, is_active: false }],
};
export const maxTeamInactiveSessionUsage = {
  five_hour: { utilization: 40, resets_at: weeklyReset }, seven_day: { utilization: 56, resets_at: weeklyReset },
  limits: [{ kind: "session", percent: 40, resets_at: weeklyReset, is_active: false },
    { kind: "weekly_all", percent: 56, resets_at: weeklyReset, is_active: true }],
};
/**
 * A Max account whose binding limit is the shared week, as Claude's usage endpoint returned it in
 * November 2026 (values verbatim, identifiers absent). Fable is reported only as an inactive scoped
 * row with no legacy `seven_day_fable` key, and `weekly_scoped_shares` names its allowance.
 */
export const inactiveFableSessionReset = "2026-11-10T16:29:59Z";
export const inactiveFableWeeklyReset = "2026-11-15T09:59:59Z";
export const inactiveFableShareUsage = {
  five_hour: { utilization: 35.0, resets_at: inactiveFableSessionReset, limit_dollars: null, used_dollars: null,
    remaining_dollars: null, locked_reason: null },
  seven_day: { utilization: 91.0, resets_at: inactiveFableWeeklyReset, limit_dollars: null, used_dollars: null,
    remaining_dollars: null, locked_reason: null },
  seven_day_opus: null, seven_day_sonnet: null, seven_day_oauth_apps: null, seven_day_cowork: null,
  limits: [
    { kind: "session", group: "session", percent: 35, severity: "normal", resets_at: inactiveFableSessionReset,
      scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 91, severity: "critical", resets_at: inactiveFableWeeklyReset,
      scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 4, severity: "normal", resets_at: inactiveFableWeeklyReset,
      scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ],
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 2, allowance_percent_of_weekly: 50 }],
  extra_usage: { is_enabled: false },
  spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 }, percent: 0, enabled: false },
  member_dashboard_available: false,
};

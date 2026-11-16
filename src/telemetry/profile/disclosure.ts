/**
 * The public-profile disclosure, printed by `ocx telemetry profile connect` before its [y/N] prompt
 * and mirrored by the dashboard card. Separate from the anonymous telemetry disclosure: connecting
 * a profile is its own consent.
 */
export const PROFILE_DISCLOSURE_HEADING = "Public usage profile (opt-in, off unless you connect it):";

export const PROFILE_DISCLOSURE_POINTS: readonly string[] = Object.freeze([
  "Public: the handle, display name and avatar colour you choose, your rank, and your daily request and token totals and model-family totals.",
  "Sent once per completed UTC day after today, only while anonymous telemetry is on: those totals and nothing else.",
  "Never sent: prompts, responses, API keys, account ids or e-mails, provider names, URLs, file paths, or your anonymous telemetry id.",
  "Leaderboard: opencodex.me/dashboard lists connected profiles only. Disconnect any time (dashboard Home or 'ocx telemetry profile disconnect'); that deletes the profile and all its data on the server.",
]);


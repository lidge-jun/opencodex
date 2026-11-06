/*
 * Which dashboard someone chose: the current one at /, or the classic (pre-redesign) one at
 * /classic/. The choice is remembered per browser so the desktop app and bookmarks keep opening
 * the same one: index.html reads this key before first paint and forwards to /classic/.
 */
export const DASHBOARD_EDITION_KEY = "ocx-ui";

export type DashboardEdition = "current" | "classic";

export function switchDashboardEdition(edition: DashboardEdition): void {
  try {
    localStorage.setItem(DASHBOARD_EDITION_KEY, edition);
  } catch {
    // Storage blocked: the switch still happens, it just is not remembered.
  }
  window.location.assign(edition === "classic" ? "/classic/" : "/");
}

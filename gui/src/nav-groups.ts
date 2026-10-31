/**
 * The sidebar's rows, in order.
 *
 * A row is a navigation group, not a page. Most rows hold one page; Subagents, Usage & Logs
 * and Remote Link each hold several existing pages, reached through the section switcher
 * App renders above the page. Grouping changes no route: every member keeps the hash it
 * always had, so bookmarks and deep links still open the same page, and the row that
 * owns that page lights up.
 *
 * The first member is the row's destination. Order is the contract: Usage opens first
 * inside Usage & Logs because it leads that list.
 *
 * `embedded` pages belong to a row without being switcher members: Claude lives as a tab
 * inside the Connect page, keeps its own #claude/* hashes, and lights Connect up.
 */
import type { Page } from "./app-routing";
import type { TKey } from "./i18n/shared";
import { IconActivity, IconBot, IconBoxes, IconCodex, IconGrid, IconLink } from "./icons";

export type NavGroupId =
  | "home"
  | "models"
  | "accounts"
  | "usage-logs"
  | "setup"
  | "advanced";

/**
 * Design system v2 sorts every row by how often people touch it: things changed or checked
 * every day, things done once while installing, and fine-tuning most people never open.
 * The sidebar prints one heading per tier, in this order.
 */
export type NavTier = "daily" | "setup" | "advanced";

export const NAV_TIERS: readonly { tier: NavTier; tkey: TKey }[] = [
  { tier: "daily", tkey: "shellV2.tierDaily" },
  { tier: "setup", tkey: "shellV2.tierSetup" },
  { tier: "advanced", tkey: "shellV2.tierAdvanced" },
];

export interface NavGroup {
  id: NavGroupId;
  tier: NavTier;
  tkey: TKey;
  Icon: typeof IconGrid;
  pages: readonly [Page, ...Page[]];
  embedded?: readonly Page[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "home", tier: "daily", tkey: "shellV2.navHome", Icon: IconGrid, pages: ["home"] },
  { id: "models", tier: "daily", tkey: "nav.models", Icon: IconBoxes, pages: ["models"] },
  // Codex's account pool and every provider's quota answer the same daily question —
  // "which account is serving me and how much is left" — so they share one row.
  { id: "accounts", tier: "daily", tkey: "shellV2.navAccounts", Icon: IconCodex, pages: ["codex-set", "providers"] },
  { id: "usage-logs", tier: "daily", tkey: "nav.usageLogs", Icon: IconActivity, pages: ["usage", "logs", "storage"] },
  // Everything done once: the checklist, connecting apps (Claude lives as a Connect tab),
  // start-at-login protection and linking other computers.
  {
    id: "setup", tier: "setup", tkey: "shellV2.navSetup", Icon: IconLink,
    pages: ["setup", "integrations", "startup", "remote", "remote-workspace"], embedded: ["claude"],
  },
  // The Advanced hub lists every fine-tuning surface; the old dashboard (sidecars, memory,
  // compaction, updates) and the helper-agent pages are its switcher members.
  { id: "advanced", tier: "advanced", tkey: "shellV2.navAdvanced", Icon: IconBot, pages: ["advanced", "dashboard", "subagents", "advisor"] },
];

/** The row that owns a page, or null for a page outside the sidebar. */
export function groupForPage(page: Page): NavGroup | null {
  return NAV_GROUPS.find(group => group.pages.includes(page) || group.embedded?.includes(page)) ?? null;
}

/**
 * Members the switcher may offer right now. Remote Workspace exists only while a hub
 * exposes it; a bookmark to it still opens its own recovery notice, but the switcher
 * does not advertise a page that cannot load.
 */
export function visibleGroupPages(group: NavGroup, opts: { remoteWorkspaceAvailable: boolean }): Page[] {
  return group.pages.filter(page => page !== "remote-workspace" || opts.remoteWorkspaceAvailable);
}

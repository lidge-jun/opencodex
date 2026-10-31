/**
 * The sidebar's rows, in order.
 *
 * A row is a navigation group, not a page. Most rows hold one page; Accounts, Usage & Logs,
 * Connect and Remote Link each hold several existing pages, reached through the section switcher
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
import { IconActivity, IconBot, IconBoxes, IconCodex, IconGrid, IconLink, IconList, IconMonitor, IconPower, IconServer, IconStar } from "./icons";

export type NavGroupId =
  | "home"
  | "models"
  | "accounts"
  | "subagents"
  | "usage-logs"
  | "connect"
  | "startup"
  | "remote"
  | "proxy"
  | "advisor"
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
  // Which model a helper agent runs on is changed as often as the main model.
  { id: "subagents", tier: "daily", tkey: "nav.subagents", Icon: IconBot, pages: ["subagents"] },
  { id: "usage-logs", tier: "daily", tkey: "nav.usageLogs", Icon: IconActivity, pages: ["usage", "logs", "storage"] },
  // Done once, but each still gets its own row: a setting two clicks deep behind a hub is a
  // setting people cannot find. Claude lives as a Connect tab; the checklist sits beside it.
  { id: "connect", tier: "setup", tkey: "nav.connect", Icon: IconLink, pages: ["integrations", "setup"], embedded: ["claude"] },
  { id: "startup", tier: "setup", tkey: "nav.startup", Icon: IconPower, pages: ["startup"] },
  { id: "remote", tier: "setup", tkey: "nav.remote", Icon: IconMonitor, pages: ["remote", "remote-workspace"] },
  // Fine-tuning keeps its surfaces visible too; the All settings hub is the searchable index
  // of every one of them, including the ones that live inside other pages.
  { id: "proxy", tier: "advanced", tkey: "shellV2.pageProxyDetails", Icon: IconServer, pages: ["dashboard"] },
  { id: "advisor", tier: "advanced", tkey: "nav.advisor", Icon: IconStar, pages: ["advisor"] },
  { id: "advanced", tier: "advanced", tkey: "shellV2.pageAllSettings", Icon: IconList, pages: ["advanced"] },
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

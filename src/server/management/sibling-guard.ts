import { siblingOfLivePort } from "../../codex/sibling-start";
import { CODEX_RESTART_PATH } from "../../lib/codex-restart-contract";

/**
 * Management mutations a sibling instance refuses (`src/codex/sibling-start.ts`).
 *
 * The owner-level gates stop the writers a sibling reaches on its own: startup sync, catalog
 * convergence, owned-catalog refresh, the Claude roster, system env and the stop teardown. These
 * routes reach shared client state through paths those gates do not cover, so the sibling's own
 * management API refuses them outright: toggling or stripping the live owner's Codex, Grok or Claude
 * integrations, rewriting client files at this port, the Codex prompt layers and `[features]`
 * written into the shared `config.toml`, killing the user's Codex app-servers, joining a link (which
 * writes the shared catalog and restarts as a client), staging or switching the physical native-main
 * login, baking the machine service, PATH shim or tray from this home, replacing the global package
 * (the live proxy drains on its package-tree refresh), Codex's own log database, and the
 * archived-session cleanup, cleanup-policy run and trash restore that rewrite the shared CODEX_HOME.
 *
 * Everything else stays open: every read, `POST /api/stop`, `POST /api/system/restart`, and the
 * own-home mutations (providers, keys, settings). `PUT /api/settings` is allowed because it carries
 * own-home settings; its shared fan-out is gated in `syncEnabledClientIntegrations`. So is
 * `PUT /api/storage/cleanup-policy`; the scheduled runs it enables stand down in
 * `maybeRequestStorageCleanupPolicyRun` (`src/storage/policy-job.ts`).
 *
 * Paths are compared through this table and a variable, never as a quoted pathname equality:
 * `tests/helpers/management-route-scan.ts` reads that form as a route declaration, and this file
 * declares no route of its own.
 */
export const SIBLING_REFUSED_MANAGEMENT_PATHS: readonly { readonly path: string; readonly children: boolean }[] = [
  { path: "/api/sync", children: false },
  { path: "/api/client-integrations", children: true },
  { path: "/api/native-integrations", children: true },
  { path: "/api/claude-desktop", children: true },
  { path: "/api/claude-code", children: false },
  { path: "/api/grok/apply", children: false },
  { path: "/api/grok/selection", children: false },
  { path: "/api/codex-prompt", children: true },
  { path: CODEX_RESTART_PATH, children: false },
  { path: "/api/link/join", children: false },
  { path: "/api/native-main-profiles", children: true },
  { path: "/api/codex-auth/main", children: true },
  { path: "/api/startup-action", children: false },
  { path: "/api/windows-tray", children: false },
  { path: "/api/update/run", children: false },
  { path: "/api/v2", children: false },
  { path: "/api/codex-auth/features", children: true },
  { path: "/api/storage/codex-logs", children: true },
  // Archived-session cleanup, its policy run and trash restore rewrite the shared CODEX_HOME.
  { path: "/api/storage/cleanup", children: false },
  { path: "/api/storage/cleanup-policy/run", children: false },
  { path: "/api/storage/trash/restore", children: false },
];

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** True when this process is a sibling and the request would mutate shared client state. */
export function siblingRefusesManagementRequest(method: string, pathname: string): boolean {
  if (siblingOfLivePort() === null || READ_METHODS.has(method.toUpperCase())) return false;
  return SIBLING_REFUSED_MANAGEMENT_PATHS.some(entry =>
    pathname === entry.path || (entry.children && pathname.startsWith(`${entry.path}/`)));
}

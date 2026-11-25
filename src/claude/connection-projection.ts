/**
 * Read-only Claude rows of the Connections view (catch-up 010, G-001/G-002).
 *
 * One Claude Code row per registered home (the default `claudeConfigDir` plus the explicit
 * `claudeCode.extraConfigDirs`; nothing is discovered on disk) and one Claude Desktop row. The
 * first-party switch acts on the default home only, so only that row carries an intent, drift
 * and a switch-off preview; extra homes report what their settings.json routes to.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeDesktopIntegrationEnabled } from "../codex/desired-state";
import type { ConnectionDriftReason, ConnectionObserved, ConnectionOwner, ConnectionView } from "../integrations/connection-view";
import { displayPath } from "../lib/display-path";
import type { OcxConfig } from "../types";
import { registeredClaudeConfigDirs } from "./auth-detect";
import { inspectDesktop3pConfigLibrary } from "./desktop-3p";
import { inspectDesktopFirstParty, observeClaudeDesktopMode, resolveClaudeDesktopMode } from "./desktop-first-party";
import { previewClaudeFirstPartySettings } from "./first-party-preview";
import { firstPartyDesired, firstPartyProxyStatus } from "./first-party-settings";
import { claudeInterceptEnabled } from "./intercept/runtime";

export interface ClaudeConnectionInput {
  live: OcxConfig;
  /** The persisted config the first-party switch transitions (for the switch-off preview). */
  persisted: OcxConfig;
  /** The intercept listener this process has bound, or null. */
  boundProxyPort: number | null;
  env?: NodeJS.ProcessEnv;
  opencodexConfigDir?: string;
}

function claudeCodeRow(input: ClaudeConnectionInput, dir: string, source: "default" | "extra"): ConnectionView {
  const { live } = input;
  const options = { claudeConfigDir: dir, ...(input.opencodexConfigDir ? { opencodexConfigDir: input.opencodexConfigDir } : {}) };
  const settingsPath = join(dir, "settings.json");
  const settings = inspectDesktopFirstParty(live, options).settings;
  const observed: ConnectionObserved = settings.kind === "unreadable" ? "unknown"
    : settings.kind === "foreign" ? "foreign"
      : settings.kind === "applied" || settings.kind === "stale" ? "proxy"
        : existsSync(settingsPath) ? "native" : "missing";
  const owner: ConnectionOwner = observed === "foreign" ? "external"
    : observed === "proxy" ? "opencodex" : observed === "unknown" ? "unknown" : "none";
  const base = {
    client: "claude-code" as const,
    home: displayPath(dir),
    homeSource: source,
    configPath: displayPath(settingsPath),
    observed,
    owner,
    ...(owner === "external" ? { ownerPath: displayPath(settingsPath) } : {}),
  };
  if (source === "extra") return { ...base, desired: "unset", driftReasons: [] };

  const cli = live.claudeCode?.cliFirstParty === true;
  const wanted = firstPartyDesired(live, observeClaudeDesktopMode(live, options));
  const eligible = claudeInterceptEnabled(live);
  const status = firstPartyProxyStatus({ settings, boundProxyPort: input.boundProxyPort, eligible });
  const driftReasons: ConnectionDriftReason[] = [];
  if (owner === "external") driftReasons.push("external_owner");
  if (cli && !eligible) driftReasons.push("intercept_disabled");
  if ((cli || wanted.desktop) && (status === "stopped" || status === "broken")) driftReasons.push("pending_restart");
  if (owner !== "external" && ((cli && (observed === "native" || observed === "missing"))
    || (!wanted.cli && !wanted.desktop && observed === "proxy"))) driftReasons.push("file_edited");

  const view: ConnectionView = { ...base, desired: cli ? "proxy" : "native", driftReasons };
  if (cli) {
    const preview = previewClaudeFirstPartySettings({ live, persisted: input.persisted, enabled: false, options });
    view.restorePreview = preview.ok
      ? { outcome: "restore", changes: preview.changes }
      : { outcome: preview.reason, changes: [] };
  }
  return view;
}

function claudeDesktopRow(input: ClaudeConnectionInput): ConnectionView {
  const { live } = input;
  const options = input.opencodexConfigDir ? { opencodexConfigDir: input.opencodexConfigDir } : {};
  const wanted = claudeDesktopIntegrationEnabled(live);
  const observation = observeClaudeDesktopMode(live, options);
  const mode = resolveClaudeDesktopMode(live, observation);
  const library = inspectDesktop3pConfigLibrary({ appliedFingerprint: live.claudeCode?.desktopProfile?.appliedFingerprint ?? null });
  let observed: ConnectionObserved;
  switch (library.kind) {
    case "not_installed": observed = "missing"; break;
    case "gateway_ours": case "gateway_drifted": observed = "proxy"; break;
    case "foreign": observed = "foreign"; break;
    case "broken": case "unsafe": observed = "unknown"; break;
    case "standard": case "no_owned_state": {
      const settings = mode === "first-party" ? inspectDesktopFirstParty(live, options).settings : null;
      observed = settings && (settings.kind === "applied" || settings.kind === "stale") ? "proxy" : "native";
      break;
    }
    default: {
      const exhaustive: never = library.kind;
      throw new Error(`unhandled Claude Desktop library kind: ${String(exhaustive)}`);
    }
  }
  const owner: ConnectionOwner = observed === "foreign" ? "external"
    : observed === "proxy" ? "opencodex" : observed === "unknown" ? "unknown" : "none";
  const driftReasons: ConnectionDriftReason[] = [];
  if (owner === "external") driftReasons.push("external_owner");
  const pinned = live.claudeCode?.desktopMode;
  if ((pinned === "first-party" && observation.ownedGatewaySelected)
    || (pinned === "gateway" && observation.ownedFirstPartySettings)) driftReasons.push("account_mode");
  if (library.kind === "gateway_drifted" || library.kind === "broken"
    || (wanted && observed === "native")) driftReasons.push("file_edited");
  return {
    client: "claude-desktop",
    configPath: displayPath(library.libraryPath),
    desired: wanted ? "proxy" : "native",
    observed,
    owner,
    ...(owner === "external" ? { ownerPath: displayPath(library.libraryPath) } : {}),
    driftReasons,
  };
}

export function projectClaudeConnections(input: ClaudeConnectionInput): ConnectionView[] {
  const homes = registeredClaudeConfigDirs(input.live, input.env);
  return [...homes.map(home => claudeCodeRow(input, home.dir, home.source)), claudeDesktopRow(input)];
}

/**
 * Read-only Codex row of the Connections view (catch-up 010, G-001).
 *
 * Reads the same evidence the toggle and restore act on: the durable intent
 * (`codexIntegrationEnabled`), the routing classifier over a bounded read of config.toml, the
 * Codex-home journal binding, the recorded service state (file reads only; the service-manager
 * probe spawns processes and stays on the write paths), the external-provider rule, the hub
 * gate and the sibling mark. Nothing here writes, locks, or deletes recovery evidence.
 */
import { join } from "node:path";
import type { OcxConfig } from "../types";
import type { ConnectionDriftReason, ConnectionObserved, ConnectionOwner, ConnectionView } from "../integrations/connection-view";
import { inspectRecordedServiceOwnership, type OwnershipDeps } from "../integrations/native/ownership-preflight";
import { displayPath } from "../lib/display-path";
import { CODEX_HOME_JOURNAL_FILE, inspectCodexHomeOwner } from "./codex-home-owner";
import { codexIntegrationEnabled, localClientSkipReason } from "./desired-state";
import { readBoundedCodexConfig } from "./inject/bounded-config-reader";
import { externalCodexModelProvider } from "./inject/config-toml";
import { classifyCodexRouting } from "./inject/routing-classify";
import { CODEX_CONFIG_PATH, getCodexHome } from "./paths";
import { isApprovedCodexProviderUrl } from "./provider-routing";
import { previewCodexNativeRestore, type CodexRestorePreviewDeps } from "./restore-preview";
import { siblingOfLivePort } from "./sibling-start";

export interface CodexConnectionDeps {
  ownership?: OwnershipDeps;
  restore?: CodexRestorePreviewDeps;
}

function approvedUrl(id: string, url: string): boolean {
  // Invalid consent evidence is no consent: the URL is then not ours.
  try { return isApprovedCodexProviderUrl(id, url); } catch { return false; }
}

export function projectCodexConnection(
  config: Pick<OcxConfig, "clientIntegrations" | "runtimeRole" | "unauthenticatedLoopbackListener">,
  deps: CodexConnectionDeps = {},
): ConnectionView {
  const child = config.runtimeRole === "client";
  const wanted = codexIntegrationEnabled(config);
  const desired = wanted ? (child ? "remote-home" : "proxy") : "native";

  let content: string | null = null;
  let observed: ConnectionObserved;
  try {
    content = readBoundedCodexConfig(CODEX_CONFIG_PATH);
    if (content === null) observed = "missing";
    else {
      const kind = classifyCodexRouting(content, approvedUrl);
      observed = kind === "opencodex-local" ? (child ? "remote-home" : "proxy")
        : kind === "native" ? "native"
          : kind === "unknown" ? "unknown" : "foreign";
    }
  } catch {
    observed = "unknown";
  }

  const home = getCodexHome();
  const homeOwner = inspectCodexHomeOwner(home);
  const recorded = homeOwner.kind === "foreign" ? null : inspectRecordedServiceOwnership(deps.ownership);
  let owner: ConnectionOwner;
  let ownerPath: string | undefined;
  if (homeOwner.kind === "foreign") {
    owner = "external";
    ownerPath = join(home, CODEX_HOME_JOURNAL_FILE);
  } else if (recorded?.ownership === "foreign") {
    owner = "external";
    ownerPath = recorded.path;
  } else if (content !== null && externalCodexModelProvider(content)) {
    owner = "external";
    ownerPath = CODEX_CONFIG_PATH;
  } else if (siblingOfLivePort() !== null) {
    owner = "external";
  } else if (wanted && localClientSkipReason(config) === "hub-gated") {
    owner = "hub";
  } else if (homeOwner.kind === "unknown" || recorded?.ownership === "unknown") {
    owner = "unknown";
  } else {
    owner = observed === "proxy" || observed === "remote-home" ? "opencodex" : "none";
  }

  const driftReasons: ConnectionDriftReason[] = [];
  if (owner === "external") driftReasons.push("external_owner");
  if (owner === "hub") driftReasons.push("hub_gated");
  const routed = observed === "proxy" || observed === "remote-home";
  if (owner !== "external" && owner !== "hub"
    && ((wanted && observed === "native") || (!wanted && routed))) {
    driftReasons.push("file_edited");
  }

  const preview = previewCodexNativeRestore(deps.restore);
  return {
    client: "codex",
    configPath: displayPath(CODEX_CONFIG_PATH),
    desired,
    observed,
    owner,
    ...(ownerPath ? { ownerPath: displayPath(ownerPath) } : {}),
    driftReasons,
    restorePreview: { outcome: preview.outcome, changes: preview.changes },
  };
}

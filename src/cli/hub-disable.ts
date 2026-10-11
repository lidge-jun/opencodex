import { mutatePersistedConfig, validateConfigCandidate } from "../config";
import { deleteConfigTopLevelKey } from "../config/rebase-provenance";
import { inspectDesktopSupervision } from "../service/desktop-supervision.mjs";
import { probeServiceInstallation } from "../service/cli";
import { redactSecretString } from "../lib/redact";
import { CliUsageError, printData, runCliAction } from "./runtime-api";
import type { OcxConfig } from "../types";

export const HUB_DISABLE_USAGE = "ocx hub disable [--revoke-clients --client-key <id> ...] [--json]";
const HUB_KEYS = ["hub", "unauthenticatedLoopbackListener", "runtimeRole", "hostname"] as const;
const PUBLISHING_NOTE = "External publishing is unchanged. Check tailscale serve status and any other frontend for mappings to the old hub ports.";

export interface HubDisableOptions { json: boolean; revokeClients: boolean; clientKeys: string[] }
export interface HubDisableDeps {
  mutateConfig?: typeof mutatePersistedConfig;
  restartHint?: () => string;
}
interface HubDisableResult {
  removed: string[];
  keys: { id: string; name: string; createdAt: string; revoked: boolean }[];
  revoked: string[];
}

export function parseHubDisableArgs(args: string[]): HubDisableOptions {
  const options: HubDisableOptions = { json: false, revokeClients: false, clientKeys: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json" && !options.json) options.json = true;
    else if (arg === "--revoke-clients" && !options.revokeClients) options.revokeClients = true;
    else if (arg === "--client-key") {
      const id = args[++index];
      if (!id || id.startsWith("-") || options.clientKeys.includes(id)) throw new CliUsageError("Each --client-key requires a unique exact key ID.", HUB_DISABLE_USAGE);
      options.clientKeys.push(id);
    } else throw new CliUsageError("Unknown or repeated hub disable argument.", HUB_DISABLE_USAGE);
  }
  if (options.clientKeys.length && !options.revokeClients) throw new CliUsageError("--client-key requires --revoke-clients.", HUB_DISABLE_USAGE);
  return options;
}

/** Selection is explicit: legacy keys have editable names but no trustworthy issuance marker. */
export function disableHubConfig(config: OcxConfig, options: HubDisableOptions): HubDisableResult {
  if (config.runtimeRole !== "hub") throw new CliUsageError("This machine is not a hub; no settings or keys were changed.");
  const keys = config.apiKeys ?? [];
  const secrets = keys.flatMap(key => [key.key, key.pendingRotation?.key]).filter((secret): secret is string => Boolean(secret));
  const safeMetadata = (value: string) => redactSecretString(secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value));
  if (options.revokeClients && keys.length && !options.clientKeys.length) {
    throw new CliUsageError("Keys have no verified client origin. List IDs with 'ocx access key list --json', then repeat --client-key <id> for each client key to revoke.", HUB_DISABLE_USAGE);
  }
  const selected = new Set(options.clientKeys);
  if (options.clientKeys.some(id => !keys.some(key => key.id === id))) {
    throw new CliUsageError("A selected client key ID is not in the current config; no settings or keys were changed.");
  }
  const candidate = structuredClone(config);
  const removed = HUB_KEYS.filter(key => Object.hasOwn(candidate, key));
  for (const key of HUB_KEYS) delete candidate[key];
  if (options.revokeClients) candidate.apiKeys = keys.filter(key => !selected.has(key.id));
  const validated = validateConfigCandidate(candidate);
  if (!validated.ok) throw new CliUsageError(validated.error);
  // Keep deletion intent so a later live save cannot resurrect the hub's old bindings.
  for (const key of HUB_KEYS) deleteConfigTopLevelKey(config, key);
  Object.assign(config, validated.config);
  return {
    removed,
    keys: keys.map(key => ({ id: safeMetadata(key.id), name: safeMetadata(key.name), createdAt: safeMetadata(key.createdAt), revoked: selected.has(key.id) })),
    revoked: options.revokeClients ? [...selected].map(safeMetadata) : [],
  };
}

export function hubDisableRestartHint(): string {
  try {
    if (inspectDesktopSupervision().kind === "desktop") return "Restart to apply: ocx restart (OpenCodex Desktop supervises the replacement).";
    const service = probeServiceInstallation();
    if (service.state === "installed") return "Restart to apply: ocx service restart.";
  } catch { /* An unavailable probe must not prevent an already validated config change. */ }
  return "Restart to apply: use your current proxy supervisor; for a manually started proxy, ocx restart.";
}

export async function runHubDisable(args: string[], deps: HubDisableDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const options = parseHubDisableArgs(args);
    const outcome = (deps.mutateConfig ?? mutatePersistedConfig)(config => ({
      changed: true, value: disableHubConfig(config, options),
    }));
    if (outcome.status === "unavailable") throw new Error(`Hub disable could not read or commit the config (${outcome.reason}); retry after fixing the config.`);
    let restart: string;
    try { restart = (deps.restartHint ?? hubDisableRestartHint)(); }
    catch { restart = "Restart to apply: use your current proxy supervisor."; }
    const result = { ok: true, ...outcome.value, restart, note: PUBLISHING_NOTE, keyOrigin: "unverified", effectiveAfterRestart: true };
    // Explicit field projection excludes secrets and pending rotations; names are arbitrary input.
    const safe = { ...result, keys: result.keys.map(key => ({ ...key, name: redactSecretString(key.name) })) };
    printData(safe, options.json, [
      `Removed hub settings: ${safe.removed.join(", ")}.`,
      ...safe.keys.map(key => `${key.revoked ? "Revoked" : "Retained"} saved key: ${key.id} (${key.name})`),
      "Saved keys have no verified client origin; revocation uses only explicitly selected IDs.",
      restart, PUBLISHING_NOTE,
      "Restart is required to apply all saved settings; this command does not terminate existing sessions.",
    ]);
  });
}

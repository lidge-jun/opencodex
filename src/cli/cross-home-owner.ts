/** Best-effort discovery of a live proxy named by shared, OpenCodex-managed client state. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getConfigDir } from "../config/paths";
import { readRuntimePort } from "../config/process-state";
import { getCodexHome } from "../codex/paths";
import { detectCodexRoutingDrift } from "../codex/routing-drift";
import { readBoundedCodexConfig } from "../codex/inject/bounded-config-reader";
import { currentExternalCodexModelProvider } from "../codex/inject";
import { reconcileJournal } from "../codex/journal";
import { markSiblingStart, siblingOfLivePort } from "../codex/sibling-start";
import { readClientConnectionState } from "../client/state";
import { findManagedRegion, resolveGrokHome } from "../grok/inject";
import { providerTableString } from "../codex/injected-marker";
import { probePortOwner, START_OWNERSHIP_LIVENESS } from "../server/proxy-liveness";

const MAX_HINT_BYTES = 256 * 1024;
// Far above any real Grok config; discovery must not stall startup when Grok sync is off.
const MAX_GROK_CONFIG_BYTES = 16 * 1024 * 1024;

/** Nonblocking open (a FIFO cannot stall startup), regular files only, capped at maxBytes. */
function readBoundedRegularFile(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = readSync(fd, bytes, count, bytes.length - count, count);
      if (next === 0) break;
      count += next;
    }
    return count > maxBytes || count > stat.size ? null : bytes.toString("utf8", 0, count);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;
}

function loopbackPort(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!url.port || !["http:", "https:"].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return null;
    const port = Number(url.port);
    return validPort(port) ? port : null;
  } catch {
    return null;
  }
}

/** Returns only a different process with an identity-checked /healthz response. */
export async function findCrossHomeOwner(options: { homeDir?: string } = {}): Promise<number | null> {
  const candidates = new Set<number>();
  const defaultHome = join(options.homeDir ?? homedir(), ".opencodex");
  if (resolve(getConfigDir()) !== resolve(defaultHome)) {
    const raw = readBoundedRegularFile(join(defaultHome, "runtime-port.json"), MAX_HINT_BYTES);
    if (raw) {
      try {
        const record: unknown = JSON.parse(raw);
        if (record && typeof record === "object" && validPort((record as { port?: unknown }).port)) {
          candidates.add((record as { port: number }).port);
        }
      } catch { /* stale or malformed hint */ }
    }
  }

  // Grok's writer reads its config in full; cap discovery separately so startup stays bounded.
  const grok = readBoundedRegularFile(join(resolveGrokHome(), "config.toml"), MAX_GROK_CONFIG_BYTES);
  const region = grok === null ? null : findManagedRegion(grok);
  if (grok && region && !region.orphaned) {
    const port = loopbackPort(providerTableString(grok.slice(region.start, region.end), "opencodex", "base_url"));
    if (port !== null) candidates.add(port);
  }

  try {
    const codex = readBoundedCodexConfig(join(getCodexHome(), "config.toml"));
    if (codex) {
      const drift = detectCodexRoutingDrift(codex, { ownPorts: [] });
      if (drift.kind === "foreign") {
        for (const target of drift.targets) {
          // Every drift target is owned, loopback, and has an explicit port (including Design B roots).
          candidates.add(target.port);
        }
      }
    }
  } catch { /* an absent or invalid client home is not owner evidence */ }

  for (const port of candidates) {
    const owner = await probePortOwner(port, {}, START_OWNERSHIP_LIVENESS);
    if (owner && Number.isSafeInteger(owner.pid) && owner.pid! > 0 && owner.pid !== process.pid) return port;
  }
  return null;
}

/** Mark this process before any shared-client write when another home owns the clients. */
export async function markCrossHomeSibling(): Promise<boolean> {
  const port = await findCrossHomeOwner();
  if (port === null) return false;
  markSiblingStart(port);
  return true;
}

/** A live proxy in this home can publish its sibling owner even while that owner is down. */
export async function markLiveHomeSibling(live: { pid: number | null; port: number }): Promise<boolean> {
  const runtime = readRuntimePort();
  if (live.pid !== null && runtime?.pid === live.pid && runtime.port === live.port
    && runtime.siblingOfPort !== undefined && runtime.siblingOfPort !== live.port) {
    markSiblingStart(runtime.siblingOfPort);
    return true;
  }
  const otherPort = await findCrossHomeOwner();
  if (otherPort === null || otherPort === live.port) return false;
  markSiblingStart(otherPort);
  return true;
}

/**
 * Recovery follows the full owner decision; a sibling never replays another home's journal.
 * A marked sibling's owner can be down mid-restart; its journal is still not ours to replay.
 */
export function reconcileStartupJournal(): void {
  if (currentExternalCodexModelProvider() || siblingOfLivePort() !== null) return;
  const clientState = readClientConnectionState();
  reconcileJournal(clientState.kind === "connected"
    ? { activeClientApiKeyId: clientState.value.apiKeyId }
    : undefined);
}

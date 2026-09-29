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
import { isLocalAttestationSecret } from "../lib/local-management-attestation";
import { readOwnerRegistry } from "../config/owner-registry";
import {
  classifyHealthz,
  loopbackProbeHosts,
  proveLiveProxyOwnedByHome,
  proxyIdentityAt,
  START_OWNERSHIP_LIVENESS,
  type LivenessIo,
} from "../server/proxy-liveness";
import { directLocalHttpFetch } from "../server/direct-local-http";
import type { RuntimePortState } from "../config/process-state";

const MAX_HINT_BYTES = 256 * 1024;
// Far above any real Grok config; discovery must not stall startup when Grok sync is off.
const MAX_GROK_CONFIG_BYTES = 16 * 1024 * 1024;

/**
 * One registered home's runtime record as discovery sees it.
 *
 * 'attestable' distinguishes the two shapes a well-formed record can take: a current
 * record carries the attestation secret another home can challenge, while a legacy
 * record (written before secrets existed, or with the secret stripped) can only name
 * a pid/port pair. A live legacy record is never "no owner" - it is an owner the
 * reader cannot verify, and a shared-write decision must fail closed on it.
 */
type CandidateRecord = {
  home: string;
  pid: number;
  port: number;
  hostname?: string;
  siblingOfPort?: number;
  attestable: boolean;
  record: RuntimePortState;
};

function parseCandidateRecord(home: string, raw: string): CandidateRecord | null {
  try {
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object") return null;
    const state = record as Record<string, unknown>;
    if (!Number.isSafeInteger(state.pid) || Number(state.pid) <= 0 || !validPort(state.port)) return null;
    if (state.hostname !== undefined && typeof state.hostname !== "string") return null;
    if (state.siblingOfPort !== undefined
      && !(Number.isInteger(state.siblingOfPort) && Number(state.siblingOfPort) > 0 && Number(state.siblingOfPort) <= 65535)) {
      return null;
    }
    const attestable = isLocalAttestationSecret(state.attestationSecret);
    return {
      home,
      pid: Number(state.pid),
      port: Number(state.port),
      hostname: typeof state.hostname === "string" ? state.hostname : undefined,
      siblingOfPort: typeof state.siblingOfPort === "number" ? state.siblingOfPort : undefined,
      attestable,
      record: state as RuntimePortState,
    };
  } catch {
    return null;
  }
}

/**
 * The discovery verdict. "owner" names the port a sibling defers to. "indeterminate"
 * means something on the shared clients' path could be an owner the reader could not
 * verify - a live listener no record attests, a legacy record, or an unreadable
 * transport - and a shared-write caller must fail closed on it. 'port' carries the
 * best location hint for the sibling marker.
 */
export type CrossHomeOwnerVerdict =
  | { kind: "owner"; port: number }
  | { kind: "indeterminate"; port: number | null; reason: string }
  | { kind: "none" };

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
export async function findCrossHomeOwner(options: { homeDir?: string; io?: LivenessIo } = {}): Promise<number | null> {
  const verdict = await findCrossHomeOwnerDetailed(options);
  return verdict.kind === "owner" ? verdict.port : null;
}

export async function findCrossHomeOwnerDetailed(options: { homeDir?: string; io?: LivenessIo } = {}): Promise<CrossHomeOwnerVerdict> {
  const io = options.io ?? {};
  const nowFn = io.nowFn ?? Date.now;
  const timeoutMs = io.timeoutMs ?? START_OWNERSHIP_LIVENESS.timeoutMs ?? 1_500;
  const attempts = io.attempts ?? START_OWNERSHIP_LIVENESS.attempts ?? 3;
  // One deadline bounds the whole discovery: every identity probe, attestation and
  // fallback classification shares it, so a pile of stale hints cannot stretch the
  // start path the way per-candidate budgets did (CodeRabbit on #6198).
  const deadlineAt = io.deadlineAt ?? nowFn() + timeoutMs * attempts * 4;
  const probeIo: LivenessIo = { ...io, timeoutMs, attempts, deadlineAt };

  const candidates = new Set<number>();
  const records = new Map<number, CandidateRecord[]>();
  const ownHome = resolve(getConfigDir());
  const recordHome = (home: string): void => {
    if (resolve(home) === ownHome) return;
    const raw = readBoundedRegularFile(join(home, "runtime-port.json"), MAX_HINT_BYTES);
    if (!raw) return;
    const parsed = parseCandidateRecord(home, raw);
    if (!parsed) return;
    candidates.add(parsed.port);
    const list = records.get(parsed.port) ?? [];
    list.push(parsed);
    records.set(parsed.port, list);
  };

  const defaultHome = join(options.homeDir ?? homedir(), ".opencodex");
  recordHome(defaultHome);
  // The shared registry is what lets one custom home find another: every runtime
  // that published a runtime record registered its home beside the shared clients.
  const registry = readOwnerRegistry();
  for (const home of registry.homes) recordHome(home);
  const registryTruncated = registry.truncated;

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

  let indeterminatePort: number | null = null;
  let indeterminateReason: string | null = null;
  const noteIndeterminate = (port: number | null, reason: string): void => {
    if (indeterminateReason === null) {
      indeterminatePort = port;
      indeterminateReason = reason;
    }
  };

  if (registryTruncated) {
    // A truncated registry can hide the live owner's home entirely; "no owner
    // found" is then indistinguishable from "owner never read". Fail closed.
    noteIndeterminate(null, "the owner registry listing was truncated before every pointer could be checked");
  }

  const queue = [...candidates];
  const probed = new Set<number>();
  for (const port of queue) {
    if (probed.has(port)) continue;
    probed.add(port);
    const portRecords = records.get(port) ?? [];
    // The recorded hostnames are tried first; every remaining loopback family is a
    // candidate too, because IPv4 and IPv6 listeners on one port are independent.
    const hosts: string[] = [];
    for (const rec of portRecords) {
      for (const host of loopbackProbeHosts(rec.hostname)) {
        if (!hosts.includes(host)) hosts.push(host);
      }
    }
    if (hosts.length === 0) hosts.push(...loopbackProbeHosts(undefined));

    for (const hostname of hosts) {
      if (deadlineAt - nowFn() <= 0) {
        noteIndeterminate(port, "ownership discovery ran out of its shared time budget");
        break;
      }
      const identity = await proxyIdentityAt(port, { hostname }, probeIo);
      if (identity === null) {
        // A null identity is not "free": distinguish a unanimous connect refusal
        // (the family is genuinely empty) from a transport or shape that stayed
        // unreadable. On a managed port an unreadable answer is owner evidence the
        // caller cannot dismiss.
        const remainingMs = deadlineAt - nowFn();
        if (remainingMs <= 0) {
          noteIndeterminate(port, "ownership discovery ran out of its shared time budget");
          break;
        }
        const classification = await classifyHealthz(
          "http://" + hostname + ":" + port + "/healthz",
          probeIo.fetchFn ?? directLocalHttpFetch,
          Math.min(timeoutMs, remainingMs),
        );
        if (classification === "dead") continue;
        noteIndeterminate(port, "a managed client port answered but its listener could not be classified");
        continue;
      }
      if (identity.pid === null) {
        noteIndeterminate(port, "a live opencodex listener reported no pid to attest");
        continue;
      }
      if (identity.pid === process.pid) continue;

      const matching = portRecords.filter(rec => rec.pid === identity.pid);
      if (matching.length === 0) {
        // Our opencodex answers on a managed port but no registered record names it:
        // it may be an owner whose home never registered (an install predating the
        // registry, or a CODEX_HOME the writer could not reach). Unverifiable is not
        // absent - fail closed instead of starting a second owner beside it.
        noteIndeterminate(port, "a live opencodex listener on a managed port matches no registered owner record");
        continue;
      }
      for (const rec of matching) {
        if (rec.siblingOfPort !== undefined) {
          // The attested process is itself a sibling; its runtime record names the
          // real owner's port. Follow it instead of deferring to the sibling.
          if (validPort(rec.siblingOfPort)) queue.push(rec.siblingOfPort);
          continue;
        }
        if (!rec.attestable) {
          noteIndeterminate(port, "a live listener matches a runtime record that carries no attestation secret");
          continue;
        }
        const proof = await proveLiveProxyOwnedByHome(
          { ...identity, hostname, port, source: "runtime" },
          { ...probeIo, readRuntimeFn: () => rec.record },
        );
        if (proof === "proven") return { kind: "owner", port };
        if (proof === "indeterminate") {
          noteIndeterminate(port, "the recorded owner's attestation could not be completed");
        }
        // "refuted" means this listener definitively is not the recorded owner on
        // this record; other records and hosts still get their turn.
      }
    }
  }

  if (indeterminateReason !== null) {
    return { kind: "indeterminate", port: indeterminatePort, reason: indeterminateReason };
  }
  return { kind: "none" };
}

/** Mark this process before any shared-client write when another home owns the clients. */
export async function markCrossHomeSibling(): Promise<boolean> {
  const verdict = await findCrossHomeOwnerDetailed();
  if (verdict.kind === "none") return false;
  if (verdict.port === null) throw new Error("Shared-client owner could not be located; refusing startup before any shared-client write.");
  if (verdict.kind === "indeterminate") {
    // Fail closed: an owner the reader could not verify still owns the shared
    // writes. Marking the best port hint keeps every sibling gate engaged even
    // while the answer stays unproven (#6198).
    console.warn(
      "A shared-client owner could not be verified (" + verdict.reason + "); "
      + "treating this instance as a sibling so Codex, Grok and Claude configs are left alone.",
    );
  }
  const port = verdict.port;
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
  const verdict = await findCrossHomeOwnerDetailed();
  if (verdict.kind === "none" || verdict.port === live.port) return false;
  if (verdict.port === null) throw new Error("Shared-client owner could not be located; refusing startup before any shared-client write.");
  markSiblingStart(verdict.port);
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

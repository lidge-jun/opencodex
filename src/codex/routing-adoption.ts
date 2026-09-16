import { existsSync, readFileSync, statSync } from "node:fs";
import { readProcessStartMsBatch } from "./app-server-processes";
import type { CodexRoutingKind } from "./inject";
import { JOURNAL_PATH } from "./journal";
import {
  listCodexClientProcesses,
  type CodexClientProcessList,
} from "./native-profile-processes";

export type RoutingAdoption = "not-applicable" | "adopted" | "pending-client-restart" | "unknown";

export interface RoutingAdoptionEvidence {
  adoption: RoutingAdoption;
  injectedAtMs: number | null;
  staleClients: Array<{ pid: number; startedAtMs: number }>;
  observedClients: number;
}

export interface CollectRoutingAdoptionOptions {
  routingKind: CodexRoutingKind;
  platform?: NodeJS.Platform;
  listClients?: () => CodexClientProcessList;
  readStartMsBatch?: (pids: readonly number[], platform: NodeJS.Platform) => Map<number, number | null>;
  injectedAtMs?: number | null;
}

/**
 * Infer whether running Codex clients had an opportunity to read the
 * injected opencodex-local route (#4550).
 *
 * "adopted" is not an observation of live traffic. It means every matched
 * running Codex client started after the route was written. That is the
 * inference the operator needed, and it is also the overclaim we must not
 * make. Known sources of a false adopted this evidence does not cover:
 * a client the matcher does not recognise; a restored or resumed thread
 * that keeps an already-open direct WebSocket even though the process
 * started after injection; OPENAI_BASE_URL / profile overrides in the
 * client's own environment; a start time in the SAME second as the
 * injection, which we deliberately treat as not stale; an empty match
 * set, which is vacuously adopted; a client running against a different
 * CODEX_HOME or config path than the journal we read; and Codex surfaces
 * the CLI predicate does not match at all, such as codex-code-mode-host,
 * Electron helpers, and VS Code extension hosts. Anything that cannot
 * be verified is "unknown", never a clean bill of health — matching the
 * #476 restart contract where enumeration failure means no verified
 * targets.
 */
export function deriveRoutingAdoption(inputs: {
  routingKind: CodexRoutingKind;
  injectedAtMs: number | null;
  clients: ReadonlyArray<{ pid: number; startedAtMs: number | null }>;
  enumerationFailed?: boolean;
}): RoutingAdoptionEvidence {
  const observedClients = inputs.clients.length;
  if (inputs.routingKind !== "opencodex-local") {
    return { adoption: "not-applicable", injectedAtMs: null, staleClients: [], observedClients: 0 };
  }
  if (inputs.enumerationFailed) {
    return { adoption: "unknown", injectedAtMs: inputs.injectedAtMs, staleClients: [], observedClients };
  }
  if (inputs.injectedAtMs === null) {
    return { adoption: "unknown", injectedAtMs: null, staleClients: [], observedClients };
  }
  const injectedAtMs = inputs.injectedAtMs;
  const staleClients: Array<{ pid: number; startedAtMs: number }> = [];
  let unreadableStart = false;
  for (const client of inputs.clients) {
    if (client.startedAtMs === null) {
      unreadableStart = true;
      continue;
    }
    if (startedBeforeInjection(client.startedAtMs, injectedAtMs)) {
      staleClients.push({ pid: client.pid, startedAtMs: client.startedAtMs });
    }
  }
  staleClients.sort((left, right) => left.pid - right.pid);
  if (staleClients.length > 0) {
    return { adoption: "pending-client-restart", injectedAtMs, staleClients, observedClients };
  }
  if (unreadableStart) {
    return { adoption: "unknown", injectedAtMs, staleClients: [], observedClients };
  }
  return { adoption: "adopted", injectedAtMs, staleClients: [], observedClients };
}

/**
 * ps lstart is second-granularity; app-server-processes.ts uses <= for catalog
 * staleness for the opposite reason (a rewrite in the same second may be unseen).
 * Here a start in the same wall-clock second as the injection cannot be proven
 * to predate it, so a rounding artifact must not produce a false pending-restart
 * warning (#4550). Truncate both sides to seconds; strictly earlier seconds are
 * stale.
 */
function startedBeforeInjection(startedAtMs: number, injectedAtMs: number): boolean {
  return Math.floor(startedAtMs / 1000) < Math.floor(injectedAtMs / 1000);
}

/**
 * Gather journal + process evidence for deriveRoutingAdoption.
 *
 * Injection time is the newer of the journal timestamp and JOURNAL_PATH mtime:
 * writeJournal records the native snapshot time and then no-ops, while
 * markJournalInjectedState rewrites the file (mtime moves) without touching
 * timestamp. The journal is parsed here instead of through readJournal, which
 * can delete a corrupt file; a status read must never mutate state. Ownership
 * matches journaledInjectedOpenaiBaseUrl plus journalOwner: we only bound a
 * route we recorded writing.
 */
export function collectRoutingAdoption(options: CollectRoutingAdoptionOptions): RoutingAdoptionEvidence {
  const { routingKind } = options;
  if (routingKind !== "opencodex-local") {
    return deriveRoutingAdoption({ routingKind, injectedAtMs: null, clients: [] });
  }
  const injectedAtMs = options.injectedAtMs !== undefined
    ? options.injectedAtMs
    : readOwnedInjectionBoundMs();
  let listed: CodexClientProcessList;
  try {
    listed = (options.listClients ?? (() => listCodexClientProcesses({ platform: options.platform })))();
  } catch {
    listed = { status: "unavailable" };
  }
  if (listed.status === "unavailable") {
    return deriveRoutingAdoption({
      routingKind,
      injectedAtMs,
      clients: [],
      enumerationFailed: true,
    });
  }
  const platform = options.platform ?? process.platform;
  const pids = listed.processes.map(proc => proc.pid);
  let starts: Map<number, number | null>;
  try {
    starts = pids.length === 0
      ? new Map()
      : (options.readStartMsBatch ?? readProcessStartMsBatch)(pids, platform);
  } catch {
    starts = new Map(pids.map(pid => [pid, null]));
  }
  const clients = listed.processes.map(proc => ({
    pid: proc.pid,
    startedAtMs: starts.get(proc.pid) ?? null,
  }));
  return deriveRoutingAdoption({ routingKind, injectedAtMs, clients });
}

function readOwnedInjectionBoundMs(): number | null {
  try {
    if (!existsSync(JOURNAL_PATH)) return null;
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      version?: unknown;
      timestamp?: unknown;
      injectedOpenaiBaseUrl?: unknown;
      owner?: { kind?: unknown; pid?: unknown; apiKeyId?: unknown };
      pid?: unknown;
    };
    if (journal === null || typeof journal !== "object" || journal.version !== 1) return null;
    const injectedUrl = typeof journal.injectedOpenaiBaseUrl === "string"
      ? journal.injectedOpenaiBaseUrl
      : "";
    if (!injectedUrl) return null;
    if (!journalHasOwner(journal)) return null;
    const recordedMs = typeof journal.timestamp === "string" ? Date.parse(journal.timestamp) : Number.NaN;
    let mtimeMs = Number.NaN;
    try {
      mtimeMs = statSync(JOURNAL_PATH).mtimeMs;
    } catch {
      mtimeMs = Number.NaN;
    }
    const bound = Math.max(
      Number.isFinite(recordedMs) ? recordedMs : Number.NEGATIVE_INFINITY,
      Number.isFinite(mtimeMs) ? mtimeMs : Number.NEGATIVE_INFINITY,
    );
    return Number.isFinite(bound) ? bound : null;
  } catch {
    return null;
  }
}

function journalHasOwner(journal: {
  owner?: { kind?: unknown; pid?: unknown; apiKeyId?: unknown };
  pid?: unknown;
}): boolean {
  const owner = journal.owner;
  if (owner?.kind === "client" && typeof owner.apiKeyId === "string" && owner.apiKeyId) return true;
  if (owner?.kind === "process" && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) return true;
  return Number.isSafeInteger(journal.pid) && Number(journal.pid) > 0;
}

/** Provisioning choices are local enabled-only overrides, never writes to Home policy. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { isRouteClientId, ROUTE_CLIENT_IDS, type HomeRouteIntentDocument, type RouteClientId, type RouteClientOutcome } from "../link/route-intent";
import { routeIntentStatePath } from "./route-intent-state";

type InitialSelection = Partial<Record<RouteClientId, { enabled: boolean; revision: number }>>;
function recordPath(linkId: string, root: string): string {
  if (!/^lnk_[0-9a-f]{16}$/.test(linkId)) throw new Error("Invalid initial route intent link identity");
  return join(root, `initial-${linkId}.json`);
}
export function readInitialRouteIntent(linkId: string, root = routeIntentStatePath()): InitialSelection {
  let raw: unknown;
  try { raw = JSON.parse(readBoundedRegularFileSync(recordPath(linkId, root), 64 * 1024).toString("utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("Initial route selection is unreadable"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("version" in raw) || raw.version !== 1
    || !("linkId" in raw) || raw.linkId !== linkId || !("clients" in raw) || !raw.clients || typeof raw.clients !== "object" || Array.isArray(raw.clients)) {
    throw new Error("Invalid initial route selection");
  }
  const clients: InitialSelection = {};
  for (const [id, entry] of Object.entries(raw.clients)) {
    if (!isRouteClientId(id) || !entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "enabled,revision" || !("enabled" in entry) || typeof entry.enabled !== "boolean"
      || !("revision" in entry) || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 0) throw new Error("Invalid initial route selection client");
    clients[id] = { enabled: entry.enabled, revision: Number(entry.revision) };
  }
  return clients;
}
function writeInitial(linkId: string, clients: InitialSelection, root: string): void {
  assertNotRealHomeUnderTest(root); mkdirSync(root, { recursive: true, mode: 0o700 });
  atomicWriteFileNoFollow(recordPath(linkId, root), JSON.stringify({ version: 1, linkId, clients }));
}
export function recordInitialRouteIntent(linkId: string, document: HomeRouteIntentDocument | undefined, selected: readonly RouteClientId[], root = routeIntentStatePath()): void {
  const clients: InitialSelection = {};
  for (const id of ROUTE_CLIENT_IDS) if (id === "codex" || id === "claude" || selected.includes(id)) {
    clients[id] = { enabled: selected.includes(id), revision: document?.clientRevisions?.[id] ?? 0 };
  }
  writeInitial(linkId, clients, root);
}
export function resolveInitialRouteIntent(linkId: string, document: HomeRouteIntentDocument, beforeWrite: () => void = () => {}, root = routeIntentStatePath()): HomeRouteIntentDocument {
  const clients = readInitialRouteIntent(linkId, root);
  const next = structuredClone(document);
  let removed = false;
  for (const id of ROUTE_CLIENT_IDS) {
    const initial = clients[id]; if (!initial) continue;
    if ((document.clientRevisions?.[id] ?? 0) !== initial.revision) { delete clients[id]; removed = true; continue; }
    next.clients[id] = { ...next.clients[id], enabled: initial.enabled };
    next.sources[id] = "device";
  }
  if (removed) { beforeWrite(); writeInitial(linkId, clients, root); }
  return next;
}
export function initialRouteOutcomeMetadata(linkId: string, document: HomeRouteIntentDocument, root = routeIntentStatePath()) {
  const initial = readInitialRouteIntent(linkId, root);
  return (row: RouteClientOutcome): RouteClientOutcome => {
    const entry = initial[row.client];
    return entry && entry.revision === (document.clientRevisions?.[row.client] ?? 0)
      ? { ...row, initialIntent: { enabled: entry.enabled }, initialRevision: entry.revision } : row;
  };
}
export function clearInitialRouteIntent(linkId: string, root = routeIntentStatePath()): void { writeInitial(linkId, {}, root); }

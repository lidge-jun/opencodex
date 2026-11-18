import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { ROUTE_CLIENT_IDS, isRouteClientId, parseHomeRouteIntentDocument, parseRouteClientIntent, type HomeRouteIntentDocument, type RouteClientId } from "../link/route-intent";
import type { RouteIntentReceipt } from "./route-intent-contract";

export function routeIntentStatePath(): string { return join(getConfigDir(), "route-intent"); }

function readJson(path: string, maxBytes = 16 * 1024 * 1024): unknown {
  try { return JSON.parse(readBoundedRegularFileSync(path, maxBytes).toString("utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Local route intent state is unreadable; preserve it for recovery");
  }
}

export function readLocalRouteIntentOff(statePath = routeIntentStatePath()): RouteClientId[] {
  const raw = readJson(join(statePath, "local-off.json"), 64 * 1024);
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 || !("clients" in raw)
    || !Array.isArray(raw.clients) || raw.clients.some(id => !ROUTE_CLIENT_IDS.includes(id))
    || new Set(raw.clients).size !== raw.clients.length) throw new Error("Invalid local route intent opt-outs");
  return raw.clients;
}

export function effectiveRouteIntent(document: HomeRouteIntentDocument, statePath = routeIntentStatePath(), localOff?: readonly RouteClientId[]) {
  const clients = structuredClone(document.clients);
  const sources: RouteIntentReceipt["sources"] = { ...document.sources };
  for (const id of localOff ?? readLocalRouteIntentOff(statePath)) {
    clients[id] = { ...clients[id], enabled: false };
    sources[id] = "local";
  }
  return { clients, sources, selectedClients: ROUTE_CLIENT_IDS.filter(id => clients[id].enabled) };
}

export function writeRouteIntentReceipt(receipt: RouteIntentReceipt, statePath = routeIntentStatePath()): void {
  assertNotRealHomeUnderTest(statePath);
  mkdirSync(statePath, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(receipt);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error("Local route intent receipt is too large");
  atomicWriteFileNoFollow(join(statePath, "receipt.json"), body);
}

export function readRouteIntentReceipt(statePath = routeIntentStatePath()): RouteIntentReceipt | null {
  try { return readRouteIntentReceiptStrict(statePath); } catch { return null; }
}

/** Cleanup must distinguish absence from corrupt, unsafe, or incomplete ownership evidence. */
export function readRouteIntentReceiptStrict(statePath = routeIntentStatePath()): RouteIntentReceipt | null {
  const raw = readJson(join(statePath, "receipt.json")) as RouteIntentReceipt | undefined;
  if (raw === undefined) return null;
  if (!raw || raw.version !== 1 || !parseHomeRouteIntentDocument(raw.document, { allowNative: true }) || !Array.isArray(raw.outcomes)
    || raw.outcomes.length !== ROUTE_CLIENT_IDS.length || new Set(raw.outcomes.map(row => row?.client)).size !== ROUTE_CLIENT_IDS.length
    || !raw.clients || !raw.sources || !Array.isArray(raw.selectedClients) || new Set(raw.selectedClients).size !== raw.selectedClients.length
    || raw.selectedClients.some(id => !isRouteClientId(id)) || typeof raw.appliedAt !== "string" || !Number.isFinite(Date.parse(raw.appliedAt))
    || (raw.linkId !== undefined && !/^lnk_[0-9a-f]{16}$/.test(raw.linkId))
    || (raw.models !== undefined && (!Array.isArray(raw.models) || raw.models.some(row => !row || typeof row.namespaced !== "string" || typeof row.provider !== "string" || typeof row.id !== "string")))
    || !(raw.appliedRouteIntentDigest === null || (typeof raw.appliedRouteIntentDigest === "string" && /^[0-9a-f]{64}$/.test(raw.appliedRouteIntentDigest)))
    || raw.outcomes.some(row => !row || !isRouteClientId(row.client) || !["current", "stale", "not_installed", "conflict", "failed"].includes(row.outcome))
    || ROUTE_CLIENT_IDS.some(id => !parseRouteClientIntent(raw.clients[id], id) || !["builtin", "default", "device", "native", "local"].includes(raw.sources[id])
      || raw.selectedClients.includes(id) !== raw.clients[id].enabled)) throw new Error("Route intent receipt is malformed; preserve it and repair before disconnect");
  return raw;
}

export function clearRouteIntentReceipt(statePath = routeIntentStatePath()): void {
  assertNotRealHomeUnderTest(statePath);
  try { unlinkSync(join(statePath, "receipt.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/**
 * Link-bound proof that no route apply has begun for one committed Link connection. Connect writes
 * it with the connection; the first route apply removes it before changing any client. Disconnect
 * reads a matching proof as evidence that a missing receipt was never written, so a `--no-sync`
 * enrollment over standalone integrations can still disconnect. Anything unreadable is no proof.
 */
export interface RouteIntentUnappliedProof { version: 1; linkId: string; connectedAt: string }
const UNAPPLIED_PROOF = "unapplied.json";

export function writeRouteIntentUnappliedProof(linkId: string, connectedAt: string, statePath = routeIntentStatePath()): void {
  if (!/^lnk_[0-9a-f]{16}$/.test(linkId) || !Number.isFinite(Date.parse(connectedAt))) throw new Error("Invalid route intent apply proof");
  assertNotRealHomeUnderTest(statePath);
  mkdirSync(statePath, { recursive: true, mode: 0o700 });
  atomicWriteFileNoFollow(join(statePath, UNAPPLIED_PROOF), JSON.stringify({ version: 1, linkId, connectedAt } satisfies RouteIntentUnappliedProof));
}

export function readRouteIntentUnappliedProof(statePath = routeIntentStatePath()): RouteIntentUnappliedProof | null {
  let raw: unknown;
  try { raw = readJson(join(statePath, UNAPPLIED_PROOF), 4 * 1024); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "connectedAt,linkId,version") return null;
  const value = raw as Record<string, unknown>;
  return value.version === 1 && typeof value.linkId === "string" && /^lnk_[0-9a-f]{16}$/.test(value.linkId)
    && typeof value.connectedAt === "string" ? { version: 1, linkId: value.linkId, connectedAt: value.connectedAt } : null;
}

export function clearRouteIntentUnappliedProof(statePath = routeIntentStatePath()): void {
  assertNotRealHomeUnderTest(statePath);
  try { unlinkSync(join(statePath, UNAPPLIED_PROOF)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** true opts out; false drops the override and inherits the Home again. Never enables locally. */
export function setLocalRouteIntentOff(client: RouteClientId, off: boolean, statePath = routeIntentStatePath()): void {
  if (!ROUTE_CLIENT_IDS.includes(client) || typeof off !== "boolean") throw new Error("Invalid local route intent override");
  const clients = new Set(readLocalRouteIntentOff(statePath));
  if (off) clients.add(client); else clients.delete(client);
  assertNotRealHomeUnderTest(statePath);
  mkdirSync(statePath, { recursive: true, mode: 0o700 });
  // Invalidate before publishing the override: failure cannot leave an old success claim.
  const receipt = readRouteIntentReceiptStrict(statePath);
  if (receipt) writeRouteIntentReceipt({ ...receipt, appliedRouteIntentDigest: null,
    outcomes: receipt.outcomes.map(row => row.client === client ? { ...row, outcome: "stale" } : row) }, statePath);
  atomicWriteFileNoFollow(join(statePath, "local-off.json"), JSON.stringify({ version: 1, clients: [...clients].sort() }));
}

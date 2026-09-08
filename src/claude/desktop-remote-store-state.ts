import { createHash } from "node:crypto";
import { OPENCODEX_DESKTOP_PROFILE_KEYS, SAFE_DESKTOP_PROFILE_ID, isRecord } from "./desktop-3p-library";

export type DesktopRemoteOwner = { serverUrl: string; apiKeyId: string; connectedAt: string };
export type DesktopStoreResult =
  | { ok: true; changed: boolean; status: "absent" | "applied" | "updated" | "restored";
      baselineKind?: "known" | "standard_fallback";
      restoration?: "owned_projection" | "standard_fallback" | "selection_preserved";
      retainedForeignData?: boolean; restartRequired: boolean; path?: string; fingerprint?: string }
  | { ok: false; changed: boolean; reason: "busy" | "conflict" | "unsafe" | "recovery_required" | "cleanup_pending" | "desired_disabled" };
export type StoreReason = Extract<DesktopStoreResult, { ok: false }>["reason"];
export class DesktopStoreError extends Error {
  constructor(readonly reason: StoreReason) { super(`desktop_store_${reason}`); }
}
export type Projection = Record<string, unknown>;
export interface Baseline {
  version: 1; owner: DesktopRemoteOwner; home: string; library: string; targetId: string;
  kind: "known" | "standard_fallback"; targetExisted: boolean; projection: Projection;
  priorSelection: { id: string; hash: string } | null;
}
export interface ArtifactPending {
  kind: "apply" | "rotate" | "restore"; before: string; after: string;
  beforeSelection: string | null; afterSelection: string | null;
  tokenFingerprint: string;
}
export interface StoreState {
  version: 1; owner: DesktopRemoteOwner; home: string; library: string; targetId: string;
  baselineRef: "baseline.json"; baselineHash: string; baselineKind: Baseline["kind"];
  phase: "prepared" | "active" | "restored" | "cleaned";
  lastProjectionHash: string; tokenFingerprint: string; pending?: ArtifactPending;
}
export interface DesktopDisconnectReceipt {
  version: 1; owner: DesktopRemoteOwner; tokenFingerprint: string; keepCatalog: boolean;
  phase: "prepared" | "desktop_restored" | "catalog_settled" | "removing_token" | "token_removed"
    | "clearing_connection" | "connection_cleared" | "complete";
  desktopAfterFingerprint?: string;
  catalogAfter?: { kind: "absent" } | { kind: "file"; fingerprint: string };
}
export const DISCONNECT_PHASES = ["prepared", "desktop_restored", "catalog_settled", "removing_token", "token_removed", "clearing_connection", "connection_cleared", "complete"] as const;
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : isRecord(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  const text = JSON.stringify(sort(value));
  if (text === undefined) throw new DesktopStoreError("unsafe");
  return text;
}
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function projection(value: Record<string, unknown>): Projection {
  return Object.fromEntries(Object.entries(value).filter(([key]) => OPENCODEX_DESKTOP_PROFILE_KEYS.has(key)));
}
export function projectionHash(value: Record<string, unknown> | null): string {
  return digest(canonical(value === null ? null : projection(value)));
}
export function mergeProjection(current: Record<string, unknown>, owned: Projection): Record<string, unknown> {
  return { ...Object.fromEntries(Object.entries(current).filter(([k]) => !OPENCODEX_DESKTOP_PROFILE_KEYS.has(k))), ...owned };
}
export function sameOwner(a: DesktopRemoteOwner, b: DesktopRemoteOwner): boolean { return canonical(a) === canonical(b); }
export function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(k => !keys.includes(k))) throw new DesktopStoreError("unsafe");
}
export function origin(value: unknown): string {
  if (typeof value !== "string") throw new DesktopStoreError("unsafe");
  let url: URL;
  try { url = new URL(value); } catch { throw new DesktopStoreError("unsafe"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['/', '/v1', '/v1/'].includes(url.pathname)) throw new DesktopStoreError("unsafe");
  return url.origin;
}
export function parseOwner(value: unknown): DesktopRemoteOwner {
  if (!isRecord(value)) throw new DesktopStoreError("unsafe");
  exact(value, ["serverUrl", "apiKeyId", "connectedAt"]);
  if (typeof value.apiKeyId !== "string" || !value.apiKeyId || value.apiKeyId.length > 256
    || typeof value.connectedAt !== "string" || !Number.isFinite(Date.parse(value.connectedAt))
    || origin(value.serverUrl) !== value.serverUrl) throw new DesktopStoreError("unsafe");
  return value as DesktopRemoteOwner;
}
export function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function parseState(value: unknown): StoreState {
  if (!isRecord(value)) throw new DesktopStoreError("unsafe");
  exact(value, ["version", "owner", "home", "library", "targetId", "baselineRef", "baselineHash", "baselineKind", "phase", "lastProjectionHash", "tokenFingerprint", "pending"]);
  parseOwner(value.owner);
  if (value.version !== 1 || typeof value.home !== "string" || typeof value.library !== "string"
    || typeof value.targetId !== "string" || !SAFE_DESKTOP_PROFILE_ID.test(value.targetId)
    || value.baselineRef !== "baseline.json" || !isHash(value.baselineHash) || !isHash(value.lastProjectionHash)
    || !isHash(value.tokenFingerprint) || !["known", "standard_fallback"].includes(String(value.baselineKind))
    || !["prepared", "active", "restored", "cleaned"].includes(String(value.phase))) throw new DesktopStoreError("unsafe");
  if (value.pending !== undefined) {
    const p = value.pending;
    if (!isRecord(p)) throw new DesktopStoreError("unsafe");
    exact(p, ["kind", "before", "after", "beforeSelection", "afterSelection", "tokenFingerprint"]);
    if (!['apply', 'rotate', 'restore'].includes(String(p.kind)) || !isHash(p.before) || !isHash(p.after) || !isHash(p.tokenFingerprint)
      || [p.beforeSelection, p.afterSelection].some(id => id !== null && (typeof id !== "string" || !SAFE_DESKTOP_PROFILE_ID.test(id)))) throw new DesktopStoreError("unsafe");
  }
  return value as unknown as StoreState;
}
export function parseBaseline(value: unknown): Baseline {
  if (!isRecord(value)) throw new DesktopStoreError("unsafe");
  exact(value, ["version", "owner", "home", "library", "targetId", "kind", "targetExisted", "projection", "priorSelection"]);
  parseOwner(value.owner);
  if (value.version !== 1 || typeof value.home !== "string" || typeof value.library !== "string"
    || typeof value.targetId !== "string" || !SAFE_DESKTOP_PROFILE_ID.test(value.targetId)
    || !["known", "standard_fallback"].includes(String(value.kind)) || typeof value.targetExisted !== "boolean"
    || !isRecord(value.projection) || Object.keys(value.projection).some(k => !OPENCODEX_DESKTOP_PROFILE_KEYS.has(k))) throw new DesktopStoreError("unsafe");
  if (value.kind === "standard_fallback" && Object.keys(value.projection).length) throw new DesktopStoreError("unsafe");
  if (value.priorSelection !== null) {
    const p = value.priorSelection;
    if (!isRecord(p)) throw new DesktopStoreError("unsafe");
    exact(p, ["id", "hash"]);
    if (typeof p.id !== "string" || !SAFE_DESKTOP_PROFILE_ID.test(p.id) || !isHash(p.hash)) throw new DesktopStoreError("unsafe");
  }
  return value as unknown as Baseline;
}
export function parseDisconnect(value: unknown): DesktopDisconnectReceipt {
  if (!isRecord(value)) throw new DesktopStoreError("unsafe");
  exact(value, ["version", "owner", "tokenFingerprint", "keepCatalog", "phase", "desktopAfterFingerprint", "catalogAfter"]);
  parseOwner(value.owner);
  if (value.version !== 1 || !isHash(value.tokenFingerprint) || typeof value.keepCatalog !== "boolean"
    || !DISCONNECT_PHASES.includes(value.phase as DesktopDisconnectReceipt['phase'])
    || (value.desktopAfterFingerprint !== undefined && !isHash(value.desktopAfterFingerprint))) throw new DesktopStoreError("unsafe");
  if (value.catalogAfter !== undefined) {
    const c = value.catalogAfter;
    if (!isRecord(c)) throw new DesktopStoreError("unsafe");
    exact(c, c.kind === "absent" ? ["kind"] : ["kind", "fingerprint"]);
    if (c.kind !== "absent" && (c.kind !== "file" || !isHash(c.fingerprint))) throw new DesktopStoreError("unsafe");
  }
  return value as unknown as DesktopDisconnectReceipt;
}

import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config/atomic-write";
import { dirname } from "node:path";
import { linkKnownHostsPath, linkStorePath } from "../../link/paths";
import { clearCompensationFailed, compensationPath, markCompensationFailed } from "../../link/compensation";
import { readLinkStore, writeLinkStore, type LinkStore } from "../../link/store";
import { withoutAliasLines } from "../../link/route-trust";
import { boundHint, createSshRunner, type SshRunner } from "../../link/ssh-runner";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import type { ManagementContext } from "./context";
import { issueApiKeyInProcess, revokeApiKeyInProcess, type IssuedApiKey } from "./oauth-account-routes";

export interface PendingLinkHost {
  alias: string;
  fingerprint: string;
  keyType: string;
  knownHostLine: string;
  probedAt: number;
  sshLatencyMs?: number;
  remotePlatform?: "posix" | "windows";
  runtimeKind?: "full" | "ephemeral" | "missing";
  targetTriple?: import("../../link/child-binary-source").ChildTargetTriple | null;
  /** The explicit route every SSH command of this enrollment uses; the record keeps it (link-route-request.ts). */
  explicitRoute?: import("../../link/explicit-route").ExplicitRoute;
  exclusive?: true;
}

export interface ConfirmedLinkHost extends PendingLinkHost {
  ocxVersion: string | null;
  plantable?: boolean;
  binarySizeBytes?: number;
  plantUnavailableReason?: import("../../link/child-binary-source").PlantUnavailableReason;
}

export interface LinkRouteListener {
  ensureStarted(): Promise<void>;
  status(): { state: "off" | "listening" | "failed"; port: number | null; reason: string | null };
  close(): Promise<void>;
  onAuthenticatedCatalog(listener: (apiKeyId: string) => void): () => void;
  /** Optional so route fakes stay small; without it every link reports an unknown peer. */
  peerObservation?(linkId: string): import("../../link/peer-report").LinkPeerEntry;
  /** Optional: without it every link's activity reads unknown (never idle). */
  linkActivity?(linkId: string, now: number): import("../../link/child-activity").LinkActivitySnapshot;
  /** Optional: closes the link's Responses WebSockets after a revoke commits (route fakes omit it). */
  closeLinkSockets?(linkId: string): number;
  /** Optional: the link's live WebSocket counters (design 9.3); without it every row reports zeros. */
  linkTransport?(linkId: string): import("../../link/status-projection").LinkWsCounters;
  /** Optional: the link's WebSocket activity holds and their reasons; null when nothing holds it (D8). */
  linkHolds?(linkId: string): import("../../link/ws-activity-holds").LinkHoldsSummary | null;
  /** Optional: the operator's clear of one link's activity holds (D8). */
  clearLinkHolds?(linkId: string): import("../../link/ws-activity-holds").ClearHoldsResult;
  /** Optional: without it a Home row's traffic reads zero since now. */
  linkTraffic?(linkId: string): import("../../link/traffic").LinkTrafficCounters;
  /** Optional: without it only the cached pull in child-observations.json is known. */
  catalogPull?(linkId: string): import("../../link/child-catalog-freshness").CatalogPull | null;
  /** Optional: persist pulls held inside the recorder's 30 s write window (best effort). */
  flushCatalogPulls?(): void;
}

export interface LinkRouteState {
  pendingHosts: Map<string, PendingLinkHost>;
  operations?: Set<string>;
  confirmedHosts?: Map<string, ConfirmedLinkHost>;
  compensationFailures?: Map<string, { since: string; reason: "compensation_failed" }>;
  supervisor: import("../../link/supervisor").LinkSupervisor;
  listener: LinkRouteListener;
  /** The process-wide engine (sharedChildOpsEngine), cached on first use; a direct test may set its own. */
  childOps?: import("../../link/child-ops-engine").ChildOpsEngine;
  /** The Home catalog revision read on `?children=1`; defaults to the shared production monitor. */
  catalogRevision?: import("../../link/child-catalog-freshness").CatalogRevisionMonitor;
}

export function fail(code: string, message: string, status: number, hint?: string): Response {
  return Response.json({ error: { code, message, ...(hint ? { hint } : {}) } }, { status, headers: { "cache-control": "no-store" } });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exactBody(body: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]) ? body : null;
}

export function port(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** A GUI session redeemed from an operator-created, one-use pairing grant. */
export function pairedSession(ctx: ManagementContext): boolean {
  return ctx.principal === "gui-session"
    && ctx.sessionControl?.isPaired(ctx.req, ctx.config) === true;
}

/**
 * A paired session, or on a standalone runtime the current loopback-issued session that reached
 * the public listener bound to a loopback hostname. The loopback bootstrap mints that session
 * without a credential, so this is casual-path protection like POST /api/github/star, not a
 * secret-backed boundary like the admin token. Hubs keep the paired-only rule. Durable operations
 * that require operator approval, such as joining this machine as a Child, use pairedSession.
 */
export function dashboardSession(ctx: ManagementContext): boolean {
  if (pairedSession(ctx)) return true;
  return ctx.principal === "gui-session"
    && (ctx.config.runtimeRole ?? "standalone") === "standalone"
    && ctx.guiSessionIssuance === "loopback"
    && ctx.trustedLoopbackIngress
    && ctx.sessionControl?.isCurrent(ctx.req, ctx.config) === true;
}

export function adminLoopback(ctx: ManagementContext): boolean {
  return ctx.principal === "admin-token" && ctx.trustedLoopbackIngress;
}

export function auth(ctx: ManagementContext, kind: "dashboard" | "paired" | "admin" | "either"): Response | null {
  if (ctx.guiSessionIssuance === "tailscale-identity") return fail("tailscale_session_refused", "Tailscale identity sessions cannot use link routes.", 403);
  const allowed = kind === "dashboard" ? dashboardSession(ctx)
    : kind === "paired" ? pairedSession(ctx)
    : kind === "admin" ? adminLoopback(ctx)
      : dashboardSession(ctx) || adminLoopback(ctx);
  return allowed ? null : fail("forbidden", "The required link authorization was not present.", 403);
}

export function runnerFor(ctx: ManagementContext): SshRunner {
  return ctx.deps.sshRunner ?? createSshRunner();
}

export function readStoreFor(ctx: ManagementContext): LinkStore {
  return ctx.deps.readLinkStore?.() ?? readLinkStore(linkStorePath());
}

export function writeStoreFor(ctx: ManagementContext, store: LinkStore): void {
  (ctx.deps.writeLinkStore ?? (value => writeLinkStore(linkStorePath(), value)))(store);
}

export function knownHostsFile(ctx: ManagementContext): string {
  return ctx.deps.linkKnownHostsPath?.() ?? linkKnownHostsPath();
}

export function putKnownHost(path: string, alias: string, line: string): string {
  const before = (() => { try { return readFileSync(path, "utf8"); } catch { return ""; } })();
  // OpenSSH compares known_hosts names without case, so every spelling of the alias is replaced.
  const lines = withoutAliasLines(before, alias);
  lines.push(line.trim());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, `${lines.join("\n")}\n`);
  return before;
}

/**
 * confirm-host's only write. Inside the config mutation lock, immediately before writing, a
 * Home-initiated link that owns this alias (ignoring case) with another fingerprint refuses it: a
 * link's routes trust exactly its record's key, and a confirmation must not replace that key.
 * False when refused; nothing is written then.
 */
export function putConfirmedKnownHost(ctx: ManagementContext, alias: string, line: string, fingerprint: string): boolean {
  return withConfigMutationLockSync(() => {
    const wanted = alias.toLowerCase();
    const conflict = readStoreFor(ctx).links.some(link => link.direction === "hub-initiated"
      && link.alias.toLowerCase() === wanted && link.hostKeyFingerprint !== fingerprint);
    if (conflict) return false;
    putKnownHost(knownHostsFile(ctx), alias, line);
    return true;
  });
}

export function issueKey(ctx: ManagementContext, name: string, reservedId?: string): IssuedApiKey {
  const issue = ctx.deps.issueApiKey ?? issueApiKeyInProcess;
  return reservedId === undefined ? issue(ctx.config, name) : issue(ctx.config, name, reservedId);
}

export function revokeKey(ctx: ManagementContext, id: string): boolean {
  return (ctx.deps.revokeApiKey ?? revokeApiKeyInProcess)(ctx.config, id);
}

/**
 * Revocation that a retry can repeat. A key that is no longer in the live config is already
 * revoked, which is exactly the state a partially completed cleanup leaves behind; without this
 * a retried DELETE would fail forever on the key it removed the first time.
 */
export function revokeKeyIdempotent(ctx: ManagementContext, id: string): boolean {
  let revoked = false;
  try { revoked = revokeKey(ctx, id); } catch { revoked = false; }
  if (revoked) return true;
  return !(ctx.config.apiKeys ?? []).some(entry => entry.id === id);
}

export function compensationFailure(ctx: ManagementContext, state: LinkRouteState, record: LinkStore["links"][number], phase: string): Response {
  const since = new Date((ctx.deps.now ?? Date.now)()).toISOString();
  (state.compensationFailures ??= new Map()).set(record.id, { since, reason: "compensation_failed" });
  try { markCompensationFailed(record.id, since, compensationPath()); } catch (error) {
    console.warn(`[link] compensation marker persistence failed linkId=${record.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.warn(`[link] compensation_failed linkId=${record.id} phase=${phase}`);
  return fail("compensation_failed", "The link compensation could not be completed.", 500);
}

/** A link that was never stored, or not restored, whose issued key could not be revoked. */
export function keyCleanupFailed(): Response {
  return fail("key_cleanup_failed", "The link was not created, but its issued key could not be revoked; revoke the leftover link key under API keys.", 500);
}

/**
 * Undo a new link. When its key will not revoke, the record is kept (stored again if absent) so the
 * leftover key stays attached to a visible link. `stillValid` guards that re-insert: it runs inside
 * the same lock as the write, and a record that no longer passes it (its alias or pin changed while
 * this waited) is never stored; the key is reported instead (`key_cleanup_failed`).
 */
export async function compensateNewLink(ctx: ManagementContext, state: LinkRouteState, record: LinkStore["links"][number], stillValid?: (current: LinkStore) => boolean): Promise<Response | null> {
  const revoked = revokeKeyIdempotent(ctx, record.apiKeyId);
  if (!revoked) {
    try { await state.supervisor.stopLink(record.id); } catch { /* retain the record and failure marker */ }
    let rejected = false, uncertain = false;
    try {
      withConfigMutationLockSync(() => {
        const current = readStoreFor(ctx);
        if (!current.links.some(link => link.id === record.id)) {
          if (stillValid && !stillValid(current)) { rejected = true; return; }
          writeStoreFor(ctx, { ...current, links: [...current.links, record] });
        }
      });
    } catch {
      // Whether the link is stored is now unknown. The in-memory marker shows it if it is; the
      // response says the key may be left over either way.
      uncertain = true;
    }
    if (rejected) {
      console.warn("[link] new link no longer valid after a failed store write; its issued key could not be revoked");
      return keyCleanupFailed();
    }
    if (uncertain) {
      compensationFailure(ctx, state, record, "revoke");
      return fail("link_cleanup_uncertain", "The link could not be undone: whether it is stored is unknown and its issued key could not be revoked. Check the link status, remove the link if it is listed, and revoke the leftover link key under API keys if it remains.", 500);
    }
    return compensationFailure(ctx, state, record, "revoke");
  }
  try { await state.supervisor.stopLink(record.id); } catch { return compensationFailure(ctx, state, record, "stop"); }
  try {
    // Read→filter→write stays one section of the shared mutation lock: a sibling
    // route's create must not land between the read and the rename and vanish.
    const next = withConfigMutationLockSync(() => {
      const current = readStoreFor(ctx);
      const filtered = { ...current, links: current.links.filter(link => link.id !== record.id) };
      if (filtered.links.length !== current.links.length) {
        writeStoreFor(ctx, filtered);
      }
      return filtered;
    });
    clearCompensationFailed(record.id, compensationPath());
    state.compensationFailures?.delete(record.id);
    if (next.links.length === 0) await state.listener.close();
    return null;
  } catch {
    return compensationFailure(ctx, state, record, "store");
  }
}

import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config/atomic-write";
import { dirname } from "node:path";
import { linkKnownHostsPath, linkStorePath } from "../../link/paths";
import { clearCompensationFailed, compensationPath, markCompensationFailed } from "../../link/compensation";
import { readLinkStore, writeLinkStore, type LinkStore } from "../../link/store";
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
}

export interface ConfirmedLinkHost extends PendingLinkHost {
  ocxVersion: string;
}

export interface LinkRouteListener {
  ensureStarted(): Promise<void>;
  status(): { state: "off" | "listening" | "failed"; port: number | null; reason: string | null };
  close(): Promise<void>;
  onAuthenticatedCatalog(listener: (apiKeyId: string) => void): () => void;
  /** Optional so route fakes stay small; without it every link reports an unknown peer. */
  peerObservation?(linkId: string): import("../../link/peer-report").LinkPeerEntry;
}

export interface LinkRouteState {
  pendingHosts: Map<string, PendingLinkHost>;
  operations?: Set<string>;
  confirmedHosts?: Map<string, ConfirmedLinkHost>;
  compensationFailures?: Map<string, { since: string; reason: "compensation_failed" }>;
  supervisor: import("../../link/supervisor").LinkSupervisor;
  listener: LinkRouteListener;
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
  const lines = before.split(/\r?\n/).filter(value => value && !value.startsWith(`${alias} `) && !value.startsWith(`${alias},`));
  lines.push(line.trim());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, `${lines.join("\n")}\n`);
  return before;
}

export function issueKey(ctx: ManagementContext, name: string): IssuedApiKey {
  return (ctx.deps.issueApiKey ?? issueApiKeyInProcess)(ctx.config, name);
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

export async function compensateNewLink(ctx: ManagementContext, state: LinkRouteState, record: LinkStore["links"][number]): Promise<Response | null> {
  const revoked = revokeKeyIdempotent(ctx, record.apiKeyId);
  if (!revoked) {
    try { await state.supervisor.stopLink(record.id); } catch { /* retain the record and failure marker */ }
    try {
      withConfigMutationLockSync(() => {
        const current = readStoreFor(ctx);
        if (!current.links.some(link => link.id === record.id)) {
          writeStoreFor(ctx, { ...current, links: [...current.links, record] });
        }
      });
    } catch {
      // The in-memory marker still makes the residual visible when persistence is unavailable.
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

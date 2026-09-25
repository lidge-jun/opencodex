import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSshAlias, buildExecArgv, buildFingerprintArgv, buildProbeArgv } from "../../link/ssh-argv";
import { parseFingerprintLine } from "../../link/fingerprint";
import { awaitFirstAdmission } from "../../link/admission-wait";
import { linkKnownHostsPath, linkStorePath } from "../../link/paths";
import { clearCompensationFailed, compensationPath, markCompensationFailed, readCompensation } from "../../link/compensation";
import { loadHostCandidates } from "../../link/ssh-config";
import { newLinkId, readLinkStore, writeLinkStore, type LinkStore } from "../../link/store";
import { createSshRunner, type SshRunner } from "../../link/ssh-runner";
import { projectLinkStatus, type LinkStatusDto } from "../../link/status-projection";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { issueApiKeyInProcess, revokeApiKeyInProcess, type IssuedApiKey } from "./oauth-account-routes";

const PROBE_TTL_MS = 5 * 60_000;
const APPLY_ADMISSION_TIMEOUT_MS = 15_000;
const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const isLinkPath = (path: string): boolean => path === "/api/link" || path.startsWith("/api/link/");

export interface PendingLinkHost {
  alias: string;
  fingerprint: string;
  keyType: string;
  knownHostLine: string;
  probedAt: number;
}

export interface ConfirmedLinkHost extends PendingLinkHost {
  ocxVersion: string;
}

export interface LinkRouteListener {
  ensureStarted(): Promise<void>;
  status(): { state: "off" | "listening" | "failed"; port: number | null; reason: string | null };
  close(): Promise<void>;
  onAuthenticatedCatalog(listener: (apiKeyId: string) => void): () => void;
}

export interface LinkRouteState {
  pendingHosts: Map<string, PendingLinkHost>;
  confirmedHosts?: Map<string, ConfirmedLinkHost>;
  compensationFailures?: Map<string, { since: string; reason: "compensation_failed" }>;
  supervisor: import("../../link/supervisor").LinkSupervisor;
  listener: LinkRouteListener;
}

const states = new WeakMap<object, LinkRouteState>();

function fail(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactBody(body: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]) ? body : null;
}

function port(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function dashboardSession(ctx: ManagementContext): boolean {
  return ctx.principal === "gui-session"
    && ctx.sessionControl?.isPaired(ctx.req, ctx.config) === true;
}

function adminLoopback(ctx: ManagementContext): boolean {
  return ctx.principal === "admin-token" && ctx.trustedLoopbackIngress;
}

function auth(ctx: ManagementContext, kind: "dashboard" | "admin" | "either"): Response | null {
  if (ctx.guiSessionIssuance === "tailscale-identity") return fail("tailscale_session_refused", "Tailscale identity sessions cannot use link routes.", 403);
  const dashboard = dashboardSession(ctx);
  const admin = adminLoopback(ctx);
  if ((kind === "dashboard" && !dashboard) || (kind === "admin" && !admin) || (kind === "either" && !dashboard && !admin)) {
    return fail("forbidden", "The required link authorization was not present.", 403);
  }
  return null;
}

function runnerFor(ctx: ManagementContext): SshRunner {
  return ctx.deps.sshRunner ?? createSshRunner();
}

function readStoreFor(ctx: ManagementContext): LinkStore {
  return ctx.deps.readLinkStore?.() ?? readLinkStore(linkStorePath());
}

function writeStoreFor(ctx: ManagementContext, store: LinkStore): void {
  (ctx.deps.writeLinkStore ?? (value => writeLinkStore(linkStorePath(), value)))(store);
}

function stateFor(ctx: ManagementContext): LinkRouteState | null {
  const supervisor = ctx.deps.linkSupervisor?.();
  const listener = ctx.deps.linkListener?.();
  if (!supervisor || !listener) return null;
  const key = ctx.config as object;
  const existing = states.get(key);
  if (existing) return existing;
  const state: LinkRouteState = {
    pendingHosts: new Map(),
    confirmedHosts: new Map(),
    compensationFailures: new Map(),
    supervisor,
    listener,
  };
  states.set(key, state);
  return state;
}

function knownHostsFile(ctx: ManagementContext): string {
  return ctx.deps.linkKnownHostsPath?.() ?? linkKnownHostsPath();
}

function putKnownHost(path: string, alias: string, line: string): string {
  const before = (() => { try { return readFileSync(path, "utf8"); } catch { return ""; } })();
  const lines = before.split(/\r?\n/).filter(value => value && !value.startsWith(`${alias} `) && !value.startsWith(`${alias},`));
  lines.push(line.trim());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
  return before;
}

function restoreKnownHost(path: string, before: string): void {
  if (!before) {
    try { rmSync(path, { force: true }); } catch { /* best effort compensation */ }
    return;
  }
  writeFileSync(path, before, { mode: 0o600 });
}

function issueKey(ctx: ManagementContext, name: string): IssuedApiKey {
  return (ctx.deps.issueApiKey ?? issueApiKeyInProcess)(ctx.config, name);
}

function revokeKey(ctx: ManagementContext, id: string): boolean {
  return (ctx.deps.revokeApiKey ?? revokeApiKeyInProcess)(ctx.config, id);
}

/**
 * Revocation that a retry can repeat. A key that is no longer in the live config is already
 * revoked, which is exactly the state a partially completed cleanup leaves behind; without this
 * a retried DELETE would fail forever on the key it removed the first time.
 */
function revokeKeyIdempotent(ctx: ManagementContext, id: string): boolean {
  let revoked = false;
  try { revoked = revokeKey(ctx, id); } catch { revoked = false; }
  if (revoked) return true;
  return !(ctx.config.apiKeys ?? []).some(entry => entry.id === id);
}

function compensationFailure(ctx: ManagementContext, state: LinkRouteState, record: LinkStore["links"][number], phase: string): Response {
  const since = new Date((ctx.deps.now ?? Date.now)()).toISOString();
  (state.compensationFailures ??= new Map()).set(record.id, { since, reason: "compensation_failed" });
  try { markCompensationFailed(record.id, since, compensationPath()); } catch (error) {
    console.warn(`[link] compensation marker persistence failed linkId=${record.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.warn(`[link] compensation_failed linkId=${record.id} phase=${phase}`);
  return fail("compensation_failed", "The link compensation could not be completed.", 500);
}

async function compensateNewLink(ctx: ManagementContext, state: LinkRouteState, record: LinkStore["links"][number]): Promise<Response | null> {
  const revoked = revokeKeyIdempotent(ctx, record.apiKeyId);
  if (!revoked) {
    try { await state.supervisor.stopLink(record.id); } catch { /* retain the record and failure marker */ }
    try {
      const current = readStoreFor(ctx);
      if (!current.links.some(link => link.id === record.id)) {
        writeStoreFor(ctx, { ...current, links: [...current.links, record] });
      }
    } catch {
      // The in-memory marker still makes the residual visible when persistence is unavailable.
    }
    return compensationFailure(ctx, state, record, "revoke");
  }
  try { await state.supervisor.stopLink(record.id); } catch { return compensationFailure(ctx, state, record, "stop"); }
  try {
    const current = readStoreFor(ctx);
    const next = { ...current, links: current.links.filter(link => link.id !== record.id) };
    if (next.links.length !== current.links.length) {
      writeStoreFor(ctx, next);
    }
    clearCompensationFailed(record.id, compensationPath());
    state.compensationFailures?.delete(record.id);
    if (next.links.length === 0) await state.listener.close();
    return null;
  } catch {
    return compensationFailure(ctx, state, record, "store");
  }
}

async function candidates(ctx: ManagementContext): Promise<Response> {
  const values = ctx.deps.loadLinkCandidates?.() ?? loadHostCandidates();
  return Response.json({ candidates: values.map(value => ({ alias: value.alias, source: value.source })) });
}

async function probe(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const body = exactBody(await readManagementJsonBodyOr(ctx.req, null), ["alias"]);
  if (!body || typeof body.alias !== "string") return fail("invalid_body", "alias is required.", 400);
  try { assertSshAlias(body.alias); } catch { return fail("invalid_alias", "alias must be a valid SSH host alias.", 400); }
  const dir = mkdtempSync(join(tmpdir(), "ocx-link-probe-"));
  const tempKnownHosts = join(dir, "known_hosts");
  writeFileSync(tempKnownHosts, "", { mode: 0o600 });
  const runner = runnerFor(ctx);
  try {
    const result = await runner.run(buildProbeArgv({ alias: body.alias, tempKnownHostsFile: tempKnownHosts }), { timeoutMs: 30_000 });
    if (result.code !== 0) return fail("probe_failed", "SSH host probing failed.", 502);
    const fingerprintResult = await runner.run(buildFingerprintArgv(tempKnownHosts), { timeoutMs: 10_000 });
    if (fingerprintResult.code !== 0) return fail("fingerprint_failed", "The SSH host fingerprint could not be read.", 502);
    const parsed = parseFingerprintLine(fingerprintResult.stdout.trim());
    const knownHostLine = readFileSync(tempKnownHosts, "utf8").trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!knownHostLine) return fail("fingerprint_failed", "The SSH probe did not record a host key.", 502);
    state.pendingHosts.set(body.alias, { alias: body.alias, fingerprint: parsed.fingerprint, keyType: parsed.keyType, knownHostLine, probedAt: (ctx.deps.now ?? Date.now)() });
    return Response.json({ alias: body.alias, fingerprint: parsed.fingerprint, keyType: parsed.keyType });
  } catch {
    return fail("probe_failed", "SSH host probing failed.", 502);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function confirmHost(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const body = exactBody(await readManagementJsonBodyOr(ctx.req, null), ["alias", "fingerprint"]);
  if (!body || typeof body.alias !== "string" || typeof body.fingerprint !== "string") return fail("invalid_body", "alias and fingerprint are required.", 400);
  const pending = state.pendingHosts.get(body.alias);
  const now = (ctx.deps.now ?? Date.now)();
  if (!pending || now - pending.probedAt > PROBE_TTL_MS) return fail("host_confirmation_expired", "The SSH host probe has expired.", 409);
  if (pending.fingerprint !== body.fingerprint) return fail("host_fingerprint_mismatch", "The confirmed fingerprint does not match the probe.", 409);
  const path = knownHostsFile(ctx);
  const before = putKnownHost(path, pending.alias, pending.knownHostLine);
  try {
    const result = await runnerFor(ctx).run(buildExecArgv({ alias: pending.alias, argv: ["ocx", "--version"], knownHostsFile: path }), { timeoutMs: 30_000 });
    if (result.code !== 0 || !result.stdout.trim()) throw new Error("version probe failed");
    const confirmed = { ...pending, ocxVersion: result.stdout.trim().split(/\r?\n/)[0]! };
    state.confirmedHosts ??= new Map();
    state.confirmedHosts.set(pending.alias, confirmed);
    state.pendingHosts.delete(pending.alias);
    return Response.json({ alias: pending.alias, fingerprint: pending.fingerprint, ocxVersion: confirmed.ocxVersion });
  } catch {
    restoreKnownHost(path, before);
    return fail("version_probe_failed", "The remote ocx version could not be confirmed.", 502);
  }
}

function parsePortOutput(stdout: string): number | null {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (!isRecord(value) || Object.keys(value).length !== 1 || !port(value.port)) return null;
    return value.port;
  } catch { return null; }
}

async function apply(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const body = exactBody(await readManagementJsonBodyOr(ctx.req, null), ["alias"]);
  if (!body || typeof body.alias !== "string") return fail("invalid_body", "alias is required.", 400);
  const confirmed = state.confirmedHosts?.get(body.alias);
  if (!confirmed) return fail("host_not_confirmed", "Confirm the SSH host before applying the link.", 409);
  const knownHosts = knownHostsFile(ctx);
  const runner = runnerFor(ctx);
  let remotePort: number;
  try {
    const result = await runner.run(buildExecArgv({ alias: body.alias, argv: ["ocx", "link", "port"], knownHostsFile: knownHosts }), { timeoutMs: 30_000 });
    remotePort = result.code === 0 ? parsePortOutput(result.stdout) ?? 0 : 0;
  } catch { remotePort = 0; }
  if (!port(remotePort)) return fail("remote_port_failed", "The remote link port could not be determined.", 502);
  let issued: IssuedApiKey;
  try { issued = issueKey(ctx, `link:${body.alias}`); }
  catch { return fail("key_issue_failed", "The link key could not be issued.", 503); }
  const id = newLinkId();
  const record = { id, alias: body.alias, direction: "hub-initiated" as const, hostKeyFingerprint: confirmed.fingerprint, tunnelPort: remotePort, apiKeyId: issued.id, createdAt: new Date((ctx.deps.now ?? Date.now)()).toISOString() };
  let store: LinkStore;
  try {
    const current = readStoreFor(ctx);
    if (current.links.some(link => link.alias === body.alias && link.direction === "hub-initiated")) {
      const compensation = await compensateNewLink(ctx, state, record);
      if (compensation) return compensation;
      return fail("link_exists", "A link for this alias already exists.", 409);
    }
    store = { ...current, links: [...current.links, record] };
    writeStoreFor(ctx, store);
    await state.listener.ensureStarted();
    if (state.listener.status().state !== "listening") {
      const compensation = await compensateNewLink(ctx, state, record);
      return compensation ?? fail("listener_unavailable", "The link listener is unavailable.", 503);
    }
    await state.supervisor.ensureStarted();
    await state.supervisor.reload();
  } catch {
    const compensation = await compensateNewLink(ctx, state, record);
    if (compensation) return compensation;
    return fail("link_apply_failed", "The link could not be started.", 503);
  }
  const admission = awaitFirstAdmission(issued.id, APPLY_ADMISSION_TIMEOUT_MS, state.listener.onAuthenticatedCatalog);
  const input = new TextEncoder().encode(JSON.stringify({ apiKeyId: issued.id, key: issued.key }));
  try {
    const result = await runner.run(buildExecArgv({ alias: body.alias, argv: ["ocx", "connect", "--link", "--key-stdin", "--tunnel-port", String(remotePort), "--link-id", id], knownHostsFile: knownHosts }), { stdin: input, timeoutMs: APPLY_ADMISSION_TIMEOUT_MS });
    if (result.code !== 0) {
      void admission.catch(() => {});
      const compensation = await compensateNewLink(ctx, state, record);
      return compensation ?? fail("remote_connect_failed", "The remote link connection failed.", 502);
    }
    try {
      await admission;
    } catch {
      const compensation = await compensateNewLink(ctx, state, record);
      return compensation ?? fail("admission_timeout", "The remote link did not authenticate a catalog request in time.", 502);
    }
    return Response.json({ linkId: id }, { status: 202 });
  } catch {
    void admission.catch(() => {});
    const compensation = await compensateNewLink(ctx, state, record);
    return compensation ?? fail("remote_connect_failed", "The remote link connection failed.", 502);
  } finally {
    input.fill(0);
  }
}

async function issue(ctx: ManagementContext): Promise<Response> {
  const body = exactBody(await readManagementJsonBodyOr(ctx.req, null), ["alias", "tunnelPort"]);
  if (!body || typeof body.alias !== "string" || !port(body.tunnelPort)) return fail("invalid_body", "alias and tunnelPort are required.", 400);
  try { assertSshAlias(body.alias); } catch { return fail("invalid_alias", "alias must be a valid SSH host alias.", 400); }
  let issued: IssuedApiKey;
  try { issued = issueKey(ctx, `link:${body.alias}`); }
  catch { return fail("key_issue_failed", "The link key could not be issued.", 503); }
  const id = newLinkId();
  const state = stateFor(ctx);
  if (!state) {
    if (!revokeKeyIdempotent(ctx, issued.id)) {
      console.warn(`[link] compensation_failed apiKeyId=${issued.id} phase=revoke-without-lifecycle`);
      return fail("compensation_failed", "The link compensation could not be completed.", 500);
    }
    return fail("link_unavailable", "The link lifecycle is unavailable.", 503);
  }
  const record = { id, alias: body.alias, direction: "client-initiated" as const, hostKeyFingerprint: null, tunnelPort: body.tunnelPort, apiKeyId: issued.id, createdAt: new Date((ctx.deps.now ?? Date.now)()).toISOString() };
  let failureCode = "link_issue_failed";
  try {
    const current = readStoreFor(ctx);
    if (current.links.some(link => link.id === id)) throw new Error("link id collision");
    if (current.links.some(link => link.alias === body.alias && link.direction === "client-initiated")) {
      const compensation = await compensateNewLink(ctx, state, record);
      return compensation ?? fail("link_exists", "A link for this alias already exists.", 409);
    }
    writeStoreFor(ctx, { ...current, links: [...current.links, record] });
    await state.listener.ensureStarted();
    if (state.listener.status().state !== "listening") {
      failureCode = "listener_unavailable";
      throw new Error("link listener unavailable");
    }
    const boundStore = readStoreFor(ctx);
    if (!port(boundStore.listenerPort)) throw new Error("link listener did not bind");
    return Response.json({ linkId: id, apiKeyId: issued.id, key: issued.key, listenerPort: boundStore.listenerPort });
  } catch {
    const compensation = await compensateNewLink(ctx, state, record);
    return compensation ?? fail(failureCode, failureCode === "listener_unavailable" ? "The link listener is unavailable." : "The link could not be issued.", 503);
  }
}

async function remove(ctx: ManagementContext, state: LinkRouteState, id: string): Promise<Response> {
  if (!LINK_ID.test(id)) return fail("invalid_link_id", "The link id is invalid.", 400);
  const current = readStoreFor(ctx);
  const record = current.links.find(link => link.id === id);
  if (!record) return fail("link_not_found", "The link was not found.", 404);
  const body = await readManagementJsonBodyOr(ctx.req, {});
  if (!isRecord(body) || Object.keys(body).some(key => key !== "force") || (body.force !== undefined && typeof body.force !== "boolean")) return fail("invalid_body", "force must be a boolean.", 400);
  const force = body.force === true;
  await state.supervisor.stopLink(id);
  const restartTunnel = async (): Promise<void> => {
    try {
      await state.supervisor.ensureStarted();
      await state.supervisor.reload();
    } catch (error) {
      console.warn(`[link] tunnel restart failed linkId=${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (!force && record.direction === "hub-initiated") {
    try {
      const result = await runnerFor(ctx).run(buildExecArgv({ alias: record.alias, argv: ["ocx", "disconnect"], knownHostsFile: knownHostsFile(ctx) }), { timeoutMs: 30_000 });
      if (result.code !== 0) {
        await restartTunnel();
        return fail("remote_disconnect_failed", "The remote client could not be disconnected.", 502);
      }
    } catch {
      await restartTunnel();
      return fail("remote_disconnect_failed", "The remote client could not be disconnected.", 502);
    }
  }
  if (!revokeKeyIdempotent(ctx, record.apiKeyId)) return fail("key_revoke_failed", "The link key could not be revoked.", 502);
  let next: LinkStore;
  try {
    const latest = readStoreFor(ctx);
    next = { ...latest, links: latest.links.filter(link => link.id !== id) };
    if (next.links.length !== latest.links.length) writeStoreFor(ctx, next);
    clearCompensationFailed(id, compensationPath());
  } catch { return fail("link_remove_failed", "The link record could not be removed.", 503); }
  state.compensationFailures?.delete(id);
  if (next.links.length === 0) await state.listener.close();
  return Response.json({ linkId: id });
}

export async function handleLinkRoutes(ctx: ManagementContext, suppliedState?: LinkRouteState): Promise<Response | null> {
  const { url, req } = ctx;
  const path = url.pathname;
  if (!isLinkPath(path)) return null;
  if (ctx.guiSessionIssuance === "tailscale-identity") return fail("tailscale_session_refused", "Tailscale identity sessions cannot use link routes.", 403);
  const state = suppliedState ?? stateFor(ctx);
  if (!state) return fail("link_unavailable", "The link lifecycle is unavailable.", 503);
  if (url.pathname === "/api/link/status" && req.method === "GET") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    const store = readStoreFor(ctx);
    const listenerStatus = state.listener.status();
    const dto: LinkStatusDto = projectLinkStatus(store, state.supervisor.status(), listenerStatus, ctx.config, readCompensation());
    for (const link of dto.links) {
      const failure = state.compensationFailures?.get(link.id);
      if (failure) Object.assign(link, { state: "failed" as const, since: failure.since, reason: failure.reason });
    }
    if (dto.child && store.links[0]) {
      const failure = state.compensationFailures?.get(store.links[0].id);
      if (failure) Object.assign(dto.child, { state: "failed" as const, since: failure.since, reason: failure.reason });
    }
    return Response.json(dto, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/api/link/candidates" && req.method === "GET") {
    const denied = auth(ctx, "dashboard");
    if (denied) return denied;
    return candidates(ctx);
  }
  if (url.pathname === "/api/link/probe" && req.method === "POST") {
    const denied = auth(ctx, "dashboard");
    if (denied) return denied;
    return probe(ctx, state);
  }
  if (url.pathname === "/api/link/confirm-host" && req.method === "POST") {
    const denied = auth(ctx, "dashboard");
    if (denied) return denied;
    return confirmHost(ctx, state);
  }
  if (url.pathname === "/api/link/apply" && req.method === "POST") {
    const denied = auth(ctx, "dashboard");
    if (denied) return denied;
    return apply(ctx, state);
  }
  if (url.pathname === "/api/link/issue" && req.method === "POST") {
    const denied = auth(ctx, "admin");
    if (denied) return denied;
    return issue(ctx);
  }
  if (req.method === "DELETE" && path.startsWith("/api/link/")) {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    let id: string;
    try { id = decodeURIComponent(path.slice("/api/link/".length)); } catch { return fail("invalid_link_id", "The link id is invalid.", 400); }
    return remove(ctx, state, id);
  }
  return null;
}

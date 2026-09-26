import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSshAlias, buildExecArgv, buildFingerprintArgv, buildProbeArgv, REMOTE_COMMAND_NOT_FOUND, remoteOcxArgv } from "../../link/ssh-argv";
import { parseFingerprintLine } from "../../link/fingerprint";
import { awaitFirstAdmission } from "../../link/admission-wait";
import { linkKnownHostsPath, linkStorePath } from "../../link/paths";
import { clearCompensationFailed, compensationPath, markCompensationFailed, readCompensation } from "../../link/compensation";
import { loadHostCandidates } from "../../link/ssh-config";
import { newLinkId, readLinkStore, writeLinkStore, type LinkStore } from "../../link/store";
import { boundHint, createSshRunner, sshFailureHint, sshRunnerErrorHint, type SshRunner, type SshRunResult } from "../../link/ssh-runner";
import { projectLinkStatus, type LinkStatusDto } from "../../link/status-projection";
import { isLinkPort } from "../../link/ports";
import { joinHome, type ClientLinkJoinDeps } from "../../client/link-join";
import { clientLinkTunnelStatus } from "../../client/link-tunnel";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { issueApiKeyInProcess, revokeApiKeyInProcess, type IssuedApiKey } from "./oauth-account-routes";
import { acceptSystemRestart } from "./system-restart";

const PROBE_TTL_MS = 5 * 60_000;
const APPLY_ADMISSION_TIMEOUT_MS = 15_000;
const LINK_ID = /^lnk_[0-9a-f]{16}$/;
// `ocx link` and `ocx connect --link` first shipped in 2.66.0; an older remote passes --version
// and then fails at apply with remote_port_failed.
const MIN_REMOTE_OCX = [2, 66, 0] as const;
// A bounded semver shape: the parsed version reaches the confirm-host body and the outdated hint,
// so the tail admits only a pre-release and build of semver identifier characters and must end
// the token. Anything else attached to the version makes the output unrecognized.
const REMOTE_OCX_VERSION = /^opencodex (\d{1,9})\.(\d{1,9})\.(\d{1,9})(-[0-9A-Za-z.-]{1,64})?(\+[0-9A-Za-z.-]{1,64})?(?=\s|$)/;
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
// One process runs at most one join: a join ends by restarting this process as a client.
let joinInProgress = false;

/**
 * `hint` is one line bounded by `boundHint`: from ssh stderr (`sshFailureHint`), from the ssh
 * runner's own failure (`sshRunnerErrorHint`), or the parsed remote version for
 * `remote_ocx_outdated`. It is returned, never logged.
 */
function fail(code: string, message: string, status: number, hint?: string): Response {
  return Response.json({ error: { code, message, ...(hint ? { hint } : {}) } }, { status, headers: { "cache-control": "no-store" } });
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

/** A paired GUI session. `POST /api/link/join` admits only this. */
function pairedSession(ctx: ManagementContext): boolean {
  return ctx.principal === "gui-session"
    && ctx.sessionControl?.isPaired(ctx.req, ctx.config) === true;
}

/**
 * A paired session, or on a standalone runtime the current loopback-issued session that reached
 * the public listener bound to a loopback hostname. The loopback bootstrap mints that session
 * without a credential, so this is casual-path protection like POST /api/github/star, not a
 * secret-backed boundary like the admin token. Hubs keep the paired-only rule, and so does join:
 * a join restarts this runtime and moves Codex routing to the Home, which drops live connections.
 */
function dashboardSession(ctx: ManagementContext): boolean {
  if (pairedSession(ctx)) return true;
  return ctx.principal === "gui-session"
    && (ctx.config.runtimeRole ?? "standalone") === "standalone"
    && ctx.guiSessionIssuance === "loopback"
    && ctx.trustedLoopbackIngress
    && ctx.sessionControl?.isCurrent(ctx.req, ctx.config) === true;
}

function adminLoopback(ctx: ManagementContext): boolean {
  return ctx.principal === "admin-token" && ctx.trustedLoopbackIngress;
}

function auth(ctx: ManagementContext, kind: "paired" | "dashboard" | "admin" | "either"): Response | null {
  if (ctx.guiSessionIssuance === "tailscale-identity") return fail("tailscale_session_refused", "Tailscale identity sessions cannot use link routes.", 403);
  const allowed = kind === "paired" ? pairedSession(ctx)
    : kind === "dashboard" ? dashboardSession(ctx)
      : kind === "admin" ? adminLoopback(ctx)
        : dashboardSession(ctx) || adminLoopback(ctx);
  return allowed ? null : fail("forbidden", "The required link authorization was not present.", 403);
}

/** Whether `POST /api/link/join` would pass its admission and role gates for this caller. */
function joinAvailable(ctx: ManagementContext): boolean {
  return pairedSession(ctx) && (ctx.config.runtimeRole ?? "standalone") === "standalone";
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
    if (result.code !== 0) return fail("probe_failed", "SSH host probing failed.", 502, sshFailureHint(result.stderr));
    const fingerprintResult = await runner.run(buildFingerprintArgv(tempKnownHosts), { timeoutMs: 10_000 });
    if (fingerprintResult.code !== 0) return fail("fingerprint_failed", "The SSH host fingerprint could not be read.", 502, sshFailureHint(fingerprintResult.stderr));
    const parsed = parseFingerprintLine(fingerprintResult.stdout.trim());
    const knownHostLine = readFileSync(tempKnownHosts, "utf8").trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!knownHostLine) return fail("fingerprint_failed", "The SSH probe did not record a host key.", 502);
    state.pendingHosts.set(body.alias, { alias: body.alias, fingerprint: parsed.fingerprint, keyType: parsed.keyType, knownHostLine, probedAt: (ctx.deps.now ?? Date.now)() });
    return Response.json({ alias: body.alias, fingerprint: parsed.fingerprint, keyType: parsed.keyType });
  } catch (error) {
    return fail("probe_failed", "SSH host probing failed.", 502, sshRunnerErrorHint(error));
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
  // Every refusal restores known_hosts and keeps the pending probe, so a retry within its TTL works.
  const refuse = (response: Response): Response => { restoreKnownHost(path, before); return response; };
  let result: SshRunResult;
  try {
    result = await runnerFor(ctx).run(buildExecArgv({ alias: pending.alias, argv: remoteOcxArgv(["--version"]), knownHostsFile: path }), { timeoutMs: 30_000 });
  } catch (error) {
    return refuse(fail("version_probe_failed", "The remote ocx version could not be confirmed.", 502, sshRunnerErrorHint(error)));
  }
  if (result.code === REMOTE_COMMAND_NOT_FOUND) return refuse(fail("remote_ocx_missing", "ocx was not found on the remote host.", 502, sshFailureHint(result.stderr)));
  if (result.code !== 0) return refuse(fail("version_probe_failed", "The remote ocx version could not be confirmed.", 502, sshFailureHint(result.stderr)));
  const version = parseRemoteOcxVersion(result.stdout);
  if (!version) return refuse(fail("remote_ocx_unrecognized", "The remote ocx did not report an OpenCodex version.", 502));
  if (!meetsRemoteOcxFloor(version.parts)) {
    return refuse(fail("remote_ocx_outdated", `The remote OpenCodex is older than ${MIN_REMOTE_OCX.join(".")}.`, 409, boundHint(`opencodex ${version.version}`)));
  }
  const confirmed = { ...pending, ocxVersion: version.version };
  state.confirmedHosts ??= new Map();
  state.confirmedHosts.set(pending.alias, confirmed);
  state.pendingHosts.delete(pending.alias);
  return Response.json({ alias: pending.alias, fingerprint: pending.fingerprint, ocxVersion: confirmed.ocxVersion });
}

/**
 * `ocx --version` prints `opencodex <version>` first; a usage banner, an unbounded version tail or
 * other output is refused.
 */
function parseRemoteOcxVersion(stdout: string): { version: string; parts: [number, number, number] } | null {
  const match = REMOTE_OCX_VERSION.exec(stdout.trim().split(/\r?\n/)[0] ?? "");
  if (!match) return null;
  return { version: `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ""}${match[5] ?? ""}`, parts: [Number(match[1]), Number(match[2]), Number(match[3])] };
}

function meetsRemoteOcxFloor(parts: readonly [number, number, number]): boolean {
  for (let index = 0; index < MIN_REMOTE_OCX.length; index += 1) {
    if (parts[index] !== MIN_REMOTE_OCX[index]) return parts[index]! > MIN_REMOTE_OCX[index]!;
  }
  return true;
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
  let portHint: string | undefined;
  try {
    const result = await runner.run(buildExecArgv({ alias: body.alias, argv: remoteOcxArgv(["link", "port"]), knownHostsFile: knownHosts }), { timeoutMs: 30_000 });
    if (result.code === REMOTE_COMMAND_NOT_FOUND) return fail("remote_ocx_missing", "ocx was not found on the remote host.", 502, sshFailureHint(result.stderr));
    remotePort = result.code === 0 ? parsePortOutput(result.stdout) ?? 0 : 0;
    if (result.code !== 0) portHint = sshFailureHint(result.stderr);
  } catch (error) { remotePort = 0; portHint = sshRunnerErrorHint(error); }
  if (!port(remotePort)) return fail("remote_port_failed", "The remote link port could not be determined.", 502, portHint);
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
    const result = await runner.run(buildExecArgv({ alias: body.alias, argv: remoteOcxArgv(["connect", "--link", "--key-stdin", "--tunnel-port", String(remotePort), "--link-id", id]), knownHostsFile: knownHosts }), { stdin: input, timeoutMs: APPLY_ADMISSION_TIMEOUT_MS });
    if (result.code !== 0) {
      void admission.catch(() => {});
      const compensation = await compensateNewLink(ctx, state, record);
      if (compensation) return compensation;
      const hint = sshFailureHint(result.stderr);
      return result.code === REMOTE_COMMAND_NOT_FOUND
        ? fail("remote_ocx_missing", "ocx was not found on the remote host.", 502, hint)
        : fail("remote_connect_failed", "The remote link connection failed.", 502, hint);
    }
    try {
      await admission;
    } catch {
      const compensation = await compensateNewLink(ctx, state, record);
      return compensation ?? fail("admission_timeout", "The remote link did not authenticate a catalog request in time.", 502);
    }
    return Response.json({ linkId: id }, { status: 202 });
  } catch (error) {
    void admission.catch(() => {});
    const compensation = await compensateNewLink(ctx, state, record);
    return compensation ?? fail("remote_connect_failed", "The remote link connection failed.", 502, sshRunnerErrorHint(error));
  } finally {
    input.fill(0);
  }
}

async function issue(ctx: ManagementContext): Promise<Response> {
  const body = exactBody(await readManagementJsonBodyOr(ctx.req, null), ["alias", "tunnelPort"]);
  if (!body || typeof body.alias !== "string" || !isLinkPort(body.tunnelPort)) return fail("invalid_body", "alias and tunnelPort are required.", 400);
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
    await state.supervisor.ensureStarted();
    const boundStore = readStoreFor(ctx);
    if (!port(boundStore.listenerPort)) throw new Error("link listener did not bind");
    return Response.json({ linkId: id, apiKeyId: issued.id, key: issued.key, listenerPort: boundStore.listenerPort });
  } catch {
    const compensation = await compensateNewLink(ctx, state, record);
    return compensation ?? fail(failureCode, failureCode === "listener_unavailable" ? "The link listener is unavailable." : "The link could not be issued.", 503);
  }
}

type LinkJoinRouteOverrides = {
  joinHome?: typeof joinHome;
};

function joinRouteOverrides(ctx: ManagementContext): LinkJoinRouteOverrides {
  return ctx.deps as ManagementApiDepsWithJoinOverrides;
}

type ManagementApiDepsWithJoinOverrides = ManagementContext["deps"] & LinkJoinRouteOverrides;

function joinFailure(error: unknown): Response {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  const hint = error && typeof error === "object" && "hint" in error && typeof error.hint === "string" ? error.hint : undefined;
  switch (code) {
    case "host_not_confirmed": return fail("host_not_confirmed", "Confirm the SSH host before joining the link.", 409);
    case "host_confirmation_expired": return fail("host_confirmation_expired", "The SSH host confirmation has expired.", 409);
    case "join_port_failed": return fail("join_port_failed", "No local port is available for the link tunnel.", 503);
    case "join_issue_failed": return fail("join_issue_failed", "The home could not issue a link.", 502, hint);
    case "remote_ocx_missing": return fail("remote_ocx_missing", "ocx was not found on the home.", 502, hint);
    case "join_tunnel_failed": return fail("join_tunnel_failed", "The SSH tunnel to the home did not become ready.", 502);
    case "admission_failed": return fail("admission_failed", "The home refused the issued link key.", 502);
    case "join_rollback_failed": {
      const linkId = error && typeof error === "object" && "linkId" in error && typeof error.linkId === "string" ? error.linkId : "unknown";
      return fail("join_rollback_failed", `The join failed and the home link could not be revoked; run ocx link revoke --link-id ${linkId} on the home.`, 502);
    }
    case "join_restart_failed": return fail("join_restart_failed", "The link is ready; restart OpenCodex to finish connecting as a Child.", 500);
    default: return fail("join_connect_failed", "The client link join could not be completed.", 502);
  }
}

async function handleJoin(ctx: ManagementContext, state: LinkRouteState): Promise<Response> {
  const body = exactBody(await readManagementJsonBodyOr(ctx.req, null), ["alias"]);
  if (!body || typeof body.alias !== "string") return fail("invalid_body", "alias is required.", 400);
  try { assertSshAlias(body.alias); } catch { return fail("invalid_alias", "alias must be a valid SSH host alias.", 400); }
  if (joinInProgress) return fail("join_in_progress", "A link join is already in progress.", 409);
  joinInProgress = true;
  try {
    const confirmed = state.confirmedHosts?.get(body.alias);
    const overrides = joinRouteOverrides(ctx);
    const deps: ClientLinkJoinDeps = {
      runner: runnerFor(ctx),
      knownHostsFile: knownHostsFile(ctx),
      scheduleRestart: () => { acceptSystemRestart(); },
      ...(confirmed ? { confirmedHost: confirmed } : {}),
    };
    const result = await (overrides.joinHome ?? joinHome)(deps, { alias: body.alias });
    return Response.json({ linkId: result.linkId, alias: body.alias, restarting: true }, { status: 202 });
  } catch (error) {
    return joinFailure(error);
  } finally {
    joinInProgress = false;
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
      const result = await runnerFor(ctx).run(buildExecArgv({ alias: record.alias, argv: remoteOcxArgv(["disconnect"]), knownHostsFile: knownHostsFile(ctx) }), { timeoutMs: 30_000 });
      if (result.code !== 0) {
        await restartTunnel();
        return fail("remote_disconnect_failed", "The remote client could not be disconnected.", 502, sshFailureHint(result.stderr));
      }
    } catch (error) {
      await restartTunnel();
      return fail("remote_disconnect_failed", "The remote client could not be disconnected.", 502, sshRunnerErrorHint(error));
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
  if (url.pathname === "/api/link/join" && req.method === "POST") {
    // Paired only: a loopback dashboard session may run the Home side, never this restart.
    const denied = auth(ctx, "paired");
    if (denied) return denied;
    if ((ctx.config.runtimeRole ?? "standalone") !== "standalone") return fail("standalone_required", "Client initiated links require standalone runtime mode.", 409);
    const state = suppliedState ?? stateFor(ctx);
    if (!state) return fail("link_unavailable", "The link lifecycle is unavailable.", 503);
    return handleJoin(ctx, state);
  }
  const state = suppliedState ?? stateFor(ctx);
  if (!state) return fail("link_unavailable", "The link lifecycle is unavailable.", 503);
  if (url.pathname === "/api/link/status" && req.method === "GET") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    const store = readStoreFor(ctx);
    const listenerStatus = state.listener.status();
    const dto: LinkStatusDto = projectLinkStatus(
      store, state.supervisor.status(), listenerStatus, ctx.config, readCompensation(),
      ctx.config.runtimeRole === "client" ? clientLinkTunnelStatus() : null,
    );
    for (const link of dto.links) {
      const failure = state.compensationFailures?.get(link.id);
      if (failure) Object.assign(link, { state: "failed" as const, since: failure.since, reason: failure.reason });
    }
    if (dto.child && store.links[0]) {
      const failure = state.compensationFailures?.get(store.links[0].id);
      if (failure) Object.assign(dto.child, { state: "failed" as const, since: failure.since, reason: failure.reason });
    }
    // A dashboard session also learns whether it may join as a Child. The admin-token answer stays
    // the exact K16 document that `ocx link status` validates key by key.
    const body: LinkStatusDto & { joinAvailable?: boolean } = ctx.principal === "gui-session" ? { ...dto, joinAvailable: joinAvailable(ctx) } : dto;
    return Response.json(body, { headers: { "cache-control": "no-store" } });
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

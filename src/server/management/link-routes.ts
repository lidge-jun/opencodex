import { probe, confirmHost, apply } from "./link-enrollment";
import { fail, pairedSession, auth, port, isRecord, exactBody, runnerFor, readStoreFor, writeStoreFor, knownHostsFile, issueKey, revokeKeyIdempotent, compensateNewLink, type LinkRouteState } from "./link-route-state";
export type { LinkRouteState, PendingLinkHost, ConfirmedLinkHost, LinkRouteListener } from "./link-route-state";
import { assertSshAlias, buildExecArgv, remoteOcxArgv } from "../../link/ssh-argv";
import { clearCompensationFailed, compensationPath, readCompensation } from "../../link/compensation";
import { loadHostCandidates } from "../../link/ssh-config";
import { newLinkId, type LinkStore } from "../../link/store";
import { sshFailureHint, sshRunnerErrorHint } from "../../link/ssh-runner";
import { attachLinkPeers, attachLinkTunnelDiagnostics, projectLinkStatus, type LinkStatusDto } from "../../link/status-projection";
import { homeLinkChildParity } from "../../link/child-parity";
import { localLinkPeer } from "../../link/compatibility";
import { packageVersion } from "../../lib/package-version";
import { buildPeerFeatures } from "../../remote/features";
import { isLinkPort } from "../../link/ports";
import { joinHome, type ClientLinkJoinDeps } from "../../client/link-join";
import { clientLinkStatusIdentity } from "../../client/link-status";
import { clientLinkTunnelStatus } from "../../client/link-tunnel";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { type IssuedApiKey } from "./oauth-account-routes";
import { acceptSystemRestart, resolveListenPort } from "./system-restart";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const isLinkPath = (path: string): boolean => path === "/api/link" || path.startsWith("/api/link/");

const states = new WeakMap<object, LinkRouteState>();
// One process runs at most one join: a join ends by restarting this process as a client.
let joinInProgress = false;

/**
 * The client runtime a join restarts into binds exactly the configured port, with no fallback.
 * A standalone that runs elsewhere (`ocx start --port`, or a port fallback) would restart into a
 * proxy that cannot bind where Codex is routed, so it may not join.
 */
function joinPortMatches(ctx: ManagementContext): boolean {
  const live = (ctx.deps.liveListenPort ?? resolveListenPort)();
  return live !== undefined && live === ctx.config.port;
}

type LinkJoinDenied = "pairing_required" | "standalone_required" | "join_port_mismatch";

/** Read-only explanation of the join gates, in the same order as `POST /api/link/join`. */
function joinDenied(ctx: ManagementContext): LinkJoinDenied | null {
  if (!pairedSession(ctx)) return "pairing_required";
  if ((ctx.config.runtimeRole ?? "standalone") !== "standalone") return "standalone_required";
  if (!joinPortMatches(ctx)) return "join_port_mismatch";
  return null;
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

async function candidates(ctx: ManagementContext): Promise<Response> {
  const values = ctx.deps.loadLinkCandidates?.() ?? loadHostCandidates();
  return Response.json({ candidates: values.map(value => ({ alias: value.alias, source: value.source })) });
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
    // Same atomic duplicate-check+append as the hub-initiated branch.
    const writeOutcome = withConfigMutationLockSync((): "dup" | "written" => {
      const current = readStoreFor(ctx);
      if (current.links.some(link => link.id === id)) throw new Error("link id collision");
      if (current.links.some(link => link.alias === body.alias && link.direction === "client-initiated")) return "dup";
      writeStoreFor(ctx, { ...current, links: [...current.links, record] });
      return "written";
    });
    if (writeOutcome === "dup") {
      const compensation = await compensateNewLink(ctx, state, record);
      return compensation ?? fail("link_exists", "A link for this alias already exists.", 409);
    }
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

/**
 * Restart a Home-initiated link's tunnel now: the dashboard's Retry and `ocx link reconnect`.
 * The supervisor stops the current ssh child, if any, forgets its backoff or failed state and
 * spawns a fresh attempt; status then reports it like any other attempt.
 */
async function reconnect(ctx: ManagementContext, state: LinkRouteState, id: string): Promise<Response> {
  if (!LINK_ID.test(id)) return fail("invalid_link_id", "The link id is invalid.", 400);
  const record = readStoreFor(ctx).links.find(link => link.id === id);
  if (!record) return fail("link_not_found", "The link was not found.", 404);
  if (record.direction !== "hub-initiated") {
    return fail("link_not_home_initiated", "Only a Home-initiated link has a tunnel this computer can restart.", 409);
  }
  try {
    // A reverse forward may only target a port the link listener owns, as when a link is applied.
    await state.listener.ensureStarted();
    if (state.listener.status().state !== "listening") return fail("listener_unavailable", "The link listener is unavailable.", 503);
    await state.supervisor.ensureStarted();
    if (!await state.supervisor.reconnect(id)) return fail("link_unavailable", "The link tunnel could not be restarted.", 503);
  } catch {
    return fail("link_unavailable", "The link tunnel could not be restarted.", 503);
  }
  return Response.json({ linkId: id });
}

async function remove(ctx: ManagementContext, state: LinkRouteState, id: string): Promise<Response> {
  if (!LINK_ID.test(id)) return fail("invalid_link_id", "The link id is invalid.", 400);
  const current = readStoreFor(ctx);
  const record = current.links.find(link => link.id === id);
  if (!record) return fail("link_not_found", "The link was not found.", 404);
  const body = await readManagementJsonBodyOr(ctx.req, {});
  if (!isRecord(body) || Object.keys(body).some(key => key !== "force") || (body.force !== undefined && typeof body.force !== "boolean")) return fail("invalid_body", "force must be a boolean.", 400);
  const force = body.force === true;
  const release = state.supervisor.holdLink?.(id);
  try {
    await state.supervisor.stopLink(id);
    const restartTunnel = async (): Promise<void> => {
      release?.();
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
      next = withConfigMutationLockSync(() => {
        const latest = readStoreFor(ctx);
        const filtered = { ...latest, links: latest.links.filter(link => link.id !== id) };
        if (filtered.links.length !== latest.links.length) writeStoreFor(ctx, filtered);
        return filtered;
      });
      clearCompensationFailed(id, compensationPath());
    } catch { return fail("link_remove_failed", "The link record could not be removed.", 503); }
    state.compensationFailures?.delete(id);
    await state.supervisor.reload();
    if (next.links.length === 0) await state.listener.close();
    return Response.json({ linkId: id });
  } finally { release?.(); }
}

export async function handleLinkRoutes(ctx: ManagementContext, suppliedState?: LinkRouteState): Promise<Response | null> {
  const { url, req } = ctx;
  const path = url.pathname;
  if (!isLinkPath(path)) return null;
  if (ctx.guiSessionIssuance === "tailscale-identity") return fail("tailscale_session_refused", "Tailscale identity sessions cannot use link routes.", 403);
  if (url.pathname === "/api/link/join" && req.method === "POST") {
    // Joining durably redirects local client traffic, so a credentiallessly bootstrapped loopback
    // session is insufficient. Every refusal below runs before link state and before any SSH.
    const denied = auth(ctx, "paired");
    if (denied) return denied;
    if ((ctx.config.runtimeRole ?? "standalone") !== "standalone") return fail("standalone_required", "Client initiated links require standalone runtime mode.", 409);
    if (!joinPortMatches(ctx)) return fail("join_port_mismatch", "OpenCodex is not running on its configured port, so it cannot restart as a Child.", 409);
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
    const supervisorStates = state.supervisor.status();
    const dto: LinkStatusDto = projectLinkStatus(
      store, supervisorStates, listenerStatus, ctx.config, readCompensation(),
      ctx.config.runtimeRole === "client" ? clientLinkTunnelStatus() : null,
      ctx.config.runtimeRole === "client" && ctx.config.client?.link ? clientLinkStatusIdentity(ctx.config.client.link.linkId) : null,
      linkId => homeLinkChildParity.get(linkId),
    );
    for (const link of dto.links) {
      const failure = state.compensationFailures?.get(link.id);
      if (failure) Object.assign(link, { state: "failed" as const, since: failure.since, reason: failure.reason });
    }
    if (dto.child && store.links[0]) {
      const failure = state.compensationFailures?.get(store.links[0].id);
      if (failure) Object.assign(dto.child, { state: "failed" as const, since: failure.since, reason: failure.reason });
    }
    // Opt-in: an older `ocx link status` validates the document key by key and would reject the
    // added fields, so only a caller that asks for compatibility gets `local` and `peer`.
    if (url.searchParams.get("compatibility") === "1") {
      attachLinkPeers(dto, localLinkPeer(packageVersion("0.0.0"), buildPeerFeatures()),
        linkId => state.listener.peerObservation?.(linkId) ?? { observed: null, refused: null });
    }
    // The same opt-in for each Home-initiated tunnel's retry progress and last failure cause.
    if (url.searchParams.get("diagnostics") === "1") attachLinkTunnelDiagnostics(dto, supervisorStates);
    // A dashboard session also learns why it cannot join as a Child. The admin-token answer stays
    // the exact K16 document that `ocx link status` validates key by key.
    const denial = ctx.principal === "gui-session" ? joinDenied(ctx) : null;
    const body: LinkStatusDto & { joinAvailable?: boolean; joinDenied?: LinkJoinDenied | null } = ctx.principal === "gui-session"
      ? { ...dto, joinAvailable: denial === null, joinDenied: denial } : dto;
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/api/link/candidates" && req.method === "GET") {
    const denied = auth(ctx, "dashboard");
    if (denied) return denied;
    return candidates(ctx);
  }
  if (url.pathname === "/api/link/probe" && req.method === "POST") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    return probe(ctx, state);
  }
  if (url.pathname === "/api/link/confirm-host" && req.method === "POST") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    return confirmHost(ctx, state);
  }
  if (url.pathname === "/api/link/apply" && req.method === "POST") {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    return apply(ctx, state);
  }
  if (url.pathname === "/api/link/issue" && req.method === "POST") {
    const denied = auth(ctx, "admin");
    if (denied) return denied;
    return issue(ctx);
  }
  const reconnectPath = req.method === "POST" ? /^\/api\/link\/([^/]+)\/reconnect$/.exec(path) : null;
  if (reconnectPath) {
    const denied = auth(ctx, "either");
    if (denied) return denied;
    let id: string;
    try { id = decodeURIComponent(reconnectPath[1]!); } catch { return fail("invalid_link_id", "The link id is invalid.", 400); }
    return reconnect(ctx, state, id);
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

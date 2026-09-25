import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { findAvailablePort } from "../server/ports";
import { isLinkPort } from "../link/ports";
import { buildExecArgv } from "../link/ssh-argv";
import type { SshRunner } from "../link/ssh-runner";
import { connectClient, type ClientConnectDeps } from "./connect";
import {
  clearClientLinkState,
  clientLinkStatePath,
  readClientLinkState,
  writeClientLinkState,
  type ClientLinkState,
} from "./link-state";
import { isLinkConnection, readClientConnectionState, type ClientConnectionState } from "./state";
import {
  spawnClientLinkTunnel,
  type ClientLinkTunnelDeps,
  type ClientLinkTunnelHandle,
} from "./link-tunnel";
import type { OcxConnectedClientId } from "../types";

const JOIN_TUNNEL_READY_TIMEOUT_MS = 15_000;
const JOIN_TUNNEL_POLL_MS = 100;
const JOIN_REVOKE_TIMEOUT_MS = 30_000;
const JOIN_CONFIRM_TTL_MS = 5 * 60_000;
const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const API_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const DATA_KEY = /^ocx_data_[0-9a-f]{40}$/;
const VALID_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._@%+:\[\]-]{0,252}$/;

export interface JoinConfirmedHost {
  alias: string;
  fingerprint: string;
  probedAt: number;
}

export type JoinFailureCode =
  | "host_not_confirmed"
  | "host_confirmation_expired"
  | "join_port_failed"
  | "join_issue_failed"
  | "join_tunnel_failed"
  | "admission_failed"
  | "join_connect_failed"
  | "join_rollback_failed"
  | "join_restart_failed";

export class ClientLinkJoinError extends Error {
  constructor(readonly code: JoinFailureCode, readonly linkId?: string) {
    super(linkId ? `${code}: ${linkId}` : code);
    this.name = "ClientLinkJoinError";
  }
}

interface IssuedLink {
  linkId: string;
  apiKeyId: string;
  key: string;
  listenerPort: number;
}

export interface ClientLinkJoinDeps {
  runner: SshRunner;
  knownHostsFile: string;
  confirmedHost?: JoinConfirmedHost;
  configDir?: string;
  choosePort?: () => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  hostname?: () => string;
  randomBytes?: (size: number) => Uint8Array;
  fetchImpl?: typeof fetch;
  spawnTunnel?: (spec: {
    linkId: string;
    alias: string;
    tunnelPort: number;
    peerListenerPort: number;
  }, deps?: ClientLinkTunnelDeps) => ClientLinkTunnelHandle;
  writeState?: (state: ClientLinkState) => void;
  clearState?: (linkId: string) => void;
  readSidecar?: () => ClientLinkState | null;
  readConnectionState?: () => ClientConnectionState;
  connect?: typeof connectClient;
  connectDeps?: ClientConnectDeps;
  selectedClients?: OcxConnectedClientId[];
  /** Hands the standalone process to the client runtime once the join has committed. */
  scheduleRestart: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function parseIssuedLink(stdout: string): IssuedLink | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 4
    || typeof parsed.linkId !== "string" || !LINK_ID.test(parsed.linkId)
    || typeof parsed.apiKeyId !== "string" || !API_KEY_ID.test(parsed.apiKeyId)
    || typeof parsed.key !== "string" || !DATA_KEY.test(parsed.key)
    || !validPort(parsed.listenerPort)) {
    return null;
  }
  return {
    linkId: parsed.linkId,
    apiKeyId: parsed.apiKeyId,
    key: parsed.key,
    listenerPort: parsed.listenerPort,
  };
}

function localAlias(deps: ClientLinkJoinDeps): string {
  const raw = (deps.hostname ?? hostname)().trim();
  const normalized = raw.replace(/[^A-Za-z0-9_\.\-]/g, "-").replace(/^-+/, "").slice(0, 253);
  if (VALID_ALIAS.test(normalized)) return normalized;
  const bytes = (deps.randomBytes ?? randomBytes)(4);
  return `client-${Buffer.from(bytes).toString("hex")}`;
}

function defaultWriteState(configDir: string | undefined, state: ClientLinkState): void {
  writeClientLinkState(state, clientLinkStatePath(configDir));
}

function defaultClearState(configDir: string | undefined, linkId: string): void {
  clearClientLinkState(linkId, clientLinkStatePath(configDir));
}

async function stopTunnel(tunnel: ClientLinkTunnelHandle | null): Promise<void> {
  if (!tunnel) return;
  try {
    await tunnel.stop();
  } catch (error) {
    void error;
  }
}

async function revokeIssuedLink(deps: ClientLinkJoinDeps, linkId: string, alias = deps.confirmedHost?.alias ?? ""): Promise<boolean> {
  try {
    const result = await deps.runner.run(
      buildExecArgv({
        alias,
        argv: ["ocx", "link", "revoke", "--link-id", linkId],
        knownHostsFile: deps.knownHostsFile,
      }),
      { timeoutMs: JOIN_REVOKE_TIMEOUT_MS },
    );
    return result.code === 0;
  } catch (error) {
    void error;
    return false;
  }
}

async function rollback(
  deps: ClientLinkJoinDeps,
  linkId: string,
  tunnel: ClientLinkTunnelHandle | null,
): Promise<void> {
  await stopTunnel(tunnel);
  if (!await revokeIssuedLink(deps, linkId)) throw new ClientLinkJoinError("join_rollback_failed", linkId);
  try {
    (deps.clearState ?? (id => defaultClearState(deps.configDir, id)))(linkId);
  } catch (error) {
    void error;
  }
}

async function compensateStaleSidecar(deps: ClientLinkJoinDeps): Promise<void> {
  let sidecar: ClientLinkState | null;
  try {
    sidecar = (deps.readSidecar ?? (() => readClientLinkState(clientLinkStatePath(deps.configDir))))();
  } catch {
    // A corrupt sidecar is overwritten by the next successful join.
    return;
  }
  if (!sidecar) return;
  let connection: ClientConnectionState;
  try {
    connection = (deps.readConnectionState ?? readClientConnectionState)();
  } catch {
    connection = { kind: "invalid", reason: "client connection state could not be read" };
  }
  if (connection.kind === "connected" && isLinkConnection(connection.value)
    && connection.value.link?.linkId === sidecar.linkId) return;
  if (!await revokeIssuedLink(deps, sidecar.linkId, sidecar.alias)) {
    throw new ClientLinkJoinError("join_rollback_failed", sidecar.linkId);
  }
  try {
    (deps.clearState ?? (linkId => defaultClearState(deps.configDir, linkId)))(sidecar.linkId);
  } catch {
    throw new ClientLinkJoinError("join_rollback_failed", sidecar.linkId);
  }
}

async function waitForReady(
  deps: ClientLinkJoinDeps,
  port: number,
  key: string,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + JOIN_TUNNEL_READY_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/readyz`, {
        headers: { "x-opencodex-api-key": key },
      });
      if (response.status === 200) return;
      if (response.status === 401) throw new ClientLinkJoinError("admission_failed");
    } catch (error) {
      if (error instanceof ClientLinkJoinError) throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new ClientLinkJoinError("join_tunnel_failed");
    await sleep(Math.min(JOIN_TUNNEL_POLL_MS, remaining));
  }
}

function requireConfirmedHost(deps: ClientLinkJoinDeps, alias: string): JoinConfirmedHost {
  const confirmed = deps.confirmedHost;
  if (!confirmed || confirmed.alias !== alias) throw new ClientLinkJoinError("host_not_confirmed");
  if ((deps.now ?? Date.now)() - confirmed.probedAt > JOIN_CONFIRM_TTL_MS) {
    throw new ClientLinkJoinError("host_confirmation_expired");
  }
  return confirmed;
}

export async function joinHome(deps: ClientLinkJoinDeps, input: { alias: string }): Promise<{ linkId: string; apiKeyId: string }> {
  const confirmed = requireConfirmedHost(deps, input.alias);
  await compensateStaleSidecar(deps);
  let tunnelPort: number;
  try {
    tunnelPort = await (deps.choosePort ?? (() => findAvailablePort(0, "127.0.0.1")))();
    if (!isLinkPort(tunnelPort)) throw new Error("invalid link port");
  } catch (error) {
    void error;
    throw new ClientLinkJoinError("join_port_failed");
  }

  const thisAlias = localAlias(deps);
  let issued: IssuedLink;
  try {
    const result = await deps.runner.run(
      buildExecArgv({
        alias: input.alias,
        argv: ["ocx", "link", "issue", "--alias", thisAlias, "--tunnel-port", String(tunnelPort), "--json"],
        knownHostsFile: deps.knownHostsFile,
      }),
      { timeoutMs: JOIN_REVOKE_TIMEOUT_MS },
    );
    if (result.code !== 0) throw new Error("issue failed");
    const parsed = parseIssuedLink(result.stdout);
    if (!parsed) throw new Error("invalid issue response");
    issued = parsed;
  } catch (error) {
    void error;
    throw new ClientLinkJoinError("join_issue_failed");
  }

  let tunnel: ClientLinkTunnelHandle | null = null;
  try {
    const state: ClientLinkState = {
      linkId: issued.linkId,
      alias: input.alias,
      hubHostKeyFingerprint: confirmed.fingerprint,
      peerListenerPort: issued.listenerPort,
      tunnelPort,
    };
    (deps.writeState ?? (value => defaultWriteState(deps.configDir, value)))(state);
    tunnel = (deps.spawnTunnel ?? spawnClientLinkTunnel)({
      linkId: issued.linkId,
      alias: input.alias,
      tunnelPort,
      peerListenerPort: issued.listenerPort,
    }, {
      runner: deps.runner,
      configDir: deps.configDir,
      knownHostsFile: deps.knownHostsFile,
    });
    await waitForReady(deps, tunnelPort, issued.key);
  } catch (error) {
    const code = error instanceof ClientLinkJoinError ? error.code : "join_tunnel_failed";
    await rollback(deps, issued.linkId, tunnel);
    throw new ClientLinkJoinError(code);
  }

  try {
    const connect = deps.connect ?? connectClient;
    await connect({
      serverUrl: `http://127.0.0.1:${tunnelPort}`,
      managementUrl: `http://127.0.0.1:${tunnelPort}`,
      credential: { kind: "link", apiKeyId: issued.apiKeyId, key: issued.key },
      transport: "link",
      link: { tunnelPort, linkId: issued.linkId },
      selectedClients: deps.selectedClients ?? ["codex", "claude"],
      managementTransport: "direct",
    }, {
      fetchImpl: deps.fetchImpl,
      ...deps.connectDeps,
    });
  } catch {
    await rollback(deps, issued.linkId, tunnel);
    throw new ClientLinkJoinError("join_connect_failed");
  }

  await stopTunnel(tunnel);
  try {
    deps.scheduleRestart();
  } catch {
    throw new ClientLinkJoinError("join_restart_failed", issued.linkId);
  }
  return { linkId: issued.linkId, apiKeyId: issued.apiKeyId };
}

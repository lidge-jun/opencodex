import { join } from "node:path";
import { linkDir } from "../link/paths";
import type { SshRunner } from "../link/ssh-runner";
import type { TunnelState } from "../link/tunnel-state";
import type { ClientLinkState } from "./link-state";

/**
 * The client-owned `ssh -N -L 127.0.0.1:<tunnelPort>:127.0.0.1:<peerListenerPort> <alias>`
 * of a client-initiated link. Two owners use it: the dashboard join (a short-lived tunnel that
 * lives only until the in-process connect finishes) and the client runtime supervisor.
 */
export interface ClientLinkTunnelSpec {
  linkId: string;
  alias: string;
  tunnelPort: number;
  peerListenerPort: number;
}

export interface ClientLinkTunnelHandle {
  readonly pid: number;
  readonly exited: Promise<number>;
  /** TERM, wait up to 5 s, then KILL; removes the pidfile this handle wrote. Idempotent. */
  stop(): Promise<void>;
}

export interface ClientLinkTunnelDeps {
  runner?: SshRunner;
  configDir?: string;
  knownHostsFile?: string;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export type OrphanTunnelResult =
  | { tunnel: "reaped" }
  | { tunnel: "absent" }
  | { tunnel: "owned" }
  | { tunnel: "unresolved"; pid: number };

export interface OrphanReapDeps {
  configDir?: string;
  platform?: NodeJS.Platform;
  readProcessArgv?: (pid: number) => readonly string[] | null;
  isAlive?: (pid: number) => boolean;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type ClientLinkSupervisorStatus =
  | { kind: "stopped" }
  | { kind: "tunnel"; linkId: string; state: TunnelState; pid: number | null }
  | { kind: "failed"; reason: "sidecar_invalid" };

export interface ClientLinkSupervisor {
  start(): void;
  /** Stops the tunnel (TERM, up to 5 s, KILL). The runtime calls this before stopping its listener. */
  stop(): Promise<void>;
  status(): ClientLinkSupervisorStatus;
}

export interface ClientLinkSupervisorDeps extends ClientLinkTunnelDeps, OrphanReapDeps {
  readSidecar?: () => ClientLinkState | null;
  /** Current link id of a connected link-transport client, or null when that no longer holds. */
  connectedLinkId?: () => string | null;
  /** Called once after the tunnel stopped because the link ended (the runtime recycles here). */
  onLinkEnded?: () => void;
  now?: () => number;
  random?: () => number;
  warn?: (message: string) => void;
}

export function clientTunnelPidfilePath(configDir?: string): string {
  return join(linkDir(configDir), "client-tunnel.pid");
}

/**
 * Pidfile body at `clientTunnelPidfilePath()`: `{ version: 1, linkId, pid, argv, ownerPid }`.
 * `ownerPid` is the process that spawned the tunnel. A tunnel is an orphan only while its owner
 * is gone; a live owner means the tunnel is managed and `reapOrphanTunnel` reports "owned".
 */
export interface ClientTunnelPidfile {
  version: 1;
  linkId: string;
  pid: number;
  argv: string[];
  ownerPid: number;
}

export function spawnClientLinkTunnel(_spec: ClientLinkTunnelSpec, _deps: ClientLinkTunnelDeps = {}): ClientLinkTunnelHandle {
  throw new Error("spawnClientLinkTunnel: implemented by the client runtime lane");
}

export async function reapOrphanTunnel(_deps: OrphanReapDeps = {}): Promise<OrphanTunnelResult> {
  throw new Error("reapOrphanTunnel: implemented by the client runtime lane");
}

export function createClientLinkSupervisor(_deps: ClientLinkSupervisorDeps = {}): ClientLinkSupervisor {
  throw new Error("createClientLinkSupervisor: implemented by the client runtime lane");
}

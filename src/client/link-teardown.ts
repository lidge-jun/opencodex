import { buildExecArgv, remoteOcxArgv } from "../link/ssh-argv";
import type { SshRunner } from "../link/ssh-runner";
import type { ClientLinkState } from "./link-state";
import type { OrphanTunnelResult } from "./link-tunnel";

const HOME_REVOKE_TIMEOUT_MS = 30_000;

export interface ClientLinkTeardownDeps {
  readSidecar: () => ClientLinkState | null;
  connectedLinkId: () => string | null;
  reapOrphanTunnel: () => Promise<OrphanTunnelResult>;
  runner: Pick<SshRunner, "run">;
  knownHostsFile: string;
  timeoutMs?: number;
}

export interface ClientLinkTeardownResult {
  linkId: string | null;
  homeRevoke: "revoked" | "failed" | "not_applicable";
  tunnel: OrphanTunnelResult | null;
}

/** Reap the client tunnel and make one best-effort Home-side revoke attempt. */
export async function teardownClientLink(
  deps: ClientLinkTeardownDeps,
): Promise<ClientLinkTeardownResult> {
  let tunnel: OrphanTunnelResult | null = null;
  try {
    tunnel = await deps.reapOrphanTunnel();
  } catch {
    // A reap failure must not prevent the one allowed Home revoke attempt.
  }
  let sidecar: ClientLinkState | null;
  try {
    sidecar = deps.readSidecar();
  } catch {
    // An unreadable sidecar no longer names the Home alias, so the revoke cannot run here. The
    // disconnect still proceeds, and a link connection gets the manual revoke instruction.
    const linkId = deps.connectedLinkId();
    return { linkId, homeRevoke: linkId ? "failed" : "not_applicable", tunnel };
  }
  if (!sidecar || sidecar.linkId !== deps.connectedLinkId()) {
    return { linkId: null, homeRevoke: "not_applicable", tunnel };
  }

  try {
    const result = await deps.runner.run(
      buildExecArgv({
        alias: sidecar.alias,
        argv: remoteOcxArgv(["link", "revoke", "--link-id", sidecar.linkId]),
        knownHostsFile: deps.knownHostsFile,
      }),
      { timeoutMs: deps.timeoutMs ?? HOME_REVOKE_TIMEOUT_MS },
    );
    return {
      linkId: sidecar.linkId,
      homeRevoke: result.code === 0 ? "revoked" : "failed",
      tunnel,
    };
  } catch {
    return { linkId: sidecar.linkId, homeRevoke: "failed", tunnel };
  }
}

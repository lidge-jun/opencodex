import { lstatSync } from "node:fs";
import { markSiblingStart } from "../codex/sibling-start";
import { isMissingPathError } from "../config/atomic-write";
import { getPidPath, getRuntimePortPath } from "../config/process-state";
import type { ServiceChildOwnershipDecision } from "../service/service-child-ownership";
import { serviceStayOutExitCode } from "../service/windows-wrapper-exit";
import { observeProxyLiveness, START_OWNERSHIP_LIVENESS } from "../server/proxy-liveness";
import { findCrossHomeOwner, markCrossHomeSibling } from "./cross-home-owner";

function ownershipRecordIsAbsent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { return isMissingPathError(error); }
}

/** Called under the publication lease, before the client can bind or write ownership records. */
export async function recheckClientStartOwnership(sibling: boolean, requestedPort?: number): Promise<number | null> {
  const fenced = await observeProxyLiveness(START_OWNERSHIP_LIVENESS);
  if (fenced.kind === "live") {
    const { pid, port } = fenced.live;
    if (process.env.OCX_SERVICE === "1") {
      console.log(`Proxy already running (PID ${pid ?? "unknown"}, port ${port}); service wrapper staying out of the way.`);
      return serviceStayOutExitCode();
    }
    // A config-port hit can be foreign even when this home has no owner. Only the
    // explicit sibling path may disregard it, and only with fresh cross-home proof.
    if (sibling && requestedPort !== undefined && requestedPort !== port && fenced.live.source === "config"
      && await findCrossHomeOwner({ listener: fenced.live }) === port
      && ownershipRecordIsAbsent(getPidPath()) && ownershipRecordIsAbsent(getRuntimePortPath())) {
      markSiblingStart(port);
      return null;
    }
    console.error(`⚠️  Proxy appeared before bind (PID ${pid ?? "unknown"}, port ${port}). Use 'ocx stop' first.`);
    return 1;
  }
  if (fenced.kind === "unknown") throw new Error("Proxy ownership is unverified; client startup refused before bind.");
  if (!sibling) await markCrossHomeSibling();
  return null;
}

/**
 * Connected-client starts publish PID and runtime records too, so a supervised service child
 * must not reach them past a foreign owner any more than the server path may. The server path
 * rechecks inside `bindAndPublishStartOwnership`; this is the same fence for
 * `startClientRuntime`, which binds, publishes and then blocks for the process lifetime.
 *
 * The lease is held from acquisition until the runtime reports its records published (or the
 * start fails), and the ownership decision is re-read under it before anything binds. A refusal
 * releases the lease and hands the refusal to `stayOut`, which exits.
 */
export async function startClientRuntimeUnderOwnershipLease(deps: {
  acquireLease: () => { release(): void };
  decide: () => ServiceChildOwnershipDecision;
  stayOut: (refusal: string) => never;
  start: (afterPublish: () => void) => Promise<void>;
}): Promise<void> {
  const lease = deps.acquireLease();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };
  try {
    const decision = deps.decide();
    if (decision.kind === "stay-out") {
      release();
      deps.stayOut(decision.refusal);
    }
    await deps.start(release);
  } finally {
    release();
  }
}

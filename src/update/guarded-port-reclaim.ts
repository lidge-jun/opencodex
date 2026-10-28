import { reclaimListenPort, type ReclaimListenPortOptions } from "../server/port-reclaim";

export type UpdateReclaimOptions = ReclaimListenPortOptions & { mayMutateFn: () => boolean };

/** Update callers must supply authority; the shared helper keeps its ordinary defaults. */
export async function guardedReclaimListenPort(port: number, hostname: string | undefined,
  options: UpdateReclaimOptions): Promise<boolean> {
  // Finish option accessors before capturing the gate. Inherited/omitted gates
  // are absent from this copy and cannot select the shared helper's permissive default.
  const prepared = { ...options };
  if (typeof prepared.mayMutateFn !== "function") return false;
  try { if (prepared.mayMutateFn() !== true) return false; } catch { return false; }
  return reclaimListenPort(port, hostname, prepared);
}

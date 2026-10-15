import { randomUUID } from "node:crypto";

interface LaunchContext { pacUrl: string; generation: string; current(): boolean }
/** Process-local ownership; the management sibling guard owns the cross-instance boundary. */
let owner: { token: symbol; kind: "runtime" | "certificate"; launch?: LaunchContext } | null = null;
export function desktopCompatibilityRuntimeActive(): boolean { return owner?.kind === "runtime"; }
function acquire(kind: "runtime" | "certificate"): () => void {
  if (owner !== null) throw new Error("desktop_compatibility_busy");
  const token = Symbol(); owner = { token, kind };
  return () => { if (owner?.token === token) owner = null; };
}
export const acquireDesktopCompatibilityRuntime = () => acquire("runtime");
export const acquireDesktopCertificateMutation = () => acquire("certificate");

/** Published only by a successfully started runtime, never reconstructed from disk or app arguments. */
export function bindDesktopCompatibilityLaunch(pacUrl: string, current: () => boolean): () => void {
  if (owner?.kind !== "runtime" || owner.launch) throw new Error("desktop_compatibility_launch_owner_unverified");
  const lease = owner, launch = { pacUrl, generation: randomUUID(), current };
  lease.launch = launch;
  return () => { if (lease.launch === launch) delete lease.launch; };
}

/** No key loading, socket discovery, or optional-runtime construction on the ordinary restart path. */
export function readDesktopCompatibilityLaunch(): { pacUrl: string; generation: string } | null {
  const launch = owner?.kind === "runtime" ? owner.launch : undefined;
  try { return launch?.current() ? { pacUrl: launch.pacUrl, generation: launch.generation } : null; }
  catch { return null; }
}

import { randomUUID } from "node:crypto";
import type { VerifiedDesktopPackage } from "./installed-build";

interface BuildBinding { build: VerifiedDesktopPackage | null; revision: number }
interface LaunchContext { pacUrl: string; generation: string; current(): BuildBinding | null; fence(): void }
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
export function bindDesktopCompatibilityLaunch(pacUrl: string, current: () => BuildBinding | null, fence: () => void): () => void {
  if (owner?.kind !== "runtime" || owner.launch) throw new Error("desktop_compatibility_launch_owner_unverified");
  const lease = owner, launch = { pacUrl, generation: randomUUID(), current, fence };
  lease.launch = launch;
  return () => { if (lease.launch === launch) delete lease.launch; };
}

/** No key loading, socket discovery, or optional-runtime construction on the ordinary restart path. */
export function readDesktopCompatibilityLaunch() {
  const launch = owner?.kind === "runtime" ? owner.launch : undefined;
  if (!launch) return null;
  try {
    const binding = launch.current();
    return binding?.build ? { pacUrl: launch.pacUrl, generation: launch.generation, build: binding.build, revision: binding.revision, fence: launch.fence } : null;
  }
  catch { return null; }
}

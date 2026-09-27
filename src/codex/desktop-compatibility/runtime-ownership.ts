/** Process-local ownership; the management sibling guard owns the cross-instance boundary. */
let owner: { token: symbol; kind: "runtime" | "certificate" } | null = null;
export function desktopCompatibilityRuntimeActive(): boolean { return owner?.kind === "runtime"; }
function acquire(kind: "runtime" | "certificate"): () => void {
  if (owner !== null) throw new Error("desktop_compatibility_busy");
  const token = Symbol(); owner = { token, kind };
  return () => { if (owner?.token === token) owner = null; };
}
export const acquireDesktopCompatibilityRuntime = () => acquire("runtime");
export const acquireDesktopCertificateMutation = () => acquire("certificate");

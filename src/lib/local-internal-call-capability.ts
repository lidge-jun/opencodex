/**
 * Process-local internal-call capability.
 *
 * Some requests ARE the proxy itself talking to its own data plane: the advisor sidecar's
 * loopback consultation is the first user. Such a request must be recognized as INTERNAL without
 * trusting anything the client controls. A client-supplied header value is not evidence — any
 * external caller can send it — and neither is the peer address: a public listener reached
 * through Docker, WSL, a tunnel, or port forwarding can present as loopback on the last hop, as
 * the local-management attestation notes.
 *
 * The authority is therefore process-owned: a 256-bit random value minted once per process, kept
 * in memory only. It is never written to config or disk, never logged, never returned by the
 * management API, never placed in usage or request metadata, and never forwarded upstream. A new
 * process mints a new value, so a token captured from an older process is worthless. Comparison
 * is timing-safe and shape-checked, reusing the same secret shape as the local attestation
 * module.
 *
 * The same primitive is what the vision-describe fence would need for the same reason; wiring
 * that surface is deliberately left out of this change (recorded as a pre-existing analogous
 * issue) so the change stays scoped.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isLocalAttestationSecret } from "./local-management-attestation";

/** Header an internal sidecar presents on its own loopback request. */
export const ADVISOR_INTERNAL_CAPABILITY_HEADER = "x-opencodex-advisor-internal";

let processCapability: string | null = null;

/**
 * The current process's internal-call capability. Minted lazily on first use (one random draw,
 * no I/O), so an install that never enables the advisor never generates one.
 */
export function internalCallCapability(): string {
  if (processCapability === null) processCapability = randomBytes(32).toString("base64url");
  return processCapability;
}

/** Test seam: install a deterministic value, or `null` to force a fresh mint. */
export function setInternalCallCapabilityForTests(value: string | null): void {
  processCapability = value;
}

/**
 * True only when the supplied header value IS this process's capability. Shape-checked first so
 * a malformed value cannot reach the comparison, then compared in constant time.
 */
export function isInternalCallCapability(supplied: string | null | undefined): boolean {
  if (typeof supplied !== "string" || !isLocalAttestationSecret(supplied)) return false;
  if (processCapability === null) return false;
  const expected = processCapability;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

import { createHash } from "node:crypto";
import { jcsStringify } from "../digest";
import type { ProtocolSubjectV1 } from "../events/types";
import type { ProtocolExecutionContextV1 } from "../conformance/types";

/** Frozen CL-01 protocol compatibility identity. */
export const PROTOCOL_COMPATIBILITY_VERSION = "protocol-v1";

/** Adapter identity used by the deterministic protocol harness for a wire protocol. */
export function protocolAdapterForUpstreamProtocol(protocol: string): string {
  switch (protocol) {
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic";
    case "openai-chat":
      return "openai-chat";
    default:
      throw new Error(`unsupported protocol identity: ${protocol}`);
  }
}

/**
 * Exact CL-01 behavior fingerprint for one protocol execution context.
 *
 * `effectiveAdapter` is optional so the harness keeps its historical mapping,
 * while routing consumers may require an exact production adapter match. A
 * provider-specific adapter that merely speaks an OpenAI-shaped wire therefore
 * cannot borrow generic protocol evidence unless CL-01 actually produced the
 * same adapter identity.
 */
export function protocolBehaviorFingerprintV1(
  ctx: ProtocolExecutionContextV1,
  effectiveAdapter = protocolAdapterForUpstreamProtocol(ctx.upstreamProtocol),
): string {
  const values = {
    schemaVersion: 1,
    resolverVersion: 1,
    values: {
      "wire.adapter": {
        source: "lab_forced",
        value: effectiveAdapter,
      },
      "wire.upstreamProtocol": {
        source: "lab_forced",
        value: ctx.upstreamProtocol,
      },
      "runtime.arch": {
        source: "lab_forced",
        value: process.arch,
      },
      "runtime.bunVersion": {
        source: "lab_forced",
        value: process.versions.bun ?? Bun.version,
      },
      "runtime.platform": {
        source: "lab_forced",
        value: process.platform,
      },
    },
  };
  return createHash("sha256").update(jcsStringify(values)).digest("hex");
}

/** Build the exact ProtocolSubjectV1 consumed by CL-01 projection. */
export function buildProtocolSubjectV1(
  ctx: ProtocolExecutionContextV1,
  effectiveAdapter = protocolAdapterForUpstreamProtocol(ctx.upstreamProtocol),
): ProtocolSubjectV1 {
  return Object.freeze({
    subjectSchemaVersion: 1,
    subjectKind: "protocol",
    opencodexCompatibilityVersion: PROTOCOL_COMPATIBILITY_VERSION,
    effectiveAdapter,
    inboundProtocol: ctx.inboundProtocol,
    upstreamProtocol: ctx.upstreamProtocol,
    surface: ctx.surface,
    behaviorFingerprint: protocolBehaviorFingerprintV1(ctx, effectiveAdapter),
  });
}

import type { OcxConfig, OcxProviderConfig } from "../../types";
import type { InboundWire } from "../../providers/registry";
import { subjectIdForSubject } from "../../lab/digest";
import { buildRouteSubjectV1 } from "../../lab/subject/route-subject";
import { buildProtocolSubjectV1 } from "../../lab/subject/protocol-subject";
import { readExistingInstallationSalt } from "../../lab/subject/installation-salt";
import type { LabDestinationV1, LabRouteContext } from "../../lab/live/types";
import { resolveWireProtocolOverride } from "../../server/adapter-resolve";
import { endpointFingerprintFromBaseUrl, parseEndpointFingerprintParts } from "./endpoint";
import {
  providerInstanceKey,
  resolveProductionBehaviorValues,
  surfaceForProtocols,
  upstreamProtocolForAdapter,
} from "./behavior";
import { readOpenCodexCompatibilityVersion } from "./version";
import type { RoutingCompatibilityEvidenceLayer } from "./types";

const POLICY_INBOUND_WIRE: InboundWire = "responses";

export interface ResolvedPolicyRouteSubject {
  subjectId: string;
  routeContext: LabRouteContext;
  destination: LabDestinationV1;
}

export interface ResolvedPolicyCompatibilitySubjects {
  subjectIds: Partial<Record<RoutingCompatibilityEvidenceLayer, string>>;
  route?: ResolvedPolicyRouteSubject;
}

/** Canonical Lab protocol identity for a production request wire. */
export function inboundProtocolForWire(inboundWire: InboundWire): string {
  switch (inboundWire) {
    case "responses": return "openai-responses";
    case "chat": return "openai-chat";
    case "anthropic": return "anthropic-messages";
  }
}

function destinationSnapshotFromBaseUrl(baseUrl: string, fingerprint: string): LabDestinationV1 {
  const parts = parseEndpointFingerprintParts(baseUrl);
  if (!parts) throw new Error("invalid provider baseUrl for route subject");
  return Object.freeze({
    scheme: parts.scheme,
    host: parts.host,
    port: parts.port,
    basePath: parts.basePath,
    sniHost: parts.host,
    addresses: Object.freeze([]),
    privateNetwork: false,
    fingerprint,
  });
}

/**
 * Resolve subject identities for one exact inbound wire without network I/O,
 * projection reads/rebuilds, ledger replay, or Lab-state creation.
 */
export function resolveCompatibilitySubjectsForInboundWire(
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  inboundWire: InboundWire,
  configDir?: string,
): ResolvedPolicyCompatibilitySubjects {
  const effective = resolveWireProtocolOverride(providerName, modelId, routed, inboundWire);
  const baseUrl = typeof effective.baseUrl === "string" ? effective.baseUrl.trim() : "";
  const adapter = effective.adapter ?? "openai-responses";
  const inboundProtocol = inboundProtocolForWire(inboundWire);
  const upstreamProtocol = upstreamProtocolForAdapter(adapter);
  const surface = surfaceForProtocols(inboundProtocol, upstreamProtocol);
  const subjectIds: ResolvedPolicyCompatibilitySubjects["subjectIds"] = {};

  try {
    const protocolSubject = buildProtocolSubjectV1({
      inboundProtocol,
      upstreamProtocol,
      surface,
    }, adapter);
    subjectIds.protocol_conformance = subjectIdForSubject(protocolSubject);
  } catch {
    // No CL-01 protocol subject exists for this exact adapter/wire identity.
  }

  if (!baseUrl) return { subjectIds };

  let installationSalt: Uint8Array | null;
  try {
    installationSalt = readExistingInstallationSalt(configDir);
  } catch {
    installationSalt = null;
  }
  const compatibilityVersion = readOpenCodexCompatibilityVersion();
  if (!installationSalt || !compatibilityVersion) return { subjectIds };

  const endpointFp = endpointFingerprintFromBaseUrl(baseUrl, installationSalt);
  if (!endpointFp) return { subjectIds };
  const destination = destinationSnapshotFromBaseUrl(baseUrl, endpointFp);
  const behaviorValues = resolveProductionBehaviorValues(
    config,
    providerName,
    modelId,
    effective,
    installationSalt,
  );
  if (!behaviorValues) return { subjectIds };

  const routeContext: LabRouteContext = {
    providerId: providerName,
    providerInstanceKey: providerInstanceKey(providerName, effective),
    clientModelId: modelId,
    upstreamModelId: modelId,
    effectiveAdapter: adapter,
    inboundProtocol,
    upstreamProtocol,
    surface,
    baseUrl,
    opencodexCompatibilityVersion: compatibilityVersion,
    behaviorValues,
    dependencies: [],
  };

  try {
    const subject = buildRouteSubjectV1(routeContext, destination, configDir, installationSalt);
    const route: ResolvedPolicyRouteSubject = {
      subjectId: subjectIdForSubject(subject),
      routeContext,
      destination,
    };
    subjectIds.live_route_compatibility = route.subjectId;
    return { subjectIds, route };
  } catch {
    return { subjectIds };
  }
}

/**
 * Resolve the subject identities a policy candidate may legitimately consume.
 * CL-06 policy evaluation is a Responses-surface lookup and remains unchanged.
 */
export function resolvePolicyCompatibilitySubjects(
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  configDir?: string,
): ResolvedPolicyCompatibilitySubjects {
  return resolveCompatibilitySubjectsForInboundWire(
    config,
    providerName,
    modelId,
    routed,
    POLICY_INBOUND_WIRE,
    configDir,
  );
}

/** Build exact RouteSubjectV1 identity for a policy candidate without network I/O. */
export function resolvePolicyRouteSubject(
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  configDir?: string,
): ResolvedPolicyRouteSubject | null {
  return resolvePolicyCompatibilitySubjects(config, providerName, modelId, routed, configDir).route ?? null;
}

/**
 * Build the exact production-attempt RouteSubjectV1 identity for its actual
 * inbound wire. Returns null when no existing Lab salt/identity can be read.
 */
export function resolveProductionRouteSubject(
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  inboundWire: InboundWire,
  configDir?: string,
): ResolvedPolicyRouteSubject | null {
  return resolveCompatibilitySubjectsForInboundWire(
    config,
    providerName,
    modelId,
    routed,
    inboundWire,
    configDir,
  ).route ?? null;
}

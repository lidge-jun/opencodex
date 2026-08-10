import type { OcxConfig, OcxProviderConfig } from "../../types";
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

const POLICY_INBOUND_PROTOCOL = "openai-responses";

export interface ResolvedPolicyRouteSubject {
  subjectId: string;
  routeContext: LabRouteContext;
  destination: LabDestinationV1;
}

export interface ResolvedPolicyCompatibilitySubjects {
  subjectIds: Partial<Record<RoutingCompatibilityEvidenceLayer, string>>;
  route?: ResolvedPolicyRouteSubject;
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

function resolveEffectivePolicyProvider(
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
): OcxProviderConfig {
  return resolveWireProtocolOverride(providerName, modelId, routed, "responses");
}

/**
 * Resolve the subject identities a policy candidate may legitimately consume.
 * Protocol and live-route layers deliberately use different canonical subjects.
 * No network, projection rebuild, ledger replay, or Lab-state creation occurs.
 */
export function resolvePolicyCompatibilitySubjects(
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  configDir?: string,
): ResolvedPolicyCompatibilitySubjects {
  const effective = resolveEffectivePolicyProvider(providerName, modelId, routed);
  const baseUrl = typeof effective.baseUrl === "string" ? effective.baseUrl.trim() : "";
  const adapter = effective.adapter ?? "openai-responses";
  const upstreamProtocol = upstreamProtocolForAdapter(adapter);
  const surface = surfaceForProtocols(POLICY_INBOUND_PROTOCOL, upstreamProtocol);
  const subjectIds: ResolvedPolicyCompatibilitySubjects["subjectIds"] = {};

  try {
    const protocolSubject = buildProtocolSubjectV1({
      inboundProtocol: POLICY_INBOUND_PROTOCOL,
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
    inboundProtocol: POLICY_INBOUND_PROTOCOL,
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

import { localFingerprint } from "../digest";
import type { RouteDependencyV1, RouteSubjectV1 } from "../events/types";
import type { LabDestinationV1, LabRouteContext } from "../live/types";
import { buildBehaviorFingerprintV1 } from "./behavior-fingerprint";
import { readInstallationSalt } from "./installation-salt";

function compareDependency(a: RouteDependencyV1, b: RouteDependencyV1): number {
  const fields: Array<keyof RouteDependencyV1> = [
    "role", "providerId", "providerInstanceFingerprint", "upstreamModelId", "endpointFingerprint",
    "clientModelId", "effectiveAdapter", "upstreamProtocol", "behaviorFingerprint",
  ];
  for (const field of fields) {
    const av = a[field];
    const bv = b[field];
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function canonicalDependencies(dependencies: RouteDependencyV1[] | undefined): RouteDependencyV1[] {
  const rows = (dependencies ?? []).map((row) => Object.freeze({ ...row }));
  rows.sort(compareDependency);
  for (let i = 1; i < rows.length; i++) {
    if (compareDependency(rows[i - 1]!, rows[i]!) === 0) {
      throw new Error("harness_failure: duplicate route dependency");
    }
  }
  return rows;
}

/** Build RouteSubjectV1 only from an approved immutable destination and authoritative effective resolver inputs. */
export function buildRouteSubjectV1(
  routeContext: LabRouteContext,
  destination: LabDestinationV1,
  configDir?: string,
  installationSalt?: Uint8Array | string,
): RouteSubjectV1 {
  if (!routeContext.providerInstanceKey) throw new Error("harness_failure: provider instance identity is required");
  if (!/^[0-9a-f]{64}$/.test(routeContext.opencodexCompatibilityVersion)) {
    throw new Error("harness_failure: invalid opencodexCompatibilityVersion");
  }
  const adapterValue = routeContext.behaviorValues["wire.adapter"]?.value;
  const protocolValue = routeContext.behaviorValues["wire.upstreamProtocol"]?.value;
  if (adapterValue !== routeContext.effectiveAdapter || protocolValue !== routeContext.upstreamProtocol) {
    throw new Error("harness_failure: behavior resolver output does not match exact route");
  }
  const salt = installationSalt ?? readInstallationSalt(configDir);
  const providerInstanceFingerprint = localFingerprint("providerInstance", routeContext.providerInstanceKey, salt);
  const dependencies = canonicalDependencies(routeContext.dependencies);
  const subject: RouteSubjectV1 = {
    subjectSchemaVersion: 1,
    subjectKind: "route",
    providerId: routeContext.providerId,
    providerInstanceFingerprint,
    clientModelId: routeContext.clientModelId,
    upstreamModelId: routeContext.upstreamModelId,
    effectiveAdapter: routeContext.effectiveAdapter,
    inboundProtocol: routeContext.inboundProtocol,
    upstreamProtocol: routeContext.upstreamProtocol,
    surface: routeContext.surface,
    opencodexCompatibilityVersion: routeContext.opencodexCompatibilityVersion,
    behaviorFingerprint: buildBehaviorFingerprintV1(routeContext.behaviorValues),
    endpointFingerprint: destination.fingerprint,
    dependencies,
  };
  return freezeRouteSubject(subject);
}

/** Deep-freeze route dependencies as well as the subject shell. */
export function freezeRouteSubject(subject: RouteSubjectV1): RouteSubjectV1 {
  const dependencies = subject.dependencies.map((row) => Object.freeze({ ...row }));
  return Object.freeze({ ...subject, dependencies: Object.freeze(dependencies) as unknown as RouteDependencyV1[] });
}

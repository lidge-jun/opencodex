import {
  FABRIC_COMPATIBILITY_VERSION,
  FABRIC_TASK_CLASS_ID,
  FABRIC_TASK_CLASS_VERSION,
  FABRIC_VERIFIER_ID,
} from "../fabric/constants";
import { sandboxProfileDigest, taskFixtureDigest, verifierManifestDigest } from "../fabric/subject";
import { subjectIdForSubject } from "../digest";
import type { RouteSubjectV1, TaskSubjectV1 } from "../events/types";
import { PUBLIC_ROUTE_REGISTRY_V1, findPublicRouteRegistryEntry } from "./registry";
import type {
  PublicAdapterFamilyV1,
  PublicRouteAuthorityV1,
  PublicRouteSubjectV1,
  PublicTaskAuthorityV1,
  PublicTaskSubjectV1,
} from "./types";

const routeAuthorities = new WeakSet<object>();
const taskAuthorities = new WeakSet<object>();

export function toPublicAdapterFamily(value: string): PublicAdapterFamilyV1 | null {
  switch (value) {
    case "openai-responses":
    case "responses":
      return "openai-responses";
    case "openai-chat":
    case "chat":
      return "openai-chat";
    case "anthropic":
    case "anthropic-messages":
      return "anthropic-messages";
    default:
      return null;
  }
}

function canonicalHttpsBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, url.pathname === "/" ? "/" : "");
  } catch {
    return null;
  }
}

export function authorizePublicRouteSubject(input: {
  subject: RouteSubjectV1;
  localSubjectId: string;
  effectiveBaseUrl: string;
  /** Closed names derived by the trusted export caller from effective config. Must be empty. */
  privateBehaviorDimensions: readonly string[];
}): PublicRouteAuthorityV1 | null {
  const { subject } = input;
  if (subjectIdForSubject(subject) !== input.localSubjectId) return null;
  if (subject.dependencies.length !== 0 || subject.clientModelId !== subject.upstreamModelId) return null;
  if (input.privateBehaviorDimensions.length !== 0) return null;

  const adapterFamily = toPublicAdapterFamily(subject.effectiveAdapter);
  const inboundProtocol = toPublicAdapterFamily(subject.inboundProtocol);
  const upstreamProtocol = toPublicAdapterFamily(subject.upstreamProtocol);
  if (!adapterFamily || !inboundProtocol || !upstreamProtocol) return null;

  const entry = findPublicRouteRegistryEntry(subject.providerId, subject.upstreamModelId, adapterFamily);
  if (!entry) return null;
  const effectiveBaseUrl = canonicalHttpsBaseUrl(input.effectiveBaseUrl);
  const canonicalBaseUrl = canonicalHttpsBaseUrl(entry.canonicalBaseUrl);
  if (!effectiveBaseUrl || !canonicalBaseUrl || effectiveBaseUrl !== canonicalBaseUrl) return null;

  const descriptor: PublicRouteSubjectV1 = Object.freeze({
    subjectKind: "route",
    providerId: subject.providerId,
    modelId: subject.upstreamModelId,
    adapterFamily,
    inboundProtocol,
    upstreamProtocol,
    surface: subject.surface,
    compatibilityVersion: subject.opencodexCompatibilityVersion,
    registryVersion: PUBLIC_ROUTE_REGISTRY_V1.registryVersion,
    registryDigest: PUBLIC_ROUTE_REGISTRY_V1.manifestDigest,
  });
  const authority: PublicRouteAuthorityV1 = Object.freeze({
    localSubjectId: input.localSubjectId,
    descriptor,
  });
  routeAuthorities.add(authority);
  return authority;
}

export function isTrustedPublicRouteAuthority(value: unknown): value is PublicRouteAuthorityV1 {
  return !!value && typeof value === "object" && routeAuthorities.has(value);
}

export function authorizePublicTaskSubject(input: {
  subject: TaskSubjectV1;
  localSubjectId: string;
  routeAuthority: PublicRouteAuthorityV1;
}): PublicTaskAuthorityV1 | null {
  const { subject } = input;
  if (!isTrustedPublicRouteAuthority(input.routeAuthority)) return null;
  if (subjectIdForSubject(subject) !== input.localSubjectId) return null;
  if (subjectIdForSubject(subject.routeSubject) !== input.routeAuthority.localSubjectId) return null;
  if (subject.taskClassId !== FABRIC_TASK_CLASS_ID
    || subject.taskClassVersion !== FABRIC_TASK_CLASS_VERSION
    || subject.taskFixtureDigest !== taskFixtureDigest()
    || subject.verifierManifestDigest !== verifierManifestDigest()
    || subject.fabricCompatibilityVersion !== FABRIC_COMPATIBILITY_VERSION
    || subject.sandboxProfileDigest !== sandboxProfileDigest()) return null;

  const descriptor: PublicTaskSubjectV1 = Object.freeze({
    subjectKind: "task",
    route: input.routeAuthority.descriptor,
    taskClassId: FABRIC_TASK_CLASS_ID,
    taskClassVersion: FABRIC_TASK_CLASS_VERSION,
    verifierAuthorityId: FABRIC_VERIFIER_ID,
  });
  const authority: PublicTaskAuthorityV1 = Object.freeze({
    localSubjectId: input.localSubjectId,
    descriptor,
  });
  taskAuthorities.add(authority);
  return authority;
}

export function isTrustedPublicTaskAuthority(value: unknown): value is PublicTaskAuthorityV1 {
  return !!value && typeof value === "object" && taskAuthorities.has(value);
}

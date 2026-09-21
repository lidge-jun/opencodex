import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseStrictSemver } from "../lib/strict-semver";
import type {
  ServiceInstallState,
  ServiceOwnershipSubject,
} from "./state";
import {
  SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
  SERVICE_OWNERSHIP_PROTOCOL_VERSION,
} from "./install-state-contract.mjs";

export type ManagingCliRole = "service-registration" | "path";

export type ManagingCliObservation =
  | { readonly status: "absent" }
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "observed"; readonly version: string; readonly identity: string };

export type RegisteredManagingCliInvocation =
  | { readonly status: "absent" }
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "resolved"; readonly executable: string; readonly args: readonly string[] };

/** Resolve the exact command baked into the preserved service registration. */
export function registeredManagingCliInvocation(
  state: ServiceInstallState | null,
): RegisteredManagingCliInvocation {
  if (!state) return { status: "absent" };
  if (state.launcherPath) {
    return isAbsolute(state.launcherPath)
      ? { status: "resolved", executable: state.launcherPath, args: [] }
      : { status: "unknown", reason: "the recorded service launcher is not absolute" };
  }
  if (!state.bunPath || !isAbsolute(state.bunPath)) {
    return { status: "unknown", reason: "the registered service executable is missing or not absolute" };
  }
  if (state.cliPath === null) return { status: "resolved", executable: state.bunPath, args: [] };
  if (typeof state.cliPath === "string" && isAbsolute(state.cliPath)) {
    return { status: "resolved", executable: state.bunPath, args: [state.cliPath] };
  }
  return { status: "unknown", reason: "the registered service CLI path is missing or not absolute" };
}

export interface ServiceTakeoverCompatibilityInput {
  readonly state: ServiceInstallState | null;
  readonly subject: ServiceOwnershipSubject;
  readonly managers: Readonly<Record<ManagingCliRole, ManagingCliObservation>>;
}

export type ServiceTakeoverCompatibility =
  | {
      readonly kind: "supported";
      readonly protocolVersion: typeof SERVICE_OWNERSHIP_PROTOCOL_VERSION;
      readonly minimumCliVersion: typeof SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION;
      /** Opaque binding over the approved subject and both managing-CLI observations. */
      readonly token: string;
    }
  | {
      readonly kind: "blocked";
      readonly reason:
        | "managing-cli-unknown"
        | "managing-cli-unsupported"
        | "managing-cli-unobserved"
        | "service-protocol-unsupported";
      readonly detail: string;
      readonly minimumCliVersion: typeof SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION;
    };

function comparePrerelease(left: readonly (bigint | string)[], right: readonly (bigint | string)[]): number {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : 1;
    if (typeof a === "bigint") return -1;
    if (typeof b === "bigint") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function versionSupportsOwnership(value: string): boolean {
  const actual = parseStrictSemver(value);
  const minimum = parseStrictSemver(SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION);
  if (!actual || !minimum) return false;
  for (let index = 0; index < actual.core.length; index += 1) {
    if (actual.core[index] !== minimum.core[index]) return actual.core[index]! > minimum.core[index]!;
  }
  return comparePrerelease(actual.prerelease, minimum.prerelease) >= 0;
}

function compatibilityToken(input: ServiceTakeoverCompatibilityInput): string {
  return createHash("sha256").update(JSON.stringify({
    subject: input.subject,
    protocolVersion: input.state?.ownershipProtocolVersion ?? null,
    managers: {
      "service-registration": input.managers["service-registration"],
      path: input.managers.path,
    },
  })).digest("hex");
}

/**
 * Decide whether permanent desktop ownership can be offered.
 *
 * Both managing surfaces are mandatory observations. `absent` is a trustworthy answer;
 * `unknown` is not. An observed service registration additionally needs the protocol marker
 * written by a CLI whose start/repair/update paths honor the ownership claim. This is what
 * keeps the preserved registration from starting an older runtime at the next login.
 */
export function assessServiceTakeoverCompatibility(
  input: ServiceTakeoverCompatibilityInput,
): ServiceTakeoverCompatibility {
  const observed = Object.entries(input.managers) as Array<[ManagingCliRole, ManagingCliObservation]>;
  const unknown = observed.find(([, manager]) => manager.status === "unknown");
  if (unknown) return {
    kind: "blocked",
    reason: "managing-cli-unknown",
    detail: `${unknown[0]} compatibility could not be determined`,
    minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
  };
  const present = observed.filter(([, manager]) => manager.status === "observed") as Array<[
    ManagingCliRole,
    Extract<ManagingCliObservation, { status: "observed" }>,
  ]>;
  if (present.length === 0) return {
    kind: "blocked",
    reason: "managing-cli-unobserved",
    detail: "no managing OpenCodex CLI installation was observed",
    minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
  };
  const unsupported = present.find(([, manager]) => !versionSupportsOwnership(manager.version));
  if (unsupported) return {
    kind: "blocked",
    reason: "managing-cli-unsupported",
    detail: `${unsupported[0]} uses OpenCodex ${unsupported[1].version}; ${SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION} or later is required`,
    minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
  };
  if (input.managers["service-registration"].status === "observed"
    && input.state?.ownershipProtocolVersion !== SERVICE_OWNERSHIP_PROTOCOL_VERSION) {
    return {
      kind: "blocked",
      reason: "service-protocol-unsupported",
      detail: "the preserved service registration was not written by an ownership-aware CLI",
      minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
    };
  }
  return {
    kind: "supported",
    protocolVersion: SERVICE_OWNERSHIP_PROTOCOL_VERSION,
    minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
    token: compatibilityToken(input),
  };
}

export function sameServiceTakeoverCompatibility(
  left: ServiceTakeoverCompatibility,
  right: ServiceTakeoverCompatibility,
): boolean {
  return left.kind === "supported" && right.kind === "supported" && left.token === right.token;
}

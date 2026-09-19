import type { OcxConfig } from "../types";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import {
  resolveCodexModelEntitlements,
  type CodexModelEntitlementResolveOptions,
  type CodexModelEntitlementSnapshot,
} from "./model-entitlements";
import {
  type NativeMainCredentialAdmissionDeps,
  withNativeMainCredentialAdmission,
} from "./native-main-admission";

interface ModelEntitlementAdmissionDeps extends NativeMainCredentialAdmissionDeps {
  readonly resolve?: typeof resolveCodexModelEntitlements;
}

function excludeNativeMain(
  options: CodexModelEntitlementResolveOptions,
): CodexModelEntitlementResolveOptions {
  return {
    ...options,
    excludeAccountIds: new Set([
      ...(options.excludeAccountIds ?? []),
      MAIN_CODEX_ACCOUNT_ID,
    ]),
  };
}

/**
 * Resolve background/data-plane entitlements inside the native-main fences.
 *
 * Pool discovery remains available when startup recovery or a profile drain
 * owns the physical credential. When main is admitted, the process-local lease
 * covers only the credential snapshot: getValidMainAccountToken holds the
 * cross-process exclusive claim just for the auth.json refresh write, and the
 * lease is released before the upstream entitlement request so a profile drain
 * never waits on a network fetch.
 */
export async function resolveAdmittedCodexModelEntitlements(
  config: Pick<OcxConfig, "codexAccounts">,
  options: CodexModelEntitlementResolveOptions = {},
  deps: ModelEntitlementAdmissionDeps = {},
): Promise<CodexModelEntitlementSnapshot> {
  const resolve = deps.resolve ?? resolveCodexModelEntitlements;
  // A caller-supplied roster or an already-excluded main never reads auth.json,
  // so there is no native credential to fence.
  if (options.credentials || options.excludeAccountIds?.has(MAIN_CODEX_ACCOUNT_ID)) {
    return resolve(config, options);
  }
  return withNativeMainCredentialAdmission(
    (excludedAccountIds, releaseMainLease) => resolve(
      config,
      excludedAccountIds.size === 0
        ? { ...options, releaseNativeMainCredentialLease: releaseMainLease }
        : excludeNativeMain(options),
    ),
    { acquireNativeMain: deps.acquireNativeMain },
  );
}

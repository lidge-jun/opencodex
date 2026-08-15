import {
  runtimeRequest,
  type RuntimeApiDeps,
} from "./runtime-api";

export const CODEX_ACCOUNT_TARGET_CAPABILITY_PATH = "/api/codex-auth/account-target-options";
export const CODEX_ACCOUNT_TARGET_CAPABILITY_ERROR =
  "The running proxy does not support custom-model Codex account targets; update the proxy and retry";

/**
 * Feature-specific capability probe used before CLI writes. A reflected unknown config field is
 * not proof that an older passthrough server can route it, so require the new metadata endpoint.
 */
export async function assertCodexAccountTargetRuntimeCapability(
  deps: RuntimeApiDeps = {},
): Promise<void> {
  let payload: { targets?: unknown };
  try {
    payload = await runtimeRequest<{ targets?: unknown }>(
      CODEX_ACCOUNT_TARGET_CAPABILITY_PATH,
      {},
      deps,
    );
  } catch {
    throw new Error(CODEX_ACCOUNT_TARGET_CAPABILITY_ERROR);
  }
  if (
    !Array.isArray(payload.targets)
    || !payload.targets.some(target => (
      !!target
      && typeof target === "object"
      && (target as { target?: unknown }).target === "@main"
    ))
  ) {
    throw new Error(CODEX_ACCOUNT_TARGET_CAPABILITY_ERROR);
  }
}

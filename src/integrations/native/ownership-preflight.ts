/**
 * The service-home preflight for native-client teardown (WP2, audit r1 #5;
 * devlog 260803_integrations_toggle_all/012).
 *
 * `ocx stop` has honored `ServiceOwnershipError` since it started catching it
 * (src/cli/index.ts:464); nothing on the HTTP side ever did. A route that calls
 * `stripGrokConfig` directly would otherwise pull the fence out from under a
 * service running from another CODEX_HOME/OPENCODEX_HOME — the installed
 * service is still live and the shared state belongs to it.
 *
 * ENABLE is not gated by this: writing our own fence is not a shared teardown,
 * and `injectGrokConfig` already runs unguarded from `ocx start`/`ensure`.
 */
import {
  assertServiceEnvironmentMatchesInstall,
  isServiceOwnershipError,
} from "../../service";

export type NativeTeardownOwnership = { ok: true } | { ok: false; message: string };

export function assertNativeTeardownOwned(): NativeTeardownOwnership {
  try {
    assertServiceEnvironmentMatchesInstall();
    return { ok: true };
  } catch (error) {
    if (isServiceOwnershipError(error)) {
      // The message names both the recorded and the current home — that is the
      // refusal text, verbatim, because the user has to act on it.
      return { ok: false, message: error.message };
    }
    // Unrelated failure (corrupt state file, IO): mirror
    // `serviceEnvironmentOwnedHere` and fail open rather than wedging the route
    // behind a check whose own input is broken.
    return { ok: true };
  }
}

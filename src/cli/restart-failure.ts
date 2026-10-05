import type { ProxyRestartResult } from "./tray-proxy";

export const INCOMPLETE_INSTALL_RECOVERY = "If the installer already exited or failed, run `ocx status`, stop any running proxy through its owner (`ocx stop`, or its service or desktop app), then reinstall with the same package manager and start it again (see https://opencodex.me/troubleshooting/update-failed/).";

export function reportRestartFailure(result: Extract<ProxyRestartResult, { ok: false }>): void {
  if (result.phase === "identity") {
    console.error("Refusing to restart because the running proxy identity could not be attested. Run `ocx status` to inspect the intended proxy.");
  } else if (result.phase === "request") {
    const code = result.error instanceof Error ? result.error.message : "";
    if (code === "restart_capability_unsupported") {
      console.error("The running proxy predates process-bound restart support; no unsafe fallback was attempted.");
      console.error("   After confirming this home owns the proxy, run `ocx stop` and then `ocx start` once.");
    } else if (code === "restart_version_skew") {
      console.error("This CLI is older than the running proxy (or versions cannot be compared). Use the newer installation's ocx to restart; check `which -a ocx` and run `ocx status`. No changes were made.");
    } else if (code === "update_restart_home_unverified") {
      console.error("The proxy home or lifecycle ownership could not be verified. Run `ocx status`; if a service owns the proxy, use its installation's `ocx service restart`, otherwise use the owning app or supervisor. No changes were made.");
    } else if (code === "restart_package_tree_unsettled") {
      console.error(`The proxy's package files are unsettled. Wait for the install to finish, then run \`ocx restart\`. ${INCOMPLETE_INSTALL_RECOVERY}`);
    } else {
      console.error("Proxy restart request could not be confirmed; no fallback stop/start was attempted. Run `ocx status` to inspect ownership and runtime state.");
    }
  } else if (result.phase === "replacement") {
    console.error("Proxy restart was accepted, but no identity-verified replacement became healthy in time. Run `ocx status` to inspect the replacement.");
  } else {
    console.error("Proxy was not running and the fallback start did not become healthy. Run `ocx status` to inspect startup state.");
  }
}

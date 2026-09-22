import {
  createRuntimePackageTreeIntegrityGuard,
  type PackageTreeIntegrityGuard,
} from "../../lib/package-tree-integrity";
import { acceptSystemRestart } from "../management/system-restart";
import { detectInstall } from "../../update/index";
import type { StartServerDeps } from "./startup-warnings";

// Production guard wiring for the package-tree integrity fence. Tests inject
// deps.packageTreeIntegrity and never reach this path; everything else is the
// same default the inline construction used to build.
export function createPackageTreeIntegrityGuardForServer(
  deps: StartServerDeps,
): PackageTreeIntegrityGuard {
  if (deps.packageTreeIntegrity) {
    return deps.packageTreeIntegrity;
  }
  const acceptPackageTreeRestart = deps.acceptSystemRestart ?? acceptSystemRestart;
  return createRuntimePackageTreeIntegrityGuard(
    deps.packageTreeInstaller ?? detectInstall(),
    deps.observePackageTree,
    undefined,
    {
      ...deps.packageTreeIntegrityOptions,
      onReplaced: () => {
        // An out-of-band install replaced the package under this live process. Serve
        // the 503 for the triggering request, then let the standard drain-and-restart
        // path bring the new tree up instead of refusing traffic until a manual
        // restart. acceptSystemRestart is idempotent and supervisor-aware.
        acceptPackageTreeRestart();
      },
    },
  );
}

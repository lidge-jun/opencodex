import { guardedUpdateIo } from "./update-guarded-io.mjs";
import { createMutationAuthorizer } from "../../src/update/mutation-guard.mjs";

/** Upgrade older I/O-only policy doubles when executing the production update bodies. */
export function updateSourceFunction(...args: string[]) {
  const execute = new Function(...args);
  return (deps: Record<string, any>) => {
    const policy = deps.homePolicy;
    if (policy && !policy.authorizeMutation) {
      policy.authorizeMutation = createMutationAuthorizer({
        check: () => policy.check(), checkPackage: () => (policy.checkPackage ?? policy.check)(),
        get serviceAllowed() { return policy.serviceAllowed ?? true; },
      });
    }
    return execute({ ...deps, ...guardedUpdateIo(deps) });
  };
}

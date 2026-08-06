import { projectCatalogOnlyOutcome } from "../../src/codex/management-convergence";
import type { ConvergeCodex } from "../../src/codex/convergence-types";
import type { OcxConfig } from "../../src/types";

export function catalogConvergenceFactory(
  run: () => Promise<void> | void = () => {},
): (config: Readonly<OcxConfig>) => ConvergeCodex {
  return () => async () => {
    await run();
    return projectCatalogOnlyOutcome({
      changed: false,
      catalogRefresh: { status: "committed", changed: false, degraded: false, notices: [] },
    });
  };
}

import { projectCatalogOnlyOutcome } from "../../src/codex/management-convergence";
import type { CatalogDisposition, ConvergeCodex } from "../../src/codex/convergence-types";
import type { OcxConfig } from "../../src/types";

const committedCatalog: CatalogDisposition = {
  status: "committed",
  changed: false,
  degraded: false,
  notices: [],
};

export function catalogConvergenceFactory(
  run: () => Promise<void> | void = () => {},
  catalogRefresh: CatalogDisposition = committedCatalog,
): (config: Readonly<OcxConfig>) => ConvergeCodex {
  return () => async () => {
    await run();
    return projectCatalogOnlyOutcome({
      changed: catalogRefresh.status === "committed" ? catalogRefresh.changed : false,
      catalogRefresh,
    });
  };
}

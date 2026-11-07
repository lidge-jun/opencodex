import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { resolveCodexSqliteHome } from "../codex/paths";
import { inspectNativeCodexOwnership, type OwnershipDeps } from "../integrations/native/ownership-preflight";
import { compareServicePathToInstall, currentServiceHomes, inspectServiceStateEvidence, resolveServiceState, serviceStatePaths } from "../service/state";

export { createUpdateServiceHomePolicy, updateServiceHomeRefusal } from "./service-home-policy.mjs";
export type UpdateServiceHomeAuthority = import("./service-home-policy.mjs").UpdateServiceHomeAuthority;
export type UpdateServiceHomeInspector = () => UpdateServiceHomeAuthority;

/** Automatic restart authority, distinct from the interactive guard's fail-open policy. */
export function inspectUpdateServiceHome(deps: OwnershipDeps = {}): UpdateServiceHomeAuthority {
  try {
    const paths = deps.statePaths ?? serviceStatePaths();
    const homes = deps.currentHomes ?? currentServiceHomes();
    const before = resolveServiceState(inspectServiceStateEvidence(paths));
    if (before.kind === "unknown") return { kind: "unknown" };
    const ownership = inspectNativeCodexOwnership({ ...deps, statePaths: paths, currentHomes: homes });
    if (ownership.ownership === "unknown") return { kind: "unknown" };
    // 'owned' alone includes no record and no registration. Preserve that absence.
    let kind: UpdateServiceHomeAuthority["kind"] = ownership.ownership === "foreign" ? "foreign" : before.kind === "none" ? "absent" : "same";
    if (kind === "same" && before.kind === "state" && before.state.codexSqliteHome !== undefined) {
      const sqlite = compareServicePathToInstall(before.state.codexSqliteHome,
        resolveCodexSqliteHome({ codexHome: homes.codexHome }), { realpathSync: deps.realpathSync });
      if (sqlite !== "same") kind = sqlite === "different" ? "foreign" : "unknown";
    }
    const after = resolveServiceState(inspectServiceStateEvidence(paths));
    if (!isDeepStrictEqual(before, after) || !isDeepStrictEqual(homes, deps.currentHomes ?? currentServiceHomes())) {
      return { kind: "unknown" };
    }
    return kind === "foreign" ? { kind, subject: createHash("sha256").update(JSON.stringify({ before, homes })).digest("hex") } : { kind };
  } catch {
    return { kind: "unknown" };
  }
}

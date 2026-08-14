/**
 * Registers Compatibility Lab's passive route-subject linker into the core slot.
 *
 * Imported only from the Lab activation path, never from the request path. This module
 * lives outside `src/lab/` for the same reason the other `src/lib/lab-*.ts` host
 * integrations do: it is the seam between core and the subsystem, not the subsystem.
 *
 * @internal host integration only
 */
import { setPassiveRouteLinker } from "../server/passive-route-linker";
import { resolveProductionRouteSubject } from "../routing/compatibility/subject";

/** Install the Lab linker. Returns a detach function. */
export function registerLabPassiveRouteLinker(configDir?: string): () => void {
  return setPassiveRouteLinker((config, providerName, modelId, routed, inboundWire) => {
    const subject = resolveProductionRouteSubject(
      config,
      providerName,
      modelId,
      routed,
      inboundWire,
      configDir,
    );
    return subject ? subject.subjectId : null;
  });
}

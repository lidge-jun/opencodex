/** Compatibility surface for the shared install-state contract landed before C2 hardening. */
import {
  inspectServiceStateRecords,
  parseServiceInstallStateRecord,
  parseServiceOwnershipRecord,
  SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
  SERVICE_OWNERSHIP_PROTOCOL_VERSION,
  selectAuthoritativeServiceState,
  serviceStateFingerprint,
  serviceStatePathsForHomes,
} from "./state-record.mjs";

export const SERVICE_STATE_FILE = "service-state.json";
export const parseOwnershipClaim = parseServiceOwnershipRecord;
export const parseInstallStateRecord = parseServiceInstallStateRecord;
export const serviceStateFilesFor = serviceStatePathsForHomes;
export {
  SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
  SERVICE_OWNERSHIP_PROTOCOL_VERSION,
  selectAuthoritativeServiceState,
  serviceStateFingerprint,
};

export function inspectInstallStateBytes(path, read) {
  return inspectServiceStateRecords([path], read)[0];
}

export function resolveOwnershipFromEvidence(evidence) {
  const selected = selectAuthoritativeServiceState(evidence);
  if (selected.kind === "unknown" || selected.kind === "none") return selected;
  return selected.state.ownership
    ? { kind: "owned", ownership: selected.state.ownership, revision: selected.revision }
    : { kind: "none", revision: selected.revision };
}

/**
 * The service install-state contract, shared by both runtimes.
 *
 * `src/service/state.ts` is the authoritative reader and `bin/ocx.mjs` is the Node launcher
 * that cannot import TypeScript. They used to validate the record separately, and the
 * launcher's copy was weaker in two ways that mattered: it inspected only the anchor path,
 * and it returned "known unowned" for any record whose `ownership` field was simply absent —
 * including a record that fails the contract outright, such as one with no homes or an
 * unsupported version. A takeover the Bun updater refused to disturb was therefore fair game
 * for the npm and pnpm lane.
 *
 * This module is the one algorithm. Both sides import it, so the two lanes cannot answer the
 * same question differently.
 */
import { join, resolve } from "node:path";

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate an ownership claim read off disk.
 *
 * Returns the ORIGINAL object rather than a rebuilt one: a newer writer may carry fields
 * this version does not know about, and rebuilding would drop them on the next preserve —
 * the same lost-field failure the record exists to stop.
 */
export function parseOwnershipClaim(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.owner !== "cli" && value.owner !== "desktop") return null;
  if (typeof value.installId !== "string" || value.installId.length === 0) return null;
  if (!isNonNegativeInteger(value.consentGeneration)) return null;
  return value;
}

/** Validate a whole install record. Null means the bytes are not a record this tree wrote. */
export function parseInstallStateRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== 1 && value.version !== 2) return null;
  if (typeof value.codexHome !== "string" || value.codexHome.length === 0) return null;
  if (typeof value.opencodexHome !== "string" || value.opencodexHome.length === 0) return null;
  for (const key of ["codexSqliteHome", "bunPath", "launcherPath", "winswVersion", "winswSha256"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0)) return null;
  }
  // cliPath is the one path that is legitimately null: cliEntry() returns null for a
  // standalone binary, and the writer stores it.
  if (value.cliPath !== undefined && value.cliPath !== null
    && (typeof value.cliPath !== "string" || value.cliPath.length === 0)) return null;
  if (value.revision !== undefined && !isNonNegativeInteger(value.revision)) return null;
  if (value.consentGenerationCeiling !== undefined && !isNonNegativeInteger(value.consentGenerationCeiling)) return null;
  // A malformed ownership claim invalidates the whole record instead of being dropped:
  // silently discarding it is precisely the demotion this field exists to prevent, and a
  // reader that cannot trust the claim must not be told the runtime is unowned.
  if (value.ownership !== undefined && parseOwnershipClaim(value.ownership) === null) return null;
  if (value.version === 1) {
    if (value.backend !== undefined) return null;
  } else if (value.backend !== "scheduler" && value.backend !== "native") {
    return null;
  }
  return value;
}

/**
 * Classify one state path's bytes. `read` returns the text, or throws; an ENOENT throw is
 * absence and every other throw is a failure to ask.
 *
 * Absent, unreadable and invalid are three different answers. Collapsing them is how a
 * locked-down or truncated record becomes permission to reactivate the npm launcher.
 */
export function inspectInstallStateBytes(path, read) {
  let raw;
  try {
    raw = read(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return { path, kind: "absent" };
    return { path, kind: "unreadable", reason: code || String(error) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { path, kind: "invalid" };
  }
  const state = parseInstallStateRecord(parsed);
  return state ? { path, kind: "valid", state } : { path, kind: "invalid" };
}

/**
 * What every state path, together, says about who owns the runtime.
 *
 * An unknown resolution is the answer that matters. A single null for "absent, unreadable or
 * malformed" lets a caller read a permissions error as "the CLI owns it" and re-enable the
 * npm launcher over a consented takeover. Absence is the only thing that may mean no claim.
 */
export function resolveOwnershipFromEvidence(evidence) {
  for (const entry of evidence) {
    // Any path. A claim we are not allowed to look at is still a claim.
    if (entry.kind === "unreadable") {
      return { kind: "unknown", reason: `a service state path could not be read (${entry.reason})` };
    }
  }
  // Only the ANCHOR's corruption is fatal. The second path is the legacy default-home entry
  // kept so an install made before OPENCODEX_HOME existed can still be found; unrelated junk
  // left there by an old version must not be able to block every repair on this machine.
  if (evidence[0] && evidence[0].kind === "invalid") {
    return { kind: "unknown", reason: "the service install record is present but not valid" };
  }
  const claims = [];
  for (const entry of evidence) {
    if (entry.kind === "valid" && entry.state.ownership) claims.push(entry.state.ownership);
  }
  const first = claims[0];
  if (first === undefined) return { kind: "none" };
  if (claims.some(claim => claim.owner !== first.owner || claim.installId !== first.installId)) {
    return { kind: "unknown", reason: "the service state paths name different owners" };
  }
  // Same claim in both places; the higher generation is the later write.
  let best = first;
  for (const claim of claims) if (claim.consentGeneration > best.consentGeneration) best = claim;
  return { kind: "owned", ownership: best };
}

export const SERVICE_STATE_FILE = "service-state.json";

/**
 * The state files to consult, in the order every reader resolves them: this OpenCodex home
 * first, then the legacy default home kept for installs made before OPENCODEX_HOME existed.
 *
 * Shared so the launcher cannot inspect a shorter list than the authoritative reader — which
 * it did, seeing only the anchor and never the legacy claim beside it.
 */
export function serviceStateFilesFor(opencodexHomeDir, defaultHomeDir) {
  const anchor = join(opencodexHomeDir, SERVICE_STATE_FILE);
  const legacy = join(defaultHomeDir, SERVICE_STATE_FILE);
  const same = process.platform === "win32"
    ? resolve(anchor).toLowerCase() === resolve(legacy).toLowerCase()
    : resolve(anchor) === resolve(legacy);
  return same ? [anchor] : [anchor, legacy];
}


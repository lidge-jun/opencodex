import { readFileSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

export const SERVICE_OWNERSHIP_PROTOCOL_VERSION = 1;
export const SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION = "2.61.0";

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonNegativeSafeInteger = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nonEmptyString = value => typeof value === "string" && value.length > 0;

/** Parse the ownership payload shared by the Bun service code and the Node launcher. */
export function parseServiceOwnershipRecord(value) {
  if (!isObject(value)) return null;
  if (value.owner !== "cli" && value.owner !== "desktop") return null;
  if (!nonEmptyString(value.installId) || !isNonNegativeSafeInteger(value.consentGeneration)) return null;
  return value;
}

/** Parse the COMPLETE install record; ownership alone is not enough to trust the file. */
export function parseServiceInstallStateRecord(value) {
  if (!isObject(value) || (value.version !== 1 && value.version !== 2)) return null;
  if (!nonEmptyString(value.codexHome) || !nonEmptyString(value.opencodexHome)) return null;
  for (const key of ["codexSqliteHome", "bunPath", "launcherPath", "winswVersion", "winswSha256"]) {
    if (value[key] !== undefined && !nonEmptyString(value[key])) return null;
  }
  if (value.cliPath !== undefined && value.cliPath !== null && !nonEmptyString(value.cliPath)) return null;
  if (value.revision !== undefined && !isNonNegativeSafeInteger(value.revision)) return null;
  if (value.consentGenerationCeiling !== undefined && !isNonNegativeSafeInteger(value.consentGenerationCeiling)) return null;
  if (value.ownershipProtocolVersion !== undefined && !isNonNegativeSafeInteger(value.ownershipProtocolVersion)) return null;
  if (value.ownership !== undefined && parseServiceOwnershipRecord(value.ownership) === null) return null;
  if (value.version === 1) {
    if (value.backend !== undefined) return null;
  } else if (value.backend !== "scheduler" && value.backend !== "native") return null;
  return value;
}

export function serviceStatePathsForHomes(opencodexHome, defaultOpenCodexHome, platform = process.platform) {
  const tools = platform === "win32" ? win32 : posix;
  const primary = tools.join(opencodexHome, "service-state.json");
  const legacy = tools.join(defaultOpenCodexHome, "service-state.json");
  const key = path => {
    let canonical;
    try { canonical = realpathSync.native(path); }
    catch {
      try { canonical = tools.join(realpathSync.native(tools.dirname(path)), tools.basename(path)); }
      catch { canonical = tools.resolve(path); }
    }
    return platform === "win32" ? canonical.toLowerCase() : canonical;
  };
  return key(primary) === key(legacy) ? [primary] : [primary, legacy];
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code ?? "") : "";
}

/** Read every supplied state path without collapsing absent, invalid and unreadable. */
export function inspectServiceStateRecords(paths, read = path => readFileSync(path, "utf8")) {
  return paths.map(path => {
    let raw;
    try {
      raw = read(path);
    } catch (error) {
      const code = errorCode(error);
      return code === "ENOENT"
        ? { path, kind: "absent" }
        : { path, kind: "unreadable", reason: code || String(error) };
    }
    try {
      const state = parseServiceInstallStateRecord(JSON.parse(raw));
      return state ? { path, kind: "valid", state } : { path, kind: "invalid" };
    } catch {
      return { path, kind: "invalid" };
    }
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function serviceStateFingerprint(value) {
  return canonical(value);
}

/**
 * Select one authoritative generation from mirrored state.
 *
 * The final path is authoritative. A lower-revision mirror is repairable; a same-or-newer
 * disagreement is unordered evidence and fails closed. Before the authority exists, one valid
 * active-home record is imported exactly once as migration input.
 */
export function selectAuthoritativeServiceState(evidence) {
  const authority = evidence.at(-1);
  if (!authority) return { kind: "none", revision: 0, needsRepair: false };
  if (authority.kind === "unreadable") {
    return { kind: "unknown", reason: `the authoritative service state could not be read (${authority.reason})` };
  }
  if (authority.kind === "invalid") {
    return { kind: "unknown", reason: "the authoritative service install record is present but not valid" };
  }
  if (authority.kind === "valid") {
    const fingerprint = canonical(authority.state);
    const authorityRevision = authority.state.revision ?? 0;
    const unorderedConflict = evidence.slice(0, -1).find(entry => entry.kind === "valid"
      && (entry.state.revision ?? 0) >= authorityRevision
      && canonical(entry.state) !== fingerprint);
    if (unorderedConflict) {
      return { kind: "unknown", reason: `a service state mirror conflicts with authority revision ${authorityRevision}` };
    }
    return {
      kind: "state",
      state: authority.state,
      revision: authorityRevision,
      needsRepair: evidence.slice(0, -1).some(entry => entry.kind !== "valid" || canonical(entry.state) !== fingerprint),
    };
  }

  // The authority has never been established. A single valid active-home mirror is the
  // migration source; after the first write it can no longer vote against the authority.
  const migration = evidence.slice(0, -1);
  const unreadable = migration.find(entry => entry.kind === "unreadable");
  if (unreadable) return { kind: "unknown", reason: `a legacy service state path could not be read (${unreadable.reason})` };
  if (migration.some(entry => entry.kind === "invalid")) {
    return { kind: "unknown", reason: "a legacy service install record is present but not valid" };
  }
  const valid = migration.filter(entry => entry.kind === "valid");
  if (valid.length === 0) return { kind: "none", revision: 0, needsRepair: false };
  const revision = Math.max(...valid.map(entry => entry.state.revision ?? 0));
  const newest = valid.filter(entry => (entry.state.revision ?? 0) === revision);
  const fingerprint = canonical(newest[0].state);
  if (newest.some(entry => canonical(entry.state) !== fingerprint)) {
    return { kind: "unknown", reason: `legacy service state mirrors disagree at revision ${revision}` };
  }
  return { kind: "state", state: newest[0].state, revision, needsRepair: true };
}

import { createMutationAuthorizer } from "./mutation-guard.mjs";
/** Pure policy shared by the Node launcher and Bun update paths. */
/** @typedef {{ readonly kind: "same" | "foreign" | "unknown" | "absent" | "invalid", readonly subject?: string }} UpdateServiceHomeAuthority */

export const UPDATE_HOME_SCHEMA_VERSION = 1;
export const UPDATE_HOME_LAUNCHER_PROTOCOL = 1;
export const UPDATE_PACKAGE_ONLY_EXIT_CODE = 75;
/** v2 children accept the delegated parent baseline argv; v1 launchers never see it. */
export const UPDATE_PACKAGE_ONLY_PROTOCOL_VERSION = 2;
export const UPDATE_WORKER_HOME_FLAG = "--update-worker-home";

/** Encode the parent's verified baseline for the delegated launcher. All four observed
 * kinds travel: an omitted baseline would let the child mint authority the parent never
 * held (parent same/foreign, child observing unknown), and --update-package-only alone
 * only restricts control without preserving which baseline authorized replacement.
 * null means the baseline cannot be encoded and delegation must be refused.
 * @param {UpdateServiceHomeAuthority | undefined} home @returns {string | null} */
export function updateWorkerHomeArgv(home) {
  if (home?.kind === "same" || home?.kind === "absent" || home?.kind === "unknown") return home.kind;
  if (home?.kind === "foreign" && typeof home.subject === "string" && /^[a-f0-9]{64}$/.test(home.subject))
    return `foreign:${home.subject}`;
  return null;
}

/** The baseline a v2 delegating parent pinned for this update. Absent flag → undefined:
 * the entry was self-launched (direct `ocx update`) and inspects itself. Malformed,
 * duplicated or `=`-joined shapes → { kind: "invalid" }, a synthetic baseline that fails
 * every check instead of falling back to a fresh inspection.
 * @param {readonly string[]} argv @returns {UpdateServiceHomeAuthority | undefined} */
export function parseUpdateWorkerHome(argv) {
  let at = -1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === UPDATE_WORKER_HOME_FLAG) {
      if (at >= 0) return { kind: "invalid" };
      at = i;
    } else if (argv[i].startsWith(`${UPDATE_WORKER_HOME_FLAG}=`)) return { kind: "invalid" };
  }
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === "same" || value === "absent" || value === "unknown") return { kind: value };
  const foreign = typeof value === "string" ? /^foreign:([a-f0-9]{64})$/.exec(value) : null;
  return foreign ? { kind: "foreign", subject: foreign[1] } : { kind: "invalid" };
}

/** Exact argv only: malformed variants must not enter the ordinary status collector.
 * @param {string[]} args */
export function isUpdateHomeProbe(args) {
  return args.length === 1 && args[0] === "__update-home-probe";
}

/** @param {unknown} value @param {{ requireLauncher?: boolean }} [options]
 * @returns {UpdateServiceHomeAuthority} */
export function parseUpdateHomeProbe(value, { requireLauncher = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unknown" };
  const record = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(record);
  if (keys.some(key => !["schemaVersion", "kind", "subject", "launcherProtocolVersion"].includes(key))
    || record.schemaVersion !== UPDATE_HOME_SCHEMA_VERSION
    || (requireLauncher && record.launcherProtocolVersion !== UPDATE_HOME_LAUNCHER_PROTOCOL)
    || (record.launcherProtocolVersion !== undefined && record.launcherProtocolVersion !== UPDATE_HOME_LAUNCHER_PROTOCOL)) return { kind: "unknown" };
  if (record.kind === "foreign") {
    return typeof record.subject === "string" && /^[a-f0-9]{64}$/.test(record.subject)
      ? { kind: "foreign", subject: record.subject } : { kind: "unknown" };
  }
  if (record.subject !== undefined) return { kind: "unknown" };
  return record.kind === "same" || record.kind === "absent" || record.kind === "unknown"
    ? { kind: record.kind } : { kind: "unknown" };
}

/** A foreign registration never manages this foreground runtime. A changed claim is not absence.
 * @param {() => UpdateServiceHomeAuthority} inspect @param {(message: string) => void} refuse
 * @param {boolean} [packageOnly] A parent's restriction can only remove runtime authority.
 * @param {UpdateServiceHomeAuthority} [delegatedBaseline] A v2 parent's verified baseline;
 * when present it replaces inspection so the child cannot launder a changed home. */
export function createUpdateServiceHomePolicy(inspect, refuse, packageOnly = false, delegatedBaseline) {
  const initial = delegatedBaseline ?? inspect();
  let current = initial;
  packageOnly ||= initial.kind === "unknown";
  const checkAuthority = (home) => {
    current = home;
    const allowed = initial.kind === "same" ? home.kind === "same" || home.kind === "absent"
      : initial.kind === "absent" ? home.kind === "absent"
      : initial.kind === "foreign" && home.kind === "foreign" && initial.subject !== undefined && initial.subject === home.subject;
    if (allowed) return true;
    refuse(updateServiceHomeRefusal(home)
      ?? "Automatic update restart refused: service registration authority changed. Check 'ocx service status' before restarting manually.");
    return false;
  };
  const policy = {
    initial,
    packageOnly,
    get serviceAllowed() { return !packageOnly && initial.kind === "same" && current.kind === "same"; },
    checkPackage(home = inspect()) {
      return initial.kind === "unknown" && home.kind === "unknown" || checkAuthority(home);
    },
    check(home = inspect()) {
      if (!packageOnly) return checkAuthority(home);
      refuse(updateServiceHomeRefusal({ kind: "unknown" }));
      return false;
    },
  };
  return { ...policy, get serviceAllowed() { return policy.serviceAllowed; }, authorizeMutation: createMutationAuthorizer(policy) };
}

/** Static persisted guidance: never echo recorded paths or a probe's error output.
 * @param {UpdateServiceHomeAuthority} authority @returns {string | null} */
export function updateServiceHomeRefusal(authority) {
  if (authority.kind === "same" || authority.kind === "absent") return null;
  return authority.kind === "foreign"
    ? "Automatic update restart refused: the installed service belongs to different directories. Run 'ocx service status' from the registered installation; no restart was authorized."
    : "Automatic update restart refused: service registration ownership could not be verified. Check 'ocx service status' and the recorded installation before restarting manually.";
}

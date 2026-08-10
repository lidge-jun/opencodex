/**
 * The service-home preflight for native-client teardown (WP2, audit r1 #5;
 * devlog 260803_integrations_toggle_all/012).
 *
 * `ocx stop` has honored `ServiceOwnershipError` since it started catching it
 * (src/cli/index.ts:464); nothing on the HTTP side ever did. A route that calls
 * `stripGrokConfig` directly would otherwise pull the fence out from under a
 * service running from another CODEX_HOME/OPENCODEX_HOME — the installed
 * service is still live and the shared state belongs to it.
 *
 * ENABLE is not gated by this: writing our own fence is not a shared teardown,
 * and `injectGrokConfig` already runs unguarded from `ocx start`/`ensure`.
 */
import {
  assertServiceEnvironmentMatchesInstall,
  isServiceOwnershipError,
} from "../../service";
import {
  currentServiceHomes,
  inspectServiceStateEvidence,
  serviceHomeMatches,
  type ServiceStateEvidence,
} from "../../service";
import {
  inspectServiceManagerInstallation,
  type ProbeDeps,
  type ServiceManagerClaim,
} from "../../service-manager-probe";

export type NativeTeardownOwnership = { ok: true } | { ok: false; message: string };

export function assertNativeTeardownOwned(): NativeTeardownOwnership {
  try {
    assertServiceEnvironmentMatchesInstall();
    return { ok: true };
  } catch (error) {
    if (isServiceOwnershipError(error)) {
      // The message names both the recorded and the current home — that is the
      // refusal text, verbatim, because the user has to act on it.
      return { ok: false, message: error.message };
    }
    // Unrelated failure (corrupt state file, IO): mirror
    // `serviceEnvironmentOwnedHere` and fail open rather than wedging the route
    // behind a check whose own input is broken.
    return { ok: true };
  }
}

/**
 * Tri-state ownership for UNATTENDED writes.
 *
 * Deliberately not `assertNativeTeardownOwned`. That one fails OPEN — a corrupt
 * state file yields `{ok:true}` — which is right for a teardown route a human
 * just invoked, and catastrophic as an authority for automatic convergence:
 * "could not read" would become "belongs to me".
 *
 * `owned` here means NO PERSISTENT SERVICE CLAIM WAS OBSERVED. It does not mean
 * this process is the only writer. Two foreground `ocx start` processes on one
 * home both read `owned`, and correctly so, because neither installs a service —
 * keeping them apart is the write lock's job, not this function's.
 */
export type NativeCodexOwnership = "owned" | "foreign" | "unknown";

export interface OwnershipInspection {
  readonly ownership: NativeCodexOwnership;
  /** Why, in the words a refusal message can use. */
  readonly reason: string;
}

function claimNamesDifferentHome(
  claim: ServiceManagerClaim,
  current: { codexHome: string; opencodexHome: string },
): boolean {
  // A definition that OMITS a home is not a definition that disagrees about it:
  // an install run without CODEX_HOME set writes no such key at all.
  if (claim.homes.codexHome !== null && !serviceHomeMatches(claim.homes.codexHome, current.codexHome)) return true;
  if (claim.homes.opencodexHome !== null && !serviceHomeMatches(claim.homes.opencodexHome, current.opencodexHome)) return true;
  return false;
}

/**
 * Map a service-manager claim backend to the `ServiceInstallState.backend`
 * value it corresponds to. `scheduler` (Task Scheduler) and `winsw` (native)
 * are the two Windows manager backends; launchd/systemd claims have no Windows
 * backend and can never mismatch a v2 state file.
 */
function claimBackendToStateBackend(backend: ServiceManagerClaim["backend"]): "scheduler" | "native" | null {
  if (backend === "scheduler") return "scheduler";
  if (backend === "winsw") return "native";
  return null;
}

/** True when the recorded state backend disagrees with the manager claim. Legacy v1 means scheduler. */
function claimBackendMismatchesState(claim: ServiceManagerClaim, state: { backend?: "scheduler" | "native" }): boolean {
  const expected = claimBackendToStateBackend(claim.backend);
  if (expected === null) return false;
  return (state.backend ?? "scheduler") !== expected;
}

export interface OwnershipDeps extends ProbeDeps {
  /**
   * Which state paths to consult. Injectable because the default set includes
   * the DEFAULT home mirror, resolved from `homedir()` — which no test sandbox
   * moves. Without this a fixture reads the developer's real installation and
   * calls their own machine foreign.
   */
  readonly statePaths?: readonly string[];
  readonly currentHomes?: { codexHome: string; opencodexHome: string };
}

export function inspectNativeCodexOwnership(deps: OwnershipDeps = {}): OwnershipInspection {
  const current = deps.currentHomes ?? currentServiceHomes();
  const evidence = deps.statePaths
    ? inspectServiceStateEvidence(deps.statePaths)
    : inspectServiceStateEvidence();

  const unreadable = evidence.find((e): e is Extract<ServiceStateEvidence, { kind: "unreadable" }> => e.kind === "unreadable");
  if (unreadable) {
    return { ownership: "unknown", reason: `service state at ${unreadable.path} could not be read (${unreadable.reason})` };
  }
  const invalid = evidence.find(e => e.kind === "invalid");
  if (invalid) {
    return { ownership: "unknown", reason: `service state at ${invalid.path} is malformed` };
  }

  const valid = evidence.filter((e): e is Extract<ServiceStateEvidence, { kind: "valid" }> => e.kind === "valid");
  // Mirrors that disagree with each other are not a majority vote.
  for (const one of valid) {
    for (const other of valid) {
      if (!serviceHomeMatches(one.state.codexHome, other.state.codexHome)
        || !serviceHomeMatches(one.state.opencodexHome, other.state.opencodexHome)) {
        return { ownership: "unknown", reason: "two service state files disagree about which homes are installed" };
      }
    }
  }

  const foreign = valid.find(e =>
    !serviceHomeMatches(e.state.codexHome, current.codexHome)
    || !serviceHomeMatches(e.state.opencodexHome, current.opencodexHome));
  if (foreign) {
    return {
      ownership: "foreign",
      reason: `a service is installed for CODEX_HOME=${foreign.state.codexHome} / OPENCODEX_HOME=${foreign.state.opencodexHome}`,
    };
  }

  // The manager assets live under the effective OPENCODEX_HOME. Production
  // callers do not inject ProbeDeps.configDir, so derive it from the same
  // current-home snapshot used for ownership comparison rather than silently
  // falling back to <homedir>/.opencodex.
  const manager = inspectServiceManagerInstallation({
    ...deps,
    configDir: deps.configDir ?? current.opencodexHome,
  });
  if (manager.kind === "unknown") {
    return { ownership: "unknown", reason: manager.reason };
  }
  if (manager.kind === "conflict") {
    return { ownership: "unknown", reason: "more than one service manager holds a registration for this proxy" };
  }
  if (manager.kind === "present") {
    const disagreeing = manager.claims.find(claim => claimNamesDifferentHome(claim, current));
    if (disagreeing) {
      /*
       * The state file says this home and the definition says another. An
       * interrupted reinstall looks exactly like this — installation writes the
       * definition BEFORE the state file — and picking a winner unattended would
       * be guessing which half of a half-finished operation to believe.
       */
      return {
        ownership: "unknown",
        reason: `${disagreeing.backend} is installed from ${disagreeing.definitionPath}, which names different homes than the recorded service state`,
      };
    }
    // A manager backend that disagrees with the recorded state (e.g. state says
    // native/WinSW but a scheduler task is found) is an interrupted backend
    // switch: it does not prove which manager owns the installation. v1 state
    // predates the field and is scheduler by contract.
    const stateBackendMismatch = valid.find(state => manager.claims.some(claim => claimBackendMismatchesState(claim, state.state)));
    if (stateBackendMismatch) {
      return {
        ownership: "unknown",
        reason: `the service state records backend ${stateBackendMismatch.state.backend ?? "scheduler"} but ${manager.claims[0]?.backend ?? "a service manager"} is installed`,
      };
    }
    // Definition agrees. Valid state agreeing with it is ownership; no state at
    // all beside an installed definition is not, because the definition is the
    // claim and nothing here recorded making it.
    if (valid.length === 0) {
      return {
        ownership: "unknown",
        reason: `${manager.claims[0]?.backend ?? "a service manager"} holds a registration that no service state file accounts for`,
      };
    }
    return { ownership: "owned", reason: "the installed service names these homes" };
  }

  // manager.kind === "absent"
  return valid.length === 0
    ? { ownership: "owned", reason: "no service state and no service manager claim" }
    : { ownership: "owned", reason: "the recorded service state names these homes" };
}
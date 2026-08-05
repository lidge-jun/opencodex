/**
 * What the service manager says about this machine, read-only and fail-closed.
 *
 * The question this answers is NOT "is a job loaded". Installation writes the
 * definition BEFORE the state file (`service.ts` install paths) and embeds
 * `CODEX_HOME`/`OPENCODEX_HOME` inside it, so an interrupted reinstall leaves a
 * valid state file for one home beside an installed definition for another. A
 * probe that only asked about registration would call that owned. On macOS it is
 * worse: a logged-out user has the plist on disk with no GUI domain at all, so
 * registration reports nothing while a foreign definition sits right there.
 *
 * So the probe reads the DEFINITION, parses the homes out of it, and reports
 * what it saw. Comparing those homes is the caller's job — a probe that returned
 * a verdict would be deciding ownership from half the evidence.
 *
 * Every command here is read-only and bounded. The user's proxy runs under a
 * service manager while this executes; a probe that could start, stop or reload
 * anything is not a probe. An unbounded one is not much better, since a wedged
 * manager would hold the event loop.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Short: this runs inside admission, and a slow answer is the same as none. */
export const SERVICE_PROBE_TIMEOUT_MS = 2_000;

export type ServiceManagerBackend = "launchd" | "systemd" | "scheduler" | "winsw";

export interface ServiceManagerClaim {
  readonly backend: ServiceManagerBackend;
  readonly definitionPath: string;
  /**
   * The homes the definition names. `null` means the definition deliberately
   * omits that key, which is different from naming a different one: an install
   * that ran without `CODEX_HOME` set writes no such key at all.
   */
  readonly homes: {
    readonly codexHome: string | null;
    readonly opencodexHome: string | null;
  };
  readonly registration: "present" | "absent";
}

export type ServiceManagerInstallation =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly claims: readonly ServiceManagerClaim[] }
  | { readonly kind: "conflict"; readonly claims: readonly ServiceManagerClaim[] }
  | { readonly kind: "unknown"; readonly reason: string };

/** Injected so a test can observe the EXACT argv production emits. */
export interface ProbeRunner {
  (file: string, args: readonly string[]): {
    status: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    spawnFailed: boolean;
  };
}

export const defaultProbeRunner: ProbeRunner = (file, args) => {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: SERVICE_PROBE_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    // `signal` is SIGTERM when the timeout fired; a spawn failure sets `error`.
    timedOut: result.signal !== null && result.error === undefined,
    spawnFailed: result.error !== undefined,
  };
};

export interface ProbeDeps {
  readonly run?: ProbeRunner;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly home?: string;
}

const LABEL = "com.opencodex.proxy";
const TASK = "opencodex-proxy";

/**
 * `launchctl print` exits 113 for a service that is not there and 112 when the
 * domain itself cannot be reached — measured against nonexistent targets rather
 * than assumed. Only 113 is an answer; everything else is a failure to ask.
 */
const LAUNCHCTL_NO_SUCH_SERVICE = 113;
/**
 * 112 is an answer about the DOMAIN, not the label.
 *
 * Measured on macOS 27.0: querying a domain with no service name at all still
 * returns it, and a domain that does not exist cannot be running one of our
 * jobs. Treating it as "could not ask" would refuse every write on a fresh
 * headless Mac — no GUI domain, and no installation either.
 */
const LAUNCHCTL_NO_SUCH_DOMAIN = 112;

/**
 * Residue on disk, distinguished from a path that could not be read.
 *
 * `existsSync` answers "no" for a dangling symlink and for a path whose parent
 * denies traversal. Both are residue, not absence — only ENOENT is absence.
 */
function artifactPresence(path: string): "present" | "absent" | "unreadable" {
  try {
    lstatSync(path);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable";
  }
}

function unknown(reason: string): ServiceManagerInstallation {
  return { kind: "unknown", reason };
}

/** Pull `<key>NAME</key><string>VALUE</string>` out of a plist body. */
function plistEnvValue(body: string, key: string): string | null {
  const match = body.match(
    new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`),
  );
  return match ? match[1] : null;
}

/** Pull `Environment="NAME=VALUE"` (quoted or bare) out of a systemd unit. */
function unitEnvValue(body: string, key: string): string | null {
  for (const line of body.split("\n")) {
    const match = line.match(new RegExp(`^\\s*Environment=\\s*"?${key}=([^"\\n]*)"?\\s*$`));
    if (match) return match[1];
  }
  return null;
}

function inspectLaunchd(deps: Required<Pick<ProbeDeps, "run" | "uid" | "home">>): ServiceManagerInstallation {
  const definitionPath = join(deps.home, "Library", "LaunchAgents", `${LABEL}.plist`);

  /*
   * BOTH domains, because they are independent and hold separate service sets.
   * Measured on macOS 27.0: the shipped agent answers 0 under `gui/<uid>` and
   * 113 under `user/<uid>`. Asking only one leaves the other free to hold a job
   * this probe would then call absent.
   */
  let registration: "present" | "absent" = "absent";
  let unreachableDomains = 0;
  for (const domain of [`gui/${deps.uid}`, `user/${deps.uid}`]) {
    const printed = deps.run("/bin/launchctl", ["print", `${domain}/${LABEL}`]);
    if (printed.spawnFailed || printed.timedOut) {
      return unknown(`launchctl could not be asked: ${printed.timedOut ? "timed out" : printed.stderr.trim()}`);
    }
    if (printed.status === 0) { registration = "present"; break; }
    if (printed.status === LAUNCHCTL_NO_SUCH_SERVICE) continue;
    if (printed.status === LAUNCHCTL_NO_SUCH_DOMAIN) { unreachableDomains += 1; continue; }
    return unknown(`launchctl print exited ${String(printed.status)}: ${printed.stderr.trim()}`);
  }

  const definition = artifactPresence(definitionPath);
  if (definition === "absent") {
    // No file. A registration without one means launchd holds a definition whose
    // file is gone — real, and not something to resolve unattended.
    if (registration === "present") {
      return unknown("launchd has a job loaded but its plist is missing");
    }
    /*
     * Nothing staged, and every domain either answered "no such service" or does
     * not exist. 112 is an answer ABOUT THE DOMAIN and is label-independent —
     * querying a domain with no service name at all returns it — so an
     * unreachable domain cannot be hiding a job of ours. Calling this `unknown`
     * instead would refuse every write on a fresh headless Mac, which has no
     * GUI domain and no installation either.
     */
    void unreachableDomains;
    return { kind: "absent" };
  }

  let body: string;
  try {
    body = readFileSync(definitionPath, "utf-8");
  } catch (error) {
    // Present-but-unreadable cannot supply homes, and `present` without homes
    // would compare equal to nothing and read as agreement.
    return unknown(`the launchd plist exists but could not be read: ${String(error)}`);
  }

  return {
    kind: "present",
    claims: [{
      backend: "launchd",
      definitionPath,
      homes: {
        codexHome: plistEnvValue(body, "CODEX_HOME"),
        opencodexHome: plistEnvValue(body, "OPENCODEX_HOME"),
      },
      registration,
    }],
  };
}

function systemdProperty(out: string, key: string): string | null {
  for (const line of out.split("\n")) {
    const match = line.match(new RegExp(`^${key}=(.*)$`));
    if (match) return match[1].trim();
  }
  return null;
}

function inspectSystemd(deps: Required<Pick<ProbeDeps, "run" | "home">>): ServiceManagerInstallation {
  const definitionPath = join(deps.home, ".config", "systemd", "user", `${TASK}.service`);

  /*
   * All four properties in one call. LoadState alone is not enough — it is
   * orthogonal to ActiveState — and neither says whether the LOADED bytes match
   * the file. NeedDaemonReload is that signal, and this repository already
   * documents it as the systemd analogue of launchd's stale plist.
   */
  const shown = deps.run("systemctl", [
    "--user", "show", TASK,
    "-p", "LoadState", "-p", "ActiveState", "-p", "FragmentPath", "-p", "NeedDaemonReload",
  ]);
  if (shown.spawnFailed || shown.timedOut) {
    return unknown(`systemctl could not be asked: ${shown.timedOut ? "timed out" : shown.stderr.trim()}`);
  }
  if (shown.status !== 0) {
    // A missing unit still exits ZERO and says not-found; a non-zero status means
    // the question never reached the bus.
    return unknown(`systemctl show exited ${String(shown.status)}: ${shown.stderr.trim()}`);
  }

  const loadState = systemdProperty(shown.stdout, "LoadState");
  const activeState = systemdProperty(shown.stdout, "ActiveState");
  const fragmentPath = systemdProperty(shown.stdout, "FragmentPath");
  const needReload = systemdProperty(shown.stdout, "NeedDaemonReload");
  if (loadState === null || activeState === null || needReload === null) {
    return unknown("systemctl show did not report the properties it was asked for");
  }
  if (needReload === "yes") {
    return unknown("systemd has a stale definition loaded; it needs daemon-reload");
  }

  const registration: "present" | "absent" =
    loadState === "not-found" && activeState === "inactive" && !fragmentPath ? "absent" : "present";

  if (artifactPresence(definitionPath) === "absent") {
    return registration === "absent"
      ? { kind: "absent" }
      : unknown("systemd knows this unit but its file is missing");
  }

  let body: string;
  try {
    body = readFileSync(definitionPath, "utf-8");
  } catch (error) {
    return unknown(`the systemd unit exists but could not be read: ${String(error)}`);
  }

  return {
    kind: "present",
    claims: [{
      backend: "systemd",
      definitionPath,
      homes: {
        codexHome: unitEnvValue(body, "CODEX_HOME"),
        opencodexHome: unitEnvValue(body, "OPENCODEX_HOME"),
      },
      registration,
    }],
  };
}

/**
 * Windows is deferred to its own phase and reports `unknown` until then.
 *
 * Not an oversight: the definition there is a chain, not a file. The task XML
 * names only the launcher, and the homes live in the batch wrapper it eventually
 * runs — a probe that parsed the XML and stopped would find no homes and read
 * that as agreement. Reporting `unknown` refuses unattended convergence on
 * Windows, which is the safe direction while the chain walk is unwritten.
 */
function inspectWindows(): ServiceManagerInstallation {
  return unknown("the Windows definition chain is not inspected yet");
}

export function inspectServiceManagerInstallation(deps: ProbeDeps = {}): ServiceManagerInstallation {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultProbeRunner;
  const home = deps.home ?? homedir();
  if (platform === "darwin") return inspectLaunchd({ run, uid: deps.uid ?? process.getuid?.() ?? 0, home });
  if (platform === "linux") return inspectSystemd({ run, home });
  if (platform === "win32") return inspectWindows();
  return unknown(`no service manager probe for platform ${platform}`);
}

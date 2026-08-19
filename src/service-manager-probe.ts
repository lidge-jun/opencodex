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
import { join, win32 as win32Path } from "node:path";
import {
  resolveTrustedWindowsSchtasksExe,
  resolveTrustedWindowsSystemDirectory,
} from "./lib/windows-elevation";
import { decodeWindowsTextBytes } from "./lib/windows-text";
import { WINSW_SERVICE_ID } from "./lib/winsw";

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

/**
 * Windows probe runner: preserves schtasks stdout/stderr as raw bytes so the
 * UTF-16LE task XML is not corrupted by a UTF-8 decode.
 */
export type RawProbeRunner = (file: string, args: readonly string[]) => {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  spawnFailed: boolean;
};

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

export const defaultRawProbeRunner: RawProbeRunner = (file, args) => {
  const result = spawnSync(file, [...args], {
    encoding: "buffer",
    windowsHide: true,
    timeout: SERVICE_PROBE_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
    timedOut: result.signal !== null && result.error === undefined,
    spawnFailed: result.error !== undefined,
  };
};

export interface ProbeDeps {
  readonly run?: ProbeRunner;
  /** Raw-buffer runner for bounded Windows service-manager queries. */
  readonly runRaw?: RawProbeRunner;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly home?: string;
  /** Effective OpenCodex config dir (OPENCODEX_HOME). Overrides `<home>/.opencodex`. */
  readonly configDir?: string;
  /** Test seam for WinSW SCM status. Production uses bounded trusted `sc.exe query`. */
  readonly winswStatus?: () => "started" | "stopped" | "nonexistent" | "unknown";
  /** Test seam for redirected Windows legacy-codepage output. */
  readonly windowsLocale?: string;
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

/**
 * Did `systemctl --user` fail because the session bus could not be reached at all?
 *
 * These are the shapes reported on #2114 and #1939. The distinction that matters is
 * "the question never left the machine" versus "systemd answered and said no" — only
 * the former licenses reading the disk instead.
 *
 * **Locale caveat, stated rather than hidden:** systemd localizes these strings, so a
 * non-English host will not match and keeps the old `unknown`. That is the safe
 * direction — it fences rather than admits — but it does mean the fix does not reach
 * every affected user. Forcing `LC_ALL=C` on the probe would remove the caveat and is
 * the obvious follow-up; it is not done here because it changes every systemctl call
 * this module makes, not just this branch.
 */
function busUnreachable(stderr: string): boolean {
  const err = stderr.trim();
  return err.includes("Failed to connect to bus")
    || err.includes("Failed to connect to user scope bus")
    || err.includes("Failed to get D-Bus connection")
    || err.includes("DBUS_SESSION_BUS_ADDRESS")
    || err.includes("System has not been booted with systemd");
}

/**
 * Ownership from the unit file alone, for when the bus cannot answer (#2114).
 *
 * A unit file is proof of installation that does not require a running bus, and the homes
 * it names are what ownership is actually decided on. What the disk cannot tell us is
 * whether systemd has the unit LOADED, so this reports `registration: "absent"` — the
 * honest reading of "no running manager has it" — rather than inventing a live state.
 *
 * A foreign home therefore still blocks, which is the whole reason this consults the disk
 * instead of widening the exit code.
 */
function systemdUserUnitSearchPaths(home: string): string[] {
  // systemd's user search path is not one directory. Checking only the canonical one and
  // calling the rest absent is a fail-open: with the bus down a foreign unit in any other
  // search dir is invisible, and "no answer" would be read as "no owner".
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim();
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  const dirs = [
    xdgConfig ? join(xdgConfig, "systemd", "user") : join(home, ".config", "systemd", "user"),
    join(home, ".config", "systemd", "user"),
    xdgData ? join(xdgData, "systemd", "user") : join(home, ".local", "share", "systemd", "user"),
    join(home, ".local", "share", "systemd", "user"),
  ];
  return [...new Set(dirs)].map(dir => join(dir, `${TASK}.service`));
}

function inspectSystemdOffline(home: string): ServiceManagerInstallation {
  const candidates = systemdUserUnitSearchPaths(home);
  const found = candidates.filter(path => artifactPresence(path) === "present");
  if (candidates.some(path => artifactPresence(path) === "unreadable")) {
    return unknown("the session bus is unreachable and a systemd unit could not be read");
  }
  if (found.length === 0) return { kind: "absent" };
  if (found.length > 1) {
    return unknown("the session bus is unreachable and more than one systemd unit file claims this proxy");
  }
  const definitionPath = found[0]!;
  let body: string;
  try {
    body = readFileSync(definitionPath, "utf-8");
  } catch (error) {
    return unknown(`the session bus is unreachable and the systemd unit could not be read: ${String(error)}`);
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
      registration: "absent",
    }],
  };
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
  if (shown.spawnFailed) return { kind: "absent" };
  if (shown.timedOut) return unknown("systemctl could not be asked: timed out");
  if (shown.status !== 0) {
    // A missing unit still exits ZERO and says not-found; a non-zero status means
    // the question never reached the bus.
    //
    // That is evidence about the BUS, not evidence that a foreign service owns this home
    // (#2114). Calling it `unknown` fences native-main for the whole process, so a laptop
    // with no session bus answers every native request with a 503 until `ocx restart`.
    //
    // Widening on the exit code alone would fail open, because with the bus down systemctl
    // cannot see a foreign unit either. So ask the disk, which needs no bus, and fall back
    // to `unknown` for every other non-zero exit.
    if (busUnreachable(shown.stderr)) return inspectSystemdOffline(deps.home);
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
 * Windows: walk the scheduled-task definition chain and report the homes it names.
 *
 * The chain is not one file: the task XML names only the launcher, the launcher
 * (VBS) names only the batch wrapper, and the homes live in the wrapper's
 * `set "CODEX_HOME=..."` / `set "OPENCODEX_HOME=..."` lines. Parsing the XML
 * and stopping would find no homes and read that as agreement, so the walk goes
 * all the way to the wrapper.
 *
 * A `set` line is OMITTED by `buildWindowsServiceScript` when the value was
 * unset at install time (windowsBatchSet returns null for empty values), so a
 * missing home stays `null` — the same contract the launchd/systemd probes use —
 * and a definition that names no homes cannot be mistaken for agreement.
 *
 * Registration is answered by bounded `schtasks` queries so a definition staged
 * on disk but never registered is still visible (the interrupted-install case).
 * Every failure to ask is `unknown`, never absence.
 */
function windowsTaskName(): string {
  return "opencodex-proxy";
}

function windowsConfigDirPath(deps: { home: string; configDir?: string }): string {
  if (deps.configDir) return deps.configDir;
  return join(deps.home, ".opencodex");
}

/** Decode the XML entities emitted by the service-definition writers. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Pull the launcher path out of the task XML `<Arguments>` element. */
function windowsTaskArguments(xml: string): string | null {
  const match = /<Arguments[^>]*>\s*([^<]*?)\s*<\/Arguments>/i.exec(xml);
  return match ? decodeXmlEntities(match[1]!.trim()) : null;
}

/**
 * Pull the wrapper path out of a VBS `shell.Run` line.
 *
 * `buildWindowsLauncherVbs` escapes a `"` inside a VBS string literal by
 * doubling it, so a wrapper `C:\...\opencodex-service.cmd` is emitted as
 * `shell.Run """C:\...\opencodex-service.cmd""", 0, True`.
 */
function vbsWrappedCommand(body: string): string | null {
  const match = /\.Run\s+"""([^"]*)"""/.exec(body);
  if (match) {
    const unwrapped = match[1]!.trim();
    if (unwrapped.length > 0) return unwrapped;
  }
  const plain = /\.Run\s+"([^"]+)"/.exec(body);
  return plain ? plain[1]!.trim() : null;
}

/** Pull one `set "NAME=value"` out of a batch wrapper. */
function batchSetValue(body: string, name: string): string | null {
  const match = new RegExp(`^\\s*set\\s+"${name}=([^"]*)"\\s*$`, "im").exec(body);
  return match ? match[1]!.trim() : null;
}

/** Resolve generated batch env indirection before comparing homes. */
function decodeBatchPathValue(
  value: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const escapedPercent = "\u0000";
  const tokens: Record<string, string | undefined> = {
    USERPROFILE: env.USERPROFILE,
    APPDATA: env.APPDATA,
    LOCALAPPDATA: env.LOCALAPPDATA,
    SYSTEMROOT: env.SystemRoot,
  };
  return value
    .replace(/%%/g, escapedPercent)
    .replace(/%([A-Za-z][A-Za-z0-9_]*)%/g, (whole, name: string) => {
      const resolved = tokens[name.toUpperCase()];
      return resolved === undefined ? whole : resolved;
    })
    .replaceAll(escapedPercent, "%");
}

/** Validate the generated wrapper before interpreting omitted optional homes. */
function wrapperLooksGenerated(body: string): boolean {
  return /:loop\s*[\s\S]*^"%OCX_BUN%" "%OCX_CLI%" start\b[^\r\n]*$/im.test(body);
}

function normalizeWindowsPath(value: string): string {
  return win32Path.normalize(value.replace(/\//g, "\\")).replace(/[\\]+$/, "").toLowerCase();
}

/** True only when a definition-provided path remains inside the effective OPENCODEX_HOME. */
function windowsPathInsideConfigDir(candidate: string, configDir: string): boolean {
  const root = normalizeWindowsPath(configDir);
  const path = normalizeWindowsPath(candidate);
  const relative = win32Path.relative(root, path);
  return relative === "" || (relative !== ".." && !relative.startsWith("..\\") && !win32Path.isAbsolute(relative));
}

/** Parse the first CSV field emitted by schtasks `/fo CSV`. */
function csvFirstField(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('"')) return (trimmed.split(",", 1)[0] ?? "").trim();
  let value = "";
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (ch !== '"') {
      value += ch;
      continue;
    }
    if (trimmed[i + 1] === '"') {
      value += '"';
      i += 1;
      continue;
    }
    break;
  }
  return value;
}

function windowsTaskListContains(body: string, taskName: string): boolean {
  const target = taskName.toLowerCase();
  return body.split(/\r?\n/).some(line => {
    const field = csvFirstField(line).replace(/\//g, "\\").replace(/^\\+/, "");
    return field.toLowerCase() === target;
  });
}

/** English hosts provide a decisive fast path; other locales fall back to a full listing. */
const SCHTASKS_TASK_NOT_FOUND_EN = /cannot find the file specified/i;

/**
 * Registration state of the scheduled task.
 *
 * The `/xml` query gives the authoritative registered definition. A nonzero
 * result is locale-dependent. English's task-not-found message is decisive; all
 * other nonzero responses use a bounded full listing as the locale-neutral
 * fallback, and only a successful list without our task proves absence.
 */
function probeWindowsTaskRegistration(
  deps: Required<Pick<ProbeDeps, "runRaw">> & Pick<ProbeDeps, "windowsLocale">,
): {
  registered: "present" | "absent" | "unknown";
  registeredXml: string;
} {
  let schtasks: string;
  try {
    schtasks = resolveTrustedWindowsSchtasksExe();
  } catch {
    return { registered: "unknown", registeredXml: "" };
  }

  const queried = deps.runRaw(schtasks, ["/query", "/tn", windowsTaskName(), "/xml"]);
  if (queried.spawnFailed || queried.timedOut) return { registered: "unknown", registeredXml: "" };
  if (queried.status === 0) {
    const registeredXml = decodeWindowsTextBytes(queried.stdout, { locale: deps.windowsLocale })
      || decodeWindowsTextBytes(queried.stderr, { locale: deps.windowsLocale });
    return registeredXml
      ? { registered: "present", registeredXml }
      : { registered: "unknown", registeredXml: "" };
  }

  const queryText = `${decodeWindowsTextBytes(queried.stdout, { locale: deps.windowsLocale })}\n${decodeWindowsTextBytes(queried.stderr, { locale: deps.windowsLocale })}`;
  if (queried.status !== null && SCHTASKS_TASK_NOT_FOUND_EN.test(queryText)) {
    return { registered: "absent", registeredXml: "" };
  }

  const listed = deps.runRaw(schtasks, ["/query", "/fo", "CSV", "/nh"]);
  if (listed.spawnFailed || listed.timedOut || listed.status !== 0) {
    return { registered: "unknown", registeredXml: "" };
  }
  const listing = decodeWindowsTextBytes(listed.stdout, { locale: deps.windowsLocale })
    || decodeWindowsTextBytes(listed.stderr, { locale: deps.windowsLocale });
  return windowsTaskListContains(listing, windowsTaskName())
    ? { registered: "unknown", registeredXml: "" }
    : { registered: "absent", registeredXml: "" };
}

type WinswRegistration = "present" | "absent" | "unknown";

/** Query WinSW registration through trusted System32 sc.exe; never execute the user-writable WinSW binary. */
function probeWinswRegistration(
  deps: Required<Pick<ProbeDeps, "runRaw">> & Pick<ProbeDeps, "winswStatus">,
): WinswRegistration {
  if (deps.winswStatus) {
    const injected = deps.winswStatus();
    if (injected === "started" || injected === "stopped") return "present";
    if (injected === "nonexistent") return "absent";
    return "unknown";
  }

  let sc: string;
  try {
    sc = join(resolveTrustedWindowsSystemDirectory(), "sc.exe");
    if (artifactPresence(sc) !== "present") return "unknown";
  } catch {
    return "unknown";
  }

  const queried = deps.runRaw(sc, ["query", WINSW_SERVICE_ID]);
  if (queried.spawnFailed || queried.timedOut) return "unknown";
  if (queried.status === 0) return "present";

  // ERROR_SERVICE_DOES_NOT_EXIST (1060) is locale-invariant. Search raw byte
  // text so localized OEM output cannot affect the numeric classification.
  const text = `${queried.stdout.toString("latin1")}\n${queried.stderr.toString("latin1")}`;
  return /\b1060\b/.test(text) ? "absent" : "unknown";
}

function inspectWindows(
  deps: Required<Pick<ProbeDeps, "runRaw" | "home">>
    & Pick<ProbeDeps, "configDir" | "winswStatus" | "windowsLocale">,
): ServiceManagerInstallation {
  const configDir = windowsConfigDirPath(deps);
  const taskXmlPath = join(configDir, "opencodex-service-task.xml");
  const task = artifactPresence(taskXmlPath);
  const winsw = walkWinswChain(deps);
  const winswInstalled = winsw.kind === "present" && winsw.claims[0].registration === "present";
  const winswStaged = winsw.kind === "present" && winsw.claims[0].registration === "absent";

  let xml = "";
  if (task !== "absent") {
    try {
      xml = decodeWindowsTextBytes(readFileSync(taskXmlPath), { locale: deps.windowsLocale });
    } catch (error) {
      return unknown(`the scheduled-task XML exists but could not be read: ${String(error)}`);
    }
  }

  const registration = probeWindowsTaskRegistration(deps);
  if (registration.registered === "unknown") {
    return unknown("Task Scheduler could not be asked whether opencodex-proxy is registered");
  }
  const schedulerRegistered = registration.registered === "present";

  // Two live registrations are a conflict even if the staging copy of the task
  // XML disappeared. The authoritative `/query /xml` definition is sufficient
  // to walk the scheduler chain without inventing homes.
  if (winswInstalled && schedulerRegistered) {
    if (!registration.registeredXml.trim()) {
      return unknown("Task Scheduler is registered but its definition XML could not be read");
    }
    const registeredWalk = walkWindowsChain(deps, registration.registeredXml, taskXmlPath);
    if (registeredWalk.kind !== "present") return registeredWalk;
    return {
      kind: "conflict",
      claims: [
        winsw.claims[0],
        { ...registeredWalk.claims[0], registration: "present" },
      ],
    };
  }

  if (winswInstalled) {
    // A staged scheduler definition beside a registered WinSW service is an
    // interrupted backend switch, not proof that WinSW alone owns the machine.
    if (task !== "absent") {
      return unknown("a scheduled-task definition is staged while the native WinSW service is registered");
    }
    return winsw;
  }

  if (winsw.kind === "unknown") return winsw;

  // Staged-but-unregistered WinSW remains evidence. If Scheduler is also live
  // or staged, neither half-finished backend switch can be chosen unattended.
  if (winswStaged && (schedulerRegistered || task !== "absent")) {
    return unknown("native WinSW and Task Scheduler definitions overlap during an incomplete backend switch");
  }
  if (winswStaged && task === "absent" && registration.registered === "absent") {
    return winsw;
  }

  if (task === "absent") {
    return schedulerRegistered
      ? unknown("Task Scheduler holds opencodex-proxy but its task XML is missing")
      : { kind: "absent" };
  }

  const staged = walkWindowsChain(deps, xml, taskXmlPath);
  if (staged.kind !== "present") return staged;
  const stagedClaim = staged.claims[0];

  if (schedulerRegistered) {
    if (!registration.registeredXml.trim()) {
      return unknown("Task Scheduler is registered but its definition XML could not be read");
    }
    const registeredWalk = walkWindowsChain(deps, registration.registeredXml, taskXmlPath);
    if (registeredWalk.kind !== "present") return registeredWalk;
    const registeredClaim = registeredWalk.claims[0];
    if (!homesEqual(registeredClaim.homes, stagedClaim.homes)) {
      return unknown("the registered scheduled task names different homes than the staged task definition");
    }
  }

  return {
    kind: "present",
    claims: [{
      ...stagedClaim,
      registration: schedulerRegistered ? "present" : "absent",
    }],
  };
}

/** Compare two home pairs with Windows path normalization (case, slashes, trailing separators). */
function homesEqual(
  a: { codexHome: string | null; opencodexHome: string | null },
  b: { codexHome: string | null; opencodexHome: string | null },
): boolean {
  const norm = (v: string | null): string | null => {
    if (v === null) return null;
    return v.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  };
  return norm(a.codexHome) === norm(b.codexHome) && norm(a.opencodexHome) === norm(b.opencodexHome);
}

/**
 * Walk one scheduled-task definition (staged or registered XML) down to the
 * generated batch wrapper and extract the homes it names. Definition-provided
 * paths are followed only inside the effective OPENCODEX_HOME, preventing a
 * foreign task from turning this ownership probe into an arbitrary local/UNC
 * file read while preserving interrupted-reinstall diagnostics within the
 * generated service-asset directory.
 */
function walkWindowsChain(
  deps: Required<Pick<ProbeDeps, "home">> & Pick<ProbeDeps, "configDir" | "windowsLocale">,
  xml: string,
  definitionPath: string,
): ServiceManagerInstallation {
  const configDir = windowsConfigDirPath(deps);

  const launcherArg = windowsTaskArguments(xml);
  if (!launcherArg) {
    return unknown("the scheduled-task XML names no launcher to run");
  }
  const launcherPath = /"([^"]+)"/.exec(launcherArg)?.[1];
  if (!launcherPath) {
    return unknown("the scheduled-task XML launcher argument is not a quoted path");
  }
  if (!windowsPathInsideConfigDir(launcherPath, configDir)) {
    return unknown(`the scheduled-task XML names ${launcherPath}, outside the expected launcher directory ${configDir}`);
  }

  const launcher = artifactPresence(launcherPath);
  if (launcher === "absent") {
    return unknown(`the scheduled-task launcher is missing: ${launcherPath}`);
  }
  let launcherBody: string;
  try {
    launcherBody = decodeWindowsTextBytes(readFileSync(launcherPath), { locale: deps.windowsLocale });
  } catch (error) {
    return unknown(`the scheduled-task launcher could not be read: ${String(error)}`);
  }

  const wrapperPath = vbsWrappedCommand(launcherBody);
  if (!wrapperPath) {
    return unknown(`the launcher ${launcherPath} names no wrapper to run`);
  }
  if (!windowsPathInsideConfigDir(wrapperPath, configDir)) {
    return unknown(`the scheduled-task launcher names ${wrapperPath}, outside the expected wrapper directory ${configDir}`);
  }

  const wrapper = artifactPresence(wrapperPath);
  if (wrapper === "absent") {
    return unknown(`the launcher wrapper is missing: ${wrapperPath}`);
  }
  let wrapperBody: string;
  try {
    wrapperBody = decodeWindowsTextBytes(readFileSync(wrapperPath), { locale: deps.windowsLocale });
  } catch (error) {
    return unknown(`the launcher wrapper could not be read: ${String(error)}`);
  }

  if (!wrapperLooksGenerated(wrapperBody)) {
    return unknown(`the launcher wrapper does not look like a generated opencodex service wrapper: ${wrapperPath}`);
  }

  const rawCodexHome = batchSetValue(wrapperBody, "CODEX_HOME");
  const rawOpencodexHome = batchSetValue(wrapperBody, "OPENCODEX_HOME");

  return {
    kind: "present",
    claims: [{
      backend: "scheduler",
      definitionPath,
      homes: {
        codexHome: rawCodexHome === null ? null : decodeBatchPathValue(rawCodexHome),
        opencodexHome: rawOpencodexHome === null ? null : decodeBatchPathValue(rawOpencodexHome),
      },
      registration: "absent",
    }],
  };
}

/**
 * Walk the WinSW native-backend definition. SCM registration is queried via a
 * trusted, bounded `sc.exe query`; the WinSW executable itself is never run by
 * this read-only ownership probe.
 */
function walkWinswChain(
  deps: Required<Pick<ProbeDeps, "runRaw" | "home">>
    & Pick<ProbeDeps, "configDir" | "winswStatus" | "windowsLocale">,
): ServiceManagerInstallation {
  const configDir = windowsConfigDirPath(deps);
  const exePath = join(configDir, "winsw", `${WINSW_SERVICE_ID}.exe`);
  const xmlPath = join(configDir, "winsw", `${WINSW_SERVICE_ID}.xml`);
  const xml = artifactPresence(xmlPath);
  const exe = artifactPresence(exePath);
  const registration = probeWinswRegistration(deps);

  if (xml === "absent" && exe === "absent" && registration === "absent") return { kind: "absent" };
  // A query we could not ask is a question about a service that cannot exist: WinSW is an
  // optional backend, and with neither its XML nor its exe on disk there is nothing for a
  // registration to belong to. Fencing here on an `sc.exe` timeout is one of the two
  // triggers behind #2108, where a scheduler-only install answers 503 until `ocx restart`.
  //
  // The disk outranks the unaskable query only when BOTH assets are gone. Either one
  // present means a real install may be there and the old `unknown` still holds.
  if (registration === "unknown" && xml === "absent" && exe === "absent") {
    return { kind: "absent" };
  }
  if (registration === "unknown") {
    return unknown("the native WinSW service registration could not be verified");
  }
  if (xml === "absent" || exe === "absent") {
    return unknown("the native WinSW service registration could not be verified");
  }

  let body: string;
  try {
    body = decodeWindowsTextBytes(readFileSync(xmlPath), { locale: deps.windowsLocale });
  } catch (error) {
    return unknown(`the WinSW XML could not be read: ${String(error)}`);
  }
  if (!winswXmlLooksGenerated(body)) {
    return unknown(`the WinSW XML does not look like a generated opencodex service definition: ${xmlPath}`);
  }

  const envValue = (name: string): string | null => {
    const tag = new RegExp(`<env\\b[^>]*\\bname=["']${name}["'][^>]*>`, "i").exec(body);
    if (!tag) return null;
    const value = /value=(["'])(.*?)\1/i.exec(tag[0]);
    return value ? decodeXmlEntities(value[2]!) : null;
  };

  return {
    kind: "present",
    claims: [{
      backend: "winsw",
      definitionPath: exePath,
      homes: {
        codexHome: envValue("CODEX_HOME"),
        opencodexHome: envValue("OPENCODEX_HOME"),
      },
      registration,
    }],
  };
}

/** The generated WinSW XML embeds the SCM id and a `start --port` invocation. */
function winswXmlLooksGenerated(body: string): boolean {
  return /<id>\s*opencodex-proxy-native\s*<\/id>/i.test(body)
    && /<arguments>.*?start\s+--port\b/i.test(body);
}

export function inspectServiceManagerInstallation(deps: ProbeDeps = {}): ServiceManagerInstallation {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultProbeRunner;
  const runRaw = deps.runRaw ?? defaultRawProbeRunner;
  const home = deps.home ?? homedir();
  if (platform === "darwin") return inspectLaunchd({ run, uid: deps.uid ?? process.getuid?.() ?? 0, home });
  if (platform === "linux") return inspectSystemd({ run, home });
  if (platform === "win32") {
    return inspectWindows({
      runRaw,
      home,
      configDir: deps.configDir,
      winswStatus: deps.winswStatus,
      windowsLocale: deps.windowsLocale,
    });
  }
  return unknown(`no service manager probe for platform ${platform}`);
}

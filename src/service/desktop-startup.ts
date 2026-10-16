import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { readPid } from "../config/process-state";
import { resolveServiceOwnership, sameServiceOwnershipSubject, type ServiceOwnershipResolution } from "./state";
import { inspectDesktopSupervision, processIdentity, procfs, type DesktopSupervisionDeps, type ProcReader } from "./desktop-supervision.mjs";

export interface DesktopStartupDiagnostic {
  /** Durable desktop claim; failed supervision does not release ownership. */
  owned: boolean;
  loginEnabled: boolean;
  /** Verified enabled macOS registration; absence means registration is not credited. */
  loginRegistration?: "loaded" | "registered-not-loaded";
  running: boolean;
  viable: boolean;
  /**
   * Proven live parentage; never converts supervision into ownership. macOS and Linux report it
   * only without a durable claim. Windows also reports it beside a durable Desktop claim, because
   * older Windows runtimes never published a Desktop diagnostic that status could defer to.
   */
  supervisor?: { supervisorPid: number; runtimePid: number; app: string };
}

/** A login item alone is insufficient: the same app must supervise this proxy. */
export function deriveDesktopStartup(facts: Omit<DesktopStartupDiagnostic, "viable">): DesktopStartupDiagnostic {
  return { ...facts, viable: (facts.owned || facts.supervisor !== undefined) && facts.loginEnabled && facts.running };
}

export function desktopLoginStatusSummary(desktop: DesktopStartupDiagnostic): string {
  if (!desktop.loginEnabled) return "Desktop Start at Login: not registered, disabled, or could not be verified.";
  if (desktop.loginRegistration === "registered-not-loaded") {
    return "Desktop Start at Login: registered and enabled for next login; not loaded in this session.";
  }
  return `Desktop Start at Login: enabled${desktop.loginRegistration === "loaded" ? " and loaded in this session" : ""}.`;
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", timeout: 750, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface DesktopStartupDeps {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  ownership?: () => ServiceOwnershipResolution;
  readPid?: () => number | null;
  readRuntimePortPid?: () => number | null;
  run?: typeof run;
  env?: NodeJS.ProcessEnv;
  proc?: ProcReader;
  windowsProcesses?: DesktopSupervisionDeps["windowsProcesses"];
  now?: () => number;
  /** The Desktop's own install id (Tauri app_config_dir); null when unreadable. */
  readWindowsInstallId?: () => string | null;
}

/** Cheap ownership-only snapshot: no launchd/process probes on the server request path. */
export function desktopStartupOwnership(deps: DesktopStartupDeps = {}): DesktopStartupDiagnostic | undefined {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return undefined;
  const owner = (deps.ownership ?? resolveServiceOwnership)();
  return owner.kind === "owned" && owner.ownership.owner === "desktop"
    ? deriveDesktopStartup({ owned: true, loginEnabled: false, running: false }) : undefined;
}

function macLoginRegistration(deps: DesktopStartupDeps) {
  const execute = deps.run ?? run;
  const path = join(deps.home ?? homedir(), "Library", "LaunchAgents", "OpenCodex.plist");
  const domain = `gui/${deps.uid ?? process.getuid!()}`;
  const identity = (file: string) => {
    const stat = lstatSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
  };
  const capture = () => {
    const registrationPath = realpathSync(path);
    const plistIdentity = identity(path), targetIdentity = identity(registrationPath);
    const definition = execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
    const plist = JSON.parse(definition);
    const args = plist.ProgramArguments;
    if (plist.Label !== "OpenCodex" || plist.RunAtLoad !== true || !Array.isArray(args)
      || args.length !== 2 || args[1] !== "--autostart" || typeof args[0] !== "string"
      || !args[0].endsWith("/Contents/MacOS/opencodex-desktop")
      || (plist.Program !== undefined && plist.Program !== args[0])
      || (plist.Disabled !== undefined && typeof plist.Disabled !== "boolean")) return null;
    const app = realpathSync(args[0]);
    const proxy = realpathSync(join(dirname(app), "ocx"));
    accessSync(app, constants.X_OK);
    accessSync(proxy, constants.X_OK);
    const appIdentity = identity(app), proxyIdentity = identity(proxy);
    const disabled = execute("/bin/launchctl", ["print-disabled", domain]);
    const mentions = disabled.match(/"OpenCodex"/g)?.length ?? 0;
    const override = /"OpenCodex"\s*=>\s*(enabled|false|disabled|true)(?=\s*(?:\r?\n|[,;}]|$))/.exec(disabled)?.[1];
    const loginEnabled = /^\s*disabled services = \{[\s\S]*\}\s*$/.test(disabled)
      && (mentions === 0 ? plist.Disabled !== true : mentions === 1 && (override === "enabled" || override === "false"));
    if (registrationPath !== realpathSync(path) || plistIdentity !== identity(path) || targetIdentity !== identity(registrationPath)
      || app !== realpathSync(args[0]) || proxy !== realpathSync(join(dirname(app), "ocx"))
      || appIdentity !== identity(app) || proxyIdentity !== identity(proxy)) return null;
    return { app, proxy, loginEnabled, registrationPath, plistIdentity, targetIdentity, definition, appIdentity, proxyIdentity, disabled };
  };
  const first = capture();
  if (!first) return null;
  const { app, proxy } = first;
  if (!first.loginEnabled) return { app, proxy, loginEnabled: false };
  let loaded: string;
  try { loaded = execute("/bin/launchctl", ["print", `${domain}/OpenCodex`]); }
  catch (error) {
    // execFileSync's specific service-not-found result is absence, not a failed probe.
    // Timeout, permission denial, missing tools and another domain remain unverified.
    const failure = error as { status?: number; stderr?: unknown; signal?: unknown; code?: unknown } | null;
    const stderr = typeof failure?.stderr === "string" ? failure.stderr
      : Buffer.isBuffer(failure?.stderr) ? failure.stderr.toString("utf8") : "";
    const message = `Could not find service "OpenCodex" in domain for user gui: ${domain.slice(4)}`;
    const missing = failure?.status === 113 && !failure.signal && !failure.code
      && [message, `Bad request.\n${message}`].includes(stderr.trim());
    if (!missing) throw error;
    // The absent job supplies no durable registration evidence. Re-read the entire
    // registration and enabled state; replacement or ambiguity revokes login credit.
    const final = capture();
    if (!final || JSON.stringify(first) !== JSON.stringify(final)) return { app, proxy, loginEnabled: false };
    return { app, proxy, loginEnabled: true, loginRegistration: "registered-not-loaded" as const };
  }
  const program = /^\s*program = (.+)$/m.exec(loaded)?.[1];
  const loadedPath = /^\s*path = (.+)$/m.exec(loaded)?.[1];
  // macOS 13+ Background Task Management can take over the user LaunchAgent and resubmit it
  // through smd; launchctl then names the submitter instead of the plist (#7019). The loaded
  // job no longer points at the registration, so credit it like an unloaded job: same program,
  // and the entire registration re-read unchanged.
  if (program !== undefined && loadedPath !== undefined && SMD_SUBMITTED.test(loadedPath)
    && /^\s*managed_by = (.+)$/m.exec(loaded)?.[1] === SERVICE_MANAGEMENT && realpathSync(program) === app) {
    const final = capture();
    if (!final || JSON.stringify(first) !== JSON.stringify(final)) return { app, proxy, loginEnabled: false };
    return { app, proxy, loginEnabled: true, loginRegistration: "loaded" as const };
  }
  const loginEnabled = program !== undefined && realpathSync(program) === app
    && loadedPath !== undefined && realpathSync(loadedPath) === first.registrationPath;
  return { app, proxy, loginEnabled, ...(loginEnabled ? { loginRegistration: "loaded" as const } : {}) };
}

/** launchctl's `path` for a job Background Task Management resubmitted through smd. */
const SMD_SUBMITTED = /^\(submitted by smd\.\d+\)$/;
const SERVICE_MANAGEMENT = "com.apple.xpc.ServiceManagement";

type DesktopLoginFacts = Pick<DesktopStartupDiagnostic, "loginEnabled" | "loginRegistration">;

/**
 * Start at Login credit for one Desktop app copy. The tray's Start at Login item ports this
 * judgment (desktop/src-tauri/src/login_registration.rs); both run the cases in
 * tests/fixtures/desktop-login-registration-cases.json. Throws when evidence is unreadable.
 */
export function macLoginFactsFor(app: string, deps: DesktopStartupDeps): DesktopLoginFacts {
  const login = macLoginRegistration(deps);
  return login !== null && login.app === app
    ? { loginEnabled: login.loginEnabled, ...(login.loginRegistration ? { loginRegistration: login.loginRegistration } : {}) }
    : { loginEnabled: false };
}

function diagnoseSupervisedStartup(deps: DesktopStartupDeps, ownerRevision: number, loginFor: (app: string) => DesktopLoginFacts): DesktopStartupDiagnostic | undefined {
  const evidence = inspectDesktopSupervision(deps);
  if (evidence.kind !== "desktop") return undefined;
  let login: DesktopLoginFacts = { loginEnabled: false };
  try { login = loginFor(evidence.app); }
  catch { /* Login failure revokes restart viability, not the observed live supervisor. */ }
  if ((deps.ownership ?? resolveServiceOwnership)().kind !== "none") return undefined;
  // Login probes can outlive the runtime or its parent; only the same live chain gets credit.
  const final = inspectDesktopSupervision({ ...deps, targetPid: evidence.runtimePid });
  if (final.kind !== "desktop" || final.runtimePid !== evidence.runtimePid
    || final.supervisorPid !== evidence.supervisorPid || final.app !== evidence.app) return undefined;
  // A new claim or revision during the last process probe invalidates the unowned projection.
  const finalOwner = (deps.ownership ?? resolveServiceOwnership)();
  if (finalOwner.kind !== "none" || finalOwner.revision !== ownerRevision) return undefined;
  const { supervisorPid, runtimePid, app } = evidence;
  return deriveDesktopStartup({ owned: false, ...login, running: true, supervisor: { supervisorPid, runtimePid, app } });
}

/** Read-only macOS desktop ownership, login registration and live parent/child checks. */
export function diagnoseMacDesktopStartup(deps: DesktopStartupDeps = {}): DesktopStartupDiagnostic | undefined {
  if ((deps.platform ?? process.platform) !== "darwin") return undefined;
  const ownership = deps.ownership ?? resolveServiceOwnership;
  const owner = ownership();
  if (owner.kind === "none") return diagnoseSupervisedStartup(deps, owner.revision, app => macLoginFactsFor(app, deps));
  if (owner.kind !== "owned" || owner.ownership.owner !== "desktop") return undefined;
  const facts: Omit<DesktopStartupDiagnostic, "viable"> = { owned: true, loginEnabled: false, running: false };
  const execute = deps.run ?? run;
  const pidReader = deps.readPid ?? readPid;
  try {
    const home = deps.home ?? homedir();
    const id = readFileSync(join(home, "Library", "Application Support", "com.opencodex.desktop", "install-id"), "utf8").trim();
    if (id !== owner.ownership.installId) return deriveDesktopStartup(facts);
    const login = macLoginRegistration(deps);
    if (!login) return deriveDesktopStartup(facts);
    const { app, proxy } = login;
    facts.loginEnabled = login.loginEnabled;
    if (login.loginRegistration) facts.loginRegistration = login.loginRegistration;
    const pid = pidReader();
    if (pid !== null) {
      const child = processIdentity(pid, execute);
      const parent = child && child.parent > 1 ? processIdentity(child.parent, execute) : null;
      facts.running = child?.executable === proxy && parent?.executable === app && pidReader() === pid;
    }
    const currentOwner = ownership();
    if (currentOwner.kind === "unknown" || !sameServiceOwnershipSubject(owner, currentOwner)) facts.running = false;
    return deriveDesktopStartup(facts);
  } catch {
    // Unreadable launchd/process evidence never grants protection or releases the claim.
    return deriveDesktopStartup({ ...facts, running: false });
  }
}

/** HOME-based autostart entry written by the desktop app's login item (`tauri-plugin-autostart`). */
function linuxLoginApp(entry: string): string | null {
  const fields = new Map<string, string>();
  let section = "";
  for (const raw of entry.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { section = line; continue; }
    const at = line.indexOf("=");
    if (section === "[Desktop Entry]" && at > 0 && !fields.has(line.slice(0, at).trim())) {
      fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  if (fields.get("Type") !== "Application" || fields.get("Hidden") === "true"
    || fields.get("X-GNOME-Autostart-enabled") === "false"
    || ["OnlyShowIn", "NotShowIn", "TryExec"].some(key => fields.has(key))) return null;
  // Credit only the backend's simple Exec form; desktop quoting/escaping/field codes are unsupported.
  const app = /^([^\s"'\\%`><~|&;$*?#()]+) --autostart$/.exec(fields.get("Exec") ?? "")?.[1];
  return app && isAbsolute(app) && basename(app) === "opencodex-desktop" ? app : null;
}

/** Read-only Linux desktop ownership, HOME login entry and live parent/child checks via procfs. */
export function diagnoseLinuxDesktopStartup(deps: DesktopStartupDeps = {}): DesktopStartupDiagnostic | undefined {
  if ((deps.platform ?? process.platform) !== "linux") return undefined;
  const ownership = deps.ownership ?? resolveServiceOwnership;
  const owner = ownership();
  if (owner.kind === "none") return diagnoseSupervisedStartup(deps, owner.revision, app => {
    const home = deps.home ?? homedir();
    const configured = (deps.env ?? process.env).XDG_CONFIG_HOME;
    const config = configured && isAbsolute(configured) ? configured : join(home, ".config");
    // auto-launch's HOME entry must remain inside the session's XDG autostart search path.
    if (resolve(config) !== resolve(home, ".config")) return { loginEnabled: false };
    const entry = readFileSync(join(home, ".config", "autostart", "OpenCodex.desktop"), "utf8");
    const login = linuxLoginApp(entry);
    return { loginEnabled: login !== null && realpathSync(login) === app };
  });
  if (owner.kind !== "owned" || owner.ownership.owner !== "desktop") return undefined;
  const facts = { owned: true, loginEnabled: false, running: false };
  const proc = deps.proc ?? procfs;
  const pidReader = deps.readPid ?? readPid;
  try {
    const env = deps.env ?? process.env;
    const home = deps.home ?? homedir();
    const configured = env.XDG_CONFIG_HOME;
    const config = configured && isAbsolute(configured) ? configured : join(home, ".config");
    // auto-launch 0.5.0 writes autostart under HOME; Tauri app_config_dir uses XDG for install-id.
    // A relocated XDG_CONFIG_HOME puts that entry outside the session's autostart search path.
    if (resolve(config) !== resolve(home, ".config")) return deriveDesktopStartup(facts);
    const capture = () => {
      const id = readFileSync(join(config, "com.opencodex.desktop", "install-id"), "utf8");
      if (id.trim() !== owner.ownership.installId) return null;
      const entry = readFileSync(join(home, ".config", "autostart", "OpenCodex.desktop"), "utf8");
      const login = linuxLoginApp(entry);
      if (!login) return null;
      const app = realpathSync(login);
      if (basename(app) !== "opencodex-desktop") return null;
      const proxy = realpathSync(join(dirname(app), "ocx"));
      if (dirname(proxy) !== dirname(app) || basename(proxy) !== "ocx") return null;
      accessSync(app, constants.X_OK);
      accessSync(proxy, constants.X_OK);
      const pid = pidReader();
      const parent = pid !== null ? proc.parent(pid) : null;
      const child = pid !== null ? realpathSync(proc.exe(pid)) : null;
      const parentApp = parent !== null && parent > 1 ? realpathSync(proc.exe(parent)) : null;
      const running = pid !== null && child === proxy && parentApp === app && pidReader() === pid;
      const currentOwner = ownership();
      if (currentOwner.kind === "unknown" || !sameServiceOwnershipSubject(owner, currentOwner)) return null;
      return { id, entry, login, app, proxy, pid, parent, child, parentApp, running };
    };
    const first = capture();
    if (!first) return deriveDesktopStartup(facts);
    const final = capture();
    // Re-read the entire evidence chain, including files, targets and the exact parent PID.
    // A changed or unreadable snapshot cannot retain protection from the first read.
    if (final && JSON.stringify(first) === JSON.stringify(final)) {
      facts.loginEnabled = true;
      facts.running = final.running;
    }
    return deriveDesktopStartup(facts);
  } catch {
    // Unreadable login or procfs evidence never grants protection or releases the claim.
    return deriveDesktopStartup({ ...facts, running: false });
  }
}

/** Platform dispatch for the full (probing) desktop startup diagnostic. */
export function diagnoseDesktopStartup(deps: DesktopStartupDeps = {}): DesktopStartupDiagnostic | undefined {
  const platform = deps.platform ?? process.platform;
  if (platform === "linux") return diagnoseLinuxDesktopStartup(deps);
  if (platform === "win32") return diagnoseWindowsDesktopStartup(deps);
  return diagnoseMacDesktopStartup(deps);
}

/** Tauri resolves app_config_dir to the roaming AppData folder plus the bundle identifier. */
function readWindowsInstallId(env: NodeJS.ProcessEnv): string | null {
  const appData = env.APPDATA;
  if (!appData || !/^[A-Za-z]:[\\/]/.test(appData)) return null;
  try {
    return readFileSync(win32.join(appData, "com.opencodex.desktop", "install-id"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read-only Windows desktop ownership and live parent/child checks. Windows Start at Login is
 * not verified, so it is never credited and Desktop never reads as startup protection here;
 * the diagnostic still names the supervisor so status and doctor stop recommending service repairs.
 */
export function diagnoseWindowsDesktopStartup(deps: DesktopStartupDeps = {}): DesktopStartupDiagnostic | undefined {
  if ((deps.platform ?? process.platform) !== "win32") return undefined;
  const ownership = deps.ownership ?? resolveServiceOwnership;
  const owner = ownership();
  if (owner.kind === "none") return diagnoseSupervisedStartup(deps, owner.revision, () => ({ loginEnabled: false }));
  if (owner.kind !== "owned" || owner.ownership.owner !== "desktop") return undefined;
  const facts = { owned: true, loginEnabled: false, running: false };
  try {
    const installId = deps.readWindowsInstallId ? deps.readWindowsInstallId() : readWindowsInstallId(deps.env ?? process.env);
    if (installId !== owner.ownership.installId) return deriveDesktopStartup(facts);
    const evidence = inspectDesktopSupervision(deps);
    if (evidence.kind !== "desktop") return deriveDesktopStartup(facts);
    // Only the same live chain, read again after the claim, earns running and the supervisor.
    const final = inspectDesktopSupervision({ ...deps, targetPid: evidence.runtimePid });
    const current = ownership();
    if (final.kind !== "desktop" || final.runtimePid !== evidence.runtimePid
      || final.supervisorPid !== evidence.supervisorPid || final.app !== evidence.app
      || current.kind === "unknown" || !sameServiceOwnershipSubject(owner, current)) return deriveDesktopStartup(facts);
    const { supervisorPid, runtimePid, app } = final;
    return deriveDesktopStartup({ ...facts, running: true, supervisor: { supervisorPid, runtimePid, app } });
  } catch {
    // Unreadable evidence never grants running or releases the claim.
    return deriveDesktopStartup(facts);
  }
}

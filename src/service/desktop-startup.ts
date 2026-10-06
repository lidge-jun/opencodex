import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readPid } from "../config/process-state";
import { resolveServiceOwnership, sameServiceOwnershipSubject, type ServiceOwnershipResolution } from "./state";

export interface DesktopStartupDiagnostic {
  /** Durable desktop claim; failed supervision does not release ownership. */
  owned: boolean;
  loginEnabled: boolean;
  running: boolean;
  viable: boolean;
}

/** A login item alone is insufficient: the same app must own and supervise this proxy. */
export function deriveDesktopStartup(facts: Omit<DesktopStartupDiagnostic, "viable">): DesktopStartupDiagnostic {
  return { ...facts, viable: facts.owned && facts.loginEnabled && facts.running };
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
  run?: typeof run;
  env?: NodeJS.ProcessEnv;
  proc?: ProcReader;
}

/** Linux process identity from procfs: executable target and parent pid. */
interface ProcReader {
  exe(pid: number): string;
  parent(pid: number): number;
}
const procfs: ProcReader = {
  exe: pid => readlinkSync(`/proc/${pid}/exe`),
  // comm may contain spaces or parentheses, so fields are counted after the last ')'.
  parent: pid => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  },
};

/** Cheap ownership-only snapshot: no launchd/process probes on the server request path. */
export function desktopStartupOwnership(deps: DesktopStartupDeps = {}): DesktopStartupDiagnostic | undefined {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return undefined;
  const owner = (deps.ownership ?? resolveServiceOwnership)();
  return owner.kind === "owned" && owner.ownership.owner === "desktop"
    ? deriveDesktopStartup({ owned: true, loginEnabled: false, running: false }) : undefined;
}

function processIdentity(pid: number, execute: typeof run): { parent: number; executable: string } | null {
  const row = /^(\d+)\s+(.+)$/.exec(execute("/bin/ps", ["-p", String(pid), "-o", "ppid=,comm="]));
  return row ? { parent: Number(row[1]), executable: realpathSync(row[2]!) } : null;
}

/** Read-only macOS desktop ownership, login registration and live parent/child checks. */
export function diagnoseMacDesktopStartup(deps: DesktopStartupDeps = {}): DesktopStartupDiagnostic | undefined {
  if ((deps.platform ?? process.platform) !== "darwin") return undefined;
  const ownership = deps.ownership ?? resolveServiceOwnership;
  const owner = ownership();
  if (owner.kind !== "owned" || owner.ownership.owner !== "desktop") return undefined;
  const facts = { owned: true, loginEnabled: false, running: false };
  const execute = deps.run ?? run;
  const pidReader = deps.readPid ?? readPid;
  try {
    const home = deps.home ?? homedir();
    const id = readFileSync(join(home, "Library", "Application Support", "com.opencodex.desktop", "install-id"), "utf8").trim();
    if (id !== owner.ownership.installId) return deriveDesktopStartup(facts);
    const path = join(home, "Library", "LaunchAgents", "OpenCodex.plist");
    const plist = JSON.parse(execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]));
    const args = plist.ProgramArguments;
    if (plist.Label !== "OpenCodex" || plist.RunAtLoad !== true || !Array.isArray(args)
      || args.length !== 2 || args[1] !== "--autostart" || typeof args[0] !== "string"
      || !args[0].endsWith("/Contents/MacOS/opencodex-desktop")
      || (plist.Program !== undefined && plist.Program !== args[0])) return deriveDesktopStartup(facts);
    const app = realpathSync(args[0]);
    const proxy = realpathSync(join(dirname(app), "ocx"));
    accessSync(app, constants.X_OK);
    accessSync(proxy, constants.X_OK);
    const domain = `gui/${deps.uid ?? process.getuid!()}`;
    const disabled = execute("/bin/launchctl", ["print-disabled", domain]);
    const loaded = execute("/bin/launchctl", ["print", `${domain}/OpenCodex`]);
    const program = /^\s*program = (.+)$/m.exec(loaded)?.[1];
    const loadedPath = /^\s*path = (.+)$/m.exec(loaded)?.[1];
    facts.loginEnabled = /^\s*disabled services = \{[\s\S]*\}\s*$/.test(disabled)
      && !/"OpenCodex"\s*=>\s*(?:disabled|true)/.test(disabled)
      && program !== undefined && realpathSync(program) === app
      && loadedPath !== undefined && realpathSync(loadedPath) === realpathSync(path);
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
  return (deps.platform ?? process.platform) === "linux" ? diagnoseLinuxDesktopStartup(deps) : diagnoseMacDesktopStartup(deps);
}

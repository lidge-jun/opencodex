import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
}

/** Cheap ownership-only snapshot: no launchd/process probes on the server request path. */
export function desktopStartupOwnership(deps: DesktopStartupDeps = {}): DesktopStartupDiagnostic | undefined {
  if ((deps.platform ?? process.platform) !== "darwin") return undefined;
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

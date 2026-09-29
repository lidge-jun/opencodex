import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readPid } from "../config/process-state";
import { resolveServiceOwnership } from "./state";

export interface DesktopStartupDiagnostic {
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

function processIdentity(pid: number): { parent: number; executable: string } | null {
  const row = /^(\d+)\s+(.+)$/.exec(run("/bin/ps", ["-p", String(pid), "-o", "ppid=,comm="]));
  return row ? { parent: Number(row[1]), executable: realpathSync(row[2]!) } : null;
}

/** Read-only macOS desktop ownership, login registration and live parent/child checks. */
export function diagnoseMacDesktopStartup(): DesktopStartupDiagnostic | undefined {
  if (process.platform !== "darwin") return undefined;
  const owner = resolveServiceOwnership();
  if (owner.kind !== "owned" || owner.ownership.owner !== "desktop") return undefined;
  const facts = { owned: false, loginEnabled: false, running: false };
  try {
    const home = homedir();
    const id = readFileSync(join(home, "Library", "Application Support", "com.opencodex.desktop", "install-id"), "utf8").trim();
    facts.owned = id === owner.ownership.installId;
    if (!facts.owned) return deriveDesktopStartup(facts);
    const path = join(home, "Library", "LaunchAgents", "OpenCodex.plist");
    const plist = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]));
    const args = plist.ProgramArguments;
    if (plist.Label !== "OpenCodex" || plist.RunAtLoad !== true || !Array.isArray(args)
      || args.length !== 2 || args[1] !== "--autostart" || typeof args[0] !== "string"
      || !args[0].endsWith("/Contents/MacOS/opencodex-desktop")
      || (plist.Program !== undefined && plist.Program !== args[0])) return deriveDesktopStartup(facts);
    const app = realpathSync(args[0]);
    const proxy = realpathSync(join(dirname(app), "ocx"));
    accessSync(app, constants.X_OK);
    accessSync(proxy, constants.X_OK);
    const domain = `gui/${process.getuid!()}`;
    const disabled = run("/bin/launchctl", ["print-disabled", domain]);
    const loaded = run("/bin/launchctl", ["print", `${domain}/OpenCodex`]);
    const program = /^\s*program = (.+)$/m.exec(loaded)?.[1];
    const loadedPath = /^\s*path = (.+)$/m.exec(loaded)?.[1];
    facts.loginEnabled = !/"OpenCodex"\s*=>\s*disabled/.test(disabled)
      && program !== undefined && realpathSync(program) === app
      && loadedPath !== undefined && realpathSync(loadedPath) === realpathSync(path);
    const pid = readPid();
    if (pid !== null) {
      const child = processIdentity(pid);
      const parent = child && child.parent > 1 ? processIdentity(child.parent) : null;
      facts.running = child?.executable === proxy && parent?.executable === app && readPid() === pid;
    }
    return deriveDesktopStartup(facts);
  } catch {
    // Unreadable launchd/process evidence never grants protection.
    return deriveDesktopStartup({ ...facts, running: false });
  }
}

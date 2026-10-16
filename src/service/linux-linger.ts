import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

interface LinuxLingerDeps {
  user?: () => string;
  run?: typeof execFileSync;
}

/** Advisory only: never enables linger or changes the user's login settings. */
export function linuxServiceBootHint(deps: LinuxLingerDeps = {}): string {
  try {
    const user = (deps.user ?? (() => userInfo().username))();
    const output = (deps.run ?? execFileSync)("loginctl", ["show-user", user, "-p", "Linger"], {
      encoding: "utf8", timeout: 750, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (output === "Linger=yes") return "   Auto-start on boot: user lingering is already enabled.";
    if (output === "Linger=no") return "   For auto-start on boot: loginctl enable-linger $USER";
  } catch { /* Missing loginctl or failed diagnosis is advisory, not an install failure. */ }
  return "   User lingering could not be verified. For auto-start on boot, check it and, if disabled, run: loginctl enable-linger $USER";
}

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";

// Process-local success only; never persist a probe performed in another security domain.
const successes = new Map<string, number>();
export function verifyDesktopSandbox(executable: string): void {
  try {
    const path = realpathSync(executable), st = statSync(path);
    const key = JSON.stringify([path, st.ino, st.mtimeMs, st.ctimeMs]);
    if ((successes.get(key) ?? 0) > Date.now()) return;
    const args = ["--unshare-all", "--share-net", "--die-with-parent", "--new-session",
      "--ro-bind", "/usr", "/usr"];
    for (const path of ["/bin", "/lib", "/lib64", "/sbin"]) {
      if (!existsSync(path)) continue;
      args.push(...(lstatSync(path).isSymbolicLink()
        ? ["--symlink", readlinkSync(path), path] : ["--ro-bind", path, path]));
    }
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--clearenv", "--chdir", "/", "/usr/bin/true");
    // No vendor, credentials, workspace or inference; diagnostics never leave the child.
    const result = spawnSync(path, args, {
      env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 1500,
    });
    if (result.error || result.status !== 0 || result.signal) throw new Error();
    if (successes.size > 32) successes.clear();
    successes.set(key, Date.now() + 10_000);
  } catch { throw new Error("sandbox_unavailable"); }
}

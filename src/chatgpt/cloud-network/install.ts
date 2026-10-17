import { copyFileSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isStandaloneBinary } from "../../lib/standalone";
import { selfLaunchArgv } from "../../lib/self-launch-argv";
import { CLOUD_HELPER_LABEL, CLOUD_HELPER_ROOT, CLOUD_HELPER_PLIST, CLOUD_HELPER_SOCKET, CloudNetworkError } from "./contract";
import { cloudHelperRequest } from "./helper-client";
import { readHelperOwner, systemCloudMapping, withCloudHelperLock } from "./helper-system";
import type { CloudMappingOperations } from "./helper";
import type { CloudHelperReply } from "./contract";

export const CLOUD_INSTALL_CONSENT = "Install OpenCodex's internal cloud-network recovery helper with administrator permission. It can manage only the fixed cloud hostname in hosts and flush the resolver cache. Installation does not enable routing. No CA, system extension, model credentials or proxy-service changes.";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function cloudHelperPlist(argv: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${CLOUD_HELPER_LABEL}</string>
<key>ProgramArguments</key><array>${argv.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>2</integer><key>ExitTimeOut</key><integer>15</integer>
<key>WorkingDirectory</key><string>/</string><key>Umask</key><integer>63</integer>
</dict></plist>\n`;
}

export function cloudHelperLaunchArgv(root: string, standalone: boolean): string[] {
  return standalone ? [join(root, "runtime"), "internal", "chatgpt-cloud-network", "serve"]
    : [join(root, "runtime"), join(root, "helper.js")];
}

/** Source/npm installs bundle this small helper; standalone releases re-enter their copied CLI. */
export async function bundleCloudHelperSource(): Promise<string> {
  const result = await Bun.build({ entrypoints: [fileURLToPath(new URL("./helper-system.ts", import.meta.url))], target: "bun" });
  if (!result.success || result.outputs.length !== 1) throw new CloudNetworkError("helper_bundle_failed");
  return result.outputs[0]!.text();
}

function trustedDirectory(path: string, mode: number, owner: number): void {
  if (!existsSync(path)) mkdirSync(path, { mode });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== owner || (stat.mode & 0o022) !== 0) throw new CloudNetworkError("helper_directory_untrusted");
}

function removeOwnedFile(path: string, owner: number): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.uid !== owner || stat.nlink !== 1) throw new CloudNetworkError("helper_file_untrusted");
  unlinkSync(path);
}

function installFile(path: string, data: string, mode: number, owner: number): void {
  const next = `${path}.next`;
  removeOwnedFile(next, owner);
  writeFileSync(next, data, { flag: "wx", mode });
  renameSync(next, path);
}

function launchctl(args: string[]): number {
  return spawnSync("/bin/launchctl", args, { stdio: "ignore", timeout: 20_000 }).status ?? 1;
}

/** Public entry asks sudo once; the running proxy never elevates or installs anything. */
export function requestCloudHelperInstall(action: "install" | "uninstall"): number {
  if (process.platform !== "darwin" || !process.getuid?.()) throw new CloudNetworkError("run_from_macos_user_account");
  return spawnSync("/usr/bin/sudo", ["--", process.execPath, ...selfLaunchArgv(["internal", "chatgpt-cloud-network", action])], { stdio: "inherit" }).status ?? 1;
}

/** Only this explicit, elevated entry writes fixed system paths. No env/path override exists. */
export async function manageSystemCloudHelper(action: "install" | "uninstall"): Promise<number> {
  const uid = Number(process.env.SUDO_UID), gid = Number(process.env.SUDO_GID);
  if (process.platform !== "darwin" || process.getuid?.() !== 0 || !Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) {
    throw new CloudNetworkError("helper_install_requires_sudo_user");
  }
  return installCloudHelper(action, {
    root: CLOUD_HELPER_ROOT, plist: CLOUD_HELPER_PLIST, socketPath: CLOUD_HELPER_SOCKET,
    parents: ["/Library", "/Library/Application Support", "/Library/Application Support/OpenCodex"],
    plistDirectory: "/Library/LaunchDaemons", owner: 0, uid, gid, executable: process.execPath,
    standalone: isStandaloneBinary(), bundle: bundleCloudHelperSource, mapping: systemCloudMapping(),
    request: action => cloudHelperRequest(action), launchctl: async args => launchctl(args),
  });
}

/** Same installer used by production and temporary-file tests; never exposed as CLI path options. */
export async function installCloudHelper(action: "install" | "uninstall", options: {
  root: string; plist: string; socketPath: string; parents: string[]; plistDirectory: string;
  owner: number; uid: number; gid: number; executable: string; standalone: boolean;
  bundle: () => Promise<string>; mapping: CloudMappingOperations;
  request: (action: "status") => Promise<CloudHelperReply>;
  launchctl: (args: string[]) => Promise<number>;
}): Promise<number> {
  const { root, owner, uid, gid } = options;
  for (const dir of [...options.parents, root]) trustedDirectory(dir, 0o755, owner);
  trustedDirectory(join(root, "state"), 0o700, owner);
  if (existsSync(join(root, "install.json")) && readHelperOwner(root, owner).uid !== uid) throw new CloudNetworkError("helper_owned_by_other_user");
  let current;
  try { current = await options.request("status"); } catch { /* Lock and journal recovery below remain authoritative when stopped. */ }
  if (current?.state === "active") throw new CloudNetworkError("disable_cloud_network_before_install_or_uninstall");
  const label = `system/${CLOUD_HELPER_LABEL}`;
  if (await options.launchctl(["print", label]) === 0 && await options.launchctl(["bootout", label]) !== 0) throw new CloudNetworkError("helper_stop_failed");
  await withCloudHelperLock(root, async () => {
    options.mapping.recover();
    if (action === "uninstall") {
      for (const path of [options.plist, join(root, "helper.js"), join(root, "runtime"), join(root, "install.json")]) removeOwnedFile(path, owner);
      return;
    }
    const standalone = options.standalone;
    // Never leave launchd pointing into a user-writable npm package, source tree or Bun install.
    const bundled = standalone ? undefined : await options.bundle();
    const next = join(root, "runtime.next");
    removeOwnedFile(next, owner);
    copyFileSync(options.executable, next, constants.COPYFILE_EXCL);
    chmodSync(next, 0o755);
    renameSync(next, join(root, "runtime"));
    if (bundled !== undefined) installFile(join(root, "helper.js"), bundled, 0o644, owner);
    else removeOwnedFile(join(root, "helper.js"), owner);
    installFile(join(root, "install.json"), JSON.stringify({ protocol: 1, uid, gid }) + "\n", 0o644, owner);
    trustedDirectory(options.plistDirectory, 0o755, owner);
    installFile(options.plist, cloudHelperPlist(cloudHelperLaunchArgv(root, standalone)), 0o644, owner);
  });
  if (action === "uninstall") {
    const socket = lstatSync(options.socketPath, { throwIfNoEntry: false });
    if (socket) {
      if (!socket.isSocket() || socket.uid !== uid) throw new CloudNetworkError("helper_socket_conflict");
      unlinkSync(options.socketPath);
    }
    for (const name of ["owner.sqlite-journal", "owner.sqlite"]) removeOwnedFile(join(root, "state", name), owner);
    // rmdir refuses unknown leftovers; nothing recursively deletes the install or parent directory.
    rmdirSync(join(root, "state")); rmdirSync(root);
    return 0;
  }
  if (await options.launchctl(["bootstrap", "system", options.plist]) !== 0) throw new CloudNetworkError("helper_start_failed");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const status = await options.request("status");
      if (status.ok && status.state === "idle") return 0;
      throw new CloudNetworkError("helper_recovery_required");
    } catch (error) { if (error instanceof CloudNetworkError && error.message === "helper_recovery_required") throw error; }
    await Bun.sleep(100);
  }
  throw new CloudNetworkError("helper_readiness_failed");
}

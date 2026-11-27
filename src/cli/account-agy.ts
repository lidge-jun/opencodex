import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { baseScopedEnv } from "../adapters/coding-agent/turn";
import { resolveAgyBinary } from "../adapters/agy-acp/binary";
import { profileLaunch, profileNames, profileRoot, requireProfileVersion, selectedName, selectProfile, signedInProfile, validProfileName } from "../adapters/agy-acp/profiles";

const usage = "Usage: ocx account agy list | add <name> | use <name|default>";

export function addProfile(root: string, name: string, login: (dir: string) => void): void {
  if (!validProfileName(name)) throw new Error("Use a lowercase account label starting with a letter (up to 32 letters, digits or hyphens).");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  profileNames(root); // Check ownership and permissions before starting login.
  const target = join(root, name);
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error("That account label already exists.");
  const pending = mkdtempSync(join(root, ".login-"));
  try {
    login(pending);
    if (!signedInProfile(pending)) throw new Error("agy did not finish signing in to this private account directory.");
    renameSync(pending, target);
  } finally {
    if (existsSync(pending)) rmSync(pending, { recursive: true, force: true });
  }
}

export function cmdAgyAccount(args: string[]): number {
  if (process.platform === "win32") throw new Error("Named agy profiles currently require macOS or Linux.");
  const [action, name] = args;
  const root = profileRoot();
  if (action === "list" && args.length === 1) {
    const active = selectedName();
    for (const label of ["default", ...profileNames(root)]) console.log(label === active ? label + " (selected)" : label);
    return 0;
  }
  if (action === "use" && args.length === 2 && name) {
    selectProfile(name, getConfigDir(), root);
    console.log("Selected " + name + " for new Antigravity ACP turns.");
    return 0;
  }
  if (action === "add" && args.length === 2 && name) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run account sign-in in a local interactive terminal.");
    const binary = resolveAgyBinary();
    if (!binary) throw new Error("Install the Antigravity CLI first.");
    const env = baseScopedEnv();
    requireProfileVersion(execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10000, env }).trim());
    addProfile(root, name, dir => {
      const profile = profileLaunch(dir);
      const result = spawnSync(binary, ["acp", "--login", ...profile.args], {
        cwd: dir, env: { ...env, ...profile.env }, stdio: "inherit",
      });
      if (result.status !== 0) throw new Error("Antigravity account sign-in did not complete.");
    });
    console.log("Added " + name + ". Select it with ocx account agy use " + name + ".");
    return 0;
  }
  console.error(usage);
  return 1;
}

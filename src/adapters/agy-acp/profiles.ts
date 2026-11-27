import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../config/paths";
import { parseAgyVersion, versionAtLeast } from "./binary";

export function profileRoot(): string {
  return join(homedir(), ".gemini", "opencodex-acp-profiles");
}

export function validProfileName(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,31}$/.test(name) && name !== "default";
}

export function requireProfileVersion(version: string): void {
  if (!versionAtLeast(parseAgyVersion(version) ?? [], [1, 5, 18])) {
    throw new Error("Named Antigravity accounts require agy 1.5.18 or later.");
  }
}

export function profileLaunch(dir: string) {
  return {
    args: ["--gemini-dir", dir, "--app-data-dir", "antigravity-cli"],
    env: { GEMINI_HOME: dir, AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "true" },
  };
}

function privateDirectory(dir: string): boolean {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  return !!stat?.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
}

// agy owns and refreshes the credential. Check only filesystem metadata.
export function signedInProfile(dir: string): boolean {
  const data = join(dir, "antigravity-cli");
  if (!privateDirectory(dir) || !lstatSync(data, { throwIfNoEntry: false })?.isDirectory()) return false;
  const file = lstatSync(join(data, "antigravity-oauth-token"), { throwIfNoEntry: false });
  return !!file?.isFile() && file.size > 0 && file.uid === process.getuid?.() && (file.mode & 0o077) === 0;
}

export function profileNames(root: string): string[] {
  if (!lstatSync(root, { throwIfNoEntry: false })) return [];
  if (!privateDirectory(root)) throw new Error("The Antigravity account directory must be private.");
  return readdirSync(root).filter(name => validProfileName(name) && signedInProfile(join(root, name))).sort();
}

const selectedFile = "agy-acp-selected-account";
export function selectedName(config = getConfigDir()): string {
  try {
    const name = readFileSync(join(config, selectedFile), "utf8").trim();
    if (name === "default" || validProfileName(name)) return name;
    throw new Error("Invalid Antigravity account selection.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "default";
    throw error;
  }
}

export function agyCatalogSelection(config = getConfigDir()) {
  try {
    const name = selectedName(config);
    return { name, authority: JSON.stringify(["agy-acp", config, name]) };
  }
  catch { return undefined; }
}

export function selectProfile(name: string, config: string, root: string): void {
  if (name !== "default" && !profileNames(root).includes(name)) throw new Error("Unknown or signed-out Antigravity account.");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const file = join(config, selectedFile);
  const temporary = file + "." + randomUUID();
  try {
    writeFileSync(temporary, name + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function selectedLaunch(version: string, config = getConfigDir(), root = profileRoot()) {
  return launchForProfile(selectedName(config), version, root);
}

export function launchForProfile(name: string, version: string, root = profileRoot()) {
  if (name === "default") return { args: [], env: {} };
  if (!validProfileName(name)) throw new Error("Invalid Antigravity account label.");
  requireProfileVersion(version);
  const dir = join(root, name);
  if (!privateDirectory(root) || !signedInProfile(dir)) throw new Error("Selected Antigravity account is unavailable.");
  return profileLaunch(dir);
}

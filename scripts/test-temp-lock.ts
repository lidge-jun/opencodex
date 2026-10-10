import { randomUUID } from "node:crypto";
import { readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

/**
 * What a final Windows EPERM may do after the remove retry budget is spent.
 *
 * The 15s budget in `removeTestTempTree` is already the whole CI failure: about one second of
 * test, then EPERM until the budget ends, a different test each time, only on hosted
 * windows-latest. Lengthening that wait just moves the same red line. The hold that survives
 * it is treated as external (an indexer or scanner on the runner image) only when this process
 * has no child left to blame. A live child is a handle leak: the original error stays, and the
 * tree is not moved aside.
 *
 * The aside path has to stay inside this run's contained temp (`opencodex-test-* / tmp`). That
 * directory is on the same volume, so the rename does not copy, and the wrapper's end-of-run
 * removal of the sandbox root is what deletes it. A rename into the host temp would drop the
 * owner marker and leave a directory no later sweep is allowed to reclaim.
 */

/** Same shape `scripts/test-temp.ts` requires of a wrapped sandbox root. */
export const WRAPPED_TEST_ROOT_NAME = /^opencodex-test-[A-Za-z0-9]{6}$/;

const TRASH_PREFIX = ".trash-";
const DIAGNOSTIC_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_ENTRY_LIMIT = 40;
const DIAGNOSTIC_OUTPUT_LIMIT = 8_000;

export type LockedTempChild = Readonly<{
  pid: number;
  parentPid: number;
  name: string;
  referencesTarget: boolean;
}>;

export type LockedTempDiagnostic = Readonly<{
  platform: NodeJS.Platform;
  realpath: (path: string) => string;
  readDir: (path: string) => string[];
  isDirectory: (path: string) => boolean;
  /** Probe whether a file can be renamed aside and back. Returns an error code, or "". */
  probeRename: (path: string) => string;
  spawn: (command: readonly string[]) => { stdout: string; stderr: string; timedOut: boolean };
  children: (targetBasename: string) => readonly LockedTempChild[] | undefined;
  warn: (line: string) => void;
  trashName: () => string;
  rename: (from: string, to: string) => void;
}>;

const defaultDiagnostic: LockedTempDiagnostic = {
  platform: process.platform,
  realpath: realpathSync,
  readDir: path => readdirSync(path),
  isDirectory: path => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  },
  probeRename: path => {
    const aside = `${path}.probe-mv`;
    try {
      renameSync(path, aside);
    } catch (error) {
      return errorCode(error) || "rename";
    }
    try {
      renameSync(aside, path);
      return "";
    } catch (error) {
      return `restored-failed:${errorCode(error) || "rename"}`;
    }
  },
  spawn: command => {
    const result = Bun.spawnSync([...command], {
      stdout: "pipe", stderr: "pipe", timeout: DIAGNOSTIC_TIMEOUT_MS, windowsHide: true,
    });
    return {
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
      timedOut: result.signal === "SIGKILL" || result.exitCode === null,
    };
  },
  children: targetBasename => listDirectChildren(process.pid, targetBasename),
  warn: line => { console.error(line); },
  trashName: () => `${TRASH_PREFIX}${randomUUID()}`,
  rename: (from, to) => { renameSync(from, to); },
};

function decode(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DIAGNOSTIC_OUTPUT_LIMIT) return trimmed;
  return `${trimmed.slice(0, DIAGNOSTIC_OUTPUT_LIMIT)}\n… truncated`;
}

/**
 * The temp directory the wrapped test child was given. Host temp does not qualify: moving a
 * sandbox root there would escape the owner marker.
 */
export function containedRunTemp(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.TEMP || env.TMP || env.TMPDIR;
  if (!raw) return null;
  let resolved: string;
  try { resolved = realpathSync(raw); } catch { return null; }
  if (basename(resolved) !== "tmp") return null;
  if (!WRAPPED_TEST_ROOT_NAME.test(basename(resolve(resolved, "..")))) return null;
  return resolved;
}

export function isStrictChildPath(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  const left = platform === "win32" ? child.toLowerCase() : child;
  const right = platform === "win32" ? prefix.toLowerCase() : prefix;
  return left.startsWith(right);
}

export function listQuarantinedTestTemps(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 3) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      if (name.startsWith(TRASH_PREFIX)) found.push(full);
      else if (depth < 3) {
        try { if (statSync(full).isDirectory()) visit(full, depth + 1); } catch { /* gone */ }
      }
    }
  };
  visit(root, 0);
  return found;
}

/**
 * Move a finally-locked temp subtree aside, or refuse.
 *
 * Returns true only when the tree now lives under the contained run temp as `.trash-*`.
 * Diagnostics are printed whenever this is a Windows EPERM, including when the move is refused,
 * so the next red run still names the holder.
 */
export function quarantineFinalEperm(
  path: string,
  error: unknown,
  diagnostic: LockedTempDiagnostic = defaultDiagnostic,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (diagnostic.platform !== "win32" || errorCode(error) !== "EPERM") return false;
  let described = "";
  try { described = describeLockedTemp(path, diagnostic); }
  catch (describeError) { described = `[test-temp] lock diagnostic failed: ${String(describeError)}`; }
  diagnostic.warn(described);

  const runTmp = containedRunTemp(env);
  if (!runTmp) {
    diagnostic.warn("[test-temp] EPERM is outside the contained run temp; not moving it aside.");
    return false;
  }
  let canonical: string;
  try { canonical = diagnostic.realpath(path); }
  catch {
    diagnostic.warn("[test-temp] the locked path could not be resolved; not moving it aside.");
    return false;
  }
  if (!isStrictChildPath(canonical, runTmp, "win32") || basename(canonical).startsWith(TRASH_PREFIX)) {
    diagnostic.warn("[test-temp] the locked path is not a contained temp subtree; not moving it aside.");
    return false;
  }
  const children = diagnostic.children(basename(canonical));
  if (children === undefined) {
    diagnostic.warn("[test-temp] child-process probe did not complete; leaving the EPERM in place.");
    return false;
  }
  if (children.length > 0) {
    const names = children.map(child => `${child.pid}:${child.name}${child.referencesTarget ? ":references-temp" : ""}`).join(", ");
    diagnostic.warn(`[test-temp] a child process is still alive (${names}); not moving aside a possible handle leak.`);
    return false;
  }
  const destination = join(runTmp, diagnostic.trashName());
  try { diagnostic.rename(canonical, destination); }
  catch (renameError) {
    diagnostic.warn(`[test-temp] could not move the locked tree aside (${errorCode(renameError) || "rename"}).`);
    return false;
  }
  diagnostic.warn(`[test-temp] moved a locked temp tree aside for end-of-run deletion: ${destination}`);
  return true;
}

export function describeLockedTemp(path: string, diagnostic: LockedTempDiagnostic): string {
  const lines = [`[test-temp] final EPERM on ${path}`];
  let listed = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || listed >= DIAGNOSTIC_ENTRY_LIMIT) return;
    let names: string[];
    try { names = diagnostic.readDir(dir); }
    catch (error) {
      lines.push(`  readdir ${dir} -> ${errorCode(error) || "failed"}`);
      return;
    }
    for (const name of names) {
      if (listed >= DIAGNOSTIC_ENTRY_LIMIT) {
        lines.push("  … entry list truncated");
        return;
      }
      listed += 1;
      const full = join(dir, name);
      if (diagnostic.isDirectory(full)) {
        lines.push(`  dir  ${full}`);
        walk(full, depth + 1);
      } else {
        const probed = diagnostic.probeRename(full);
        lines.push(`  file ${full}${probed ? ` rename:${probed}` : " rename:ok"}`);
      }
    }
  };
  walk(path, 0);
  if (diagnostic.platform === "win32") {
    const acl = diagnostic.spawn(["icacls", path, "/T", "/C", "/Q"]);
    lines.push(`  icacls${acl.timedOut ? " (timed out)" : ""}:\n${indent(clip(acl.stdout + acl.stderr))}`);
    const attributes = diagnostic.spawn(["attrib", "/s", "/d", join(path, "*")]);
    lines.push(`  attrib${attributes.timedOut ? " (timed out)" : ""}:\n${indent(clip(attributes.stdout + attributes.stderr))}`);
  }
  return lines.join("\n");
}

function indent(text: string): string {
  if (!text) return "    (empty)";
  return text.split(/\r?\n/).map(line => `    ${line}`).join("\n");
}

function listDirectChildren(parentPid: number, targetBasename: string): readonly LockedTempChild[] | undefined {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return undefined;
  const result = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", CHILD_PROBE],
    {
      env: { ...process.env, OCX_LOCK_PARENT_PID: String(parentPid), OCX_LOCK_BASENAME: targetBasename },
      stdout: "pipe", stderr: "pipe", timeout: DIAGNOSTIC_TIMEOUT_MS, windowsHide: true,
    },
  );
  if (result.exitCode !== 0 || !Number.isSafeInteger(result.pid)) return undefined;
  const children: LockedTempChild[] = [];
  for (const line of decode(result.stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [pidRaw, parentRaw, name, referenced] = line.split("\t");
    const pid = Number(pidRaw);
    const parent = Number(parentRaw);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent) || !name) return undefined;
    children.push({ pid, parentPid: parent, name, referencesTarget: referenced === "1" });
  }
  // The probe is a direct child while it asks, and its command line does not name the
  // temp directory. Leaving it in the list makes every quarantine refuse.
  return omitProbeProcess(children, result.pid);
}

/** Drop the probe itself. Any other direct child still blocks the move. */
export function omitProbeProcess(
  children: readonly LockedTempChild[],
  probePid: number,
): readonly LockedTempChild[] {
  return children.filter(child => child.pid !== probePid);
}

const CHILD_PROBE = [
  "$parent = [int]$env:OCX_LOCK_PARENT_PID",
  "$leaf = $env:OCX_LOCK_BASENAME",
  "Get-CimInstance Win32_Process -Filter \"ParentProcessId = $parent\" |",
  "  Where-Object { $_.ProcessId -ne $PID } | ForEach-Object {",
  "  $hit = 0",
  "  if ($leaf -and $_.CommandLine -and $_.CommandLine.Contains($leaf)) { $hit = 1 }",
  "  \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$hit\"",
  "}",
].join("\n");

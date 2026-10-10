import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { readDesktopCliRecord, type DesktopCliRecordRead, desktopCliRecordPath, DESKTOP_CLI_RECORD_MAX_BYTES } from "../lib/desktop-cli-record.mjs";
import { redactUserPath } from "../lib/redact";

export type CliCommandIssue = Extract<DesktopCliRecordRead, { issue: string }>["issue"]
  | "cleanup-pending"
  | "desktop-target-missing" | "desktop-target-unusable"
  | "expected-command-missing" | "expected-command-unusable"
  | "path-missing" | "path-first-not-desktop" | "path-unreadable"
  | "path-scan-truncated" | "windows-current-directory-shadow";
export type CliPathCandidate = {
  path: string; realpath: string; pathIndex: number; extension: string;
};
export type CliPathDiagnostics = {
  configured: boolean;
  recordPath: string;
  packageHandoff: "enabled" | "disabled-on-windows";
  recordState: DesktopCliRecordRead["state"];
  expectedExecutable: string | null;
  handoffTarget: string | null;
  candidates: CliPathCandidate[];
  pathFirst: CliPathCandidate | null;
  desktopFirstOnPath: boolean | null;
  currentDirectoryCandidate: CliPathCandidate | null;
  shellResolution: "unobserved";
  issues: CliCommandIssue[];
};
export type CliPathObservation =
  | { kind: "usable"; realpath: string }
  | { kind: "missing" | "unusable" | "unreadable" };
export type CliPathDiagnosticOptions = {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; cwd?: string; home?: string;
  recordRead?: DesktopCliRecordRead;
  observe?: (path: string) => CliPathObservation;
};

export function collectCliPathDiagnostics(options: CliPathDiagnosticOptions = {}): CliPathDiagnostics {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const api = platform === "win32" ? win32 : posix;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? (platform === "win32" ? env.USERPROFILE || homedir() : homedir());
  const read = options.recordRead ?? readDesktopCliRecord({ platform, env, home, recordPath: desktopCliRecordPath({ platform, env, home }) });
  const configured = read.state === "ready";
  const target = configured && read.state === "ready" ? read.record.cliExecutable : null;
  const expected = configured ? (platform === "win32" ? target : api.join(home, ".opencodex-desktop", "bin", "ocx")) : null;
  const issues: CliCommandIssue[] = [];
  const add = (issue: CliCommandIssue): void => { if (!issues.includes(issue)) issues.push(issue); };
  if (read.state === "invalid" || read.state === "unreadable") add(read.issue);
  if (read.state === "disabled" && read.cleanupPending) add("cleanup-pending");
  const observe = options.observe ?? ((path: string): CliPathObservation => {
    try {
      if (!statSync(path).isFile()) return { kind: "unusable" };
      accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
      return { kind: "usable", realpath: realpathSync(path) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : code === "EACCES" ? "unusable" : "unreadable" };
    }
  });
  const key = (path: string): string => platform === "win32" ? path.toLowerCase() : path;
  const same = (a: string, b: string): boolean => key(a) === key(b);
  const envValue = (name: string): string | undefined => platform === "win32"
    ? env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) ?? name] : env[name];
  const path = envValue("PATH");
  const rawExtensions = platform === "win32"
    ? (envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(ext => /^\.[A-Za-z0-9]+$/.test(ext)) : [];
  const uniqueExtensions = [...new Set(rawExtensions.map(ext => ext.toLowerCase()))];
  const extensions = platform === "win32" ? [...uniqueExtensions.slice(0, 32), ""] : [""];
  if (uniqueExtensions.length > 32) add("path-scan-truncated");
  const directories = path === undefined ? [] : path.split(platform === "win32" ? ";" : ":");
  if (directories.length > 256) add("path-scan-truncated");
  const candidates: CliPathCandidate[] = [];
  const scan = (directory: string, pathIndex: number): CliPathCandidate[] => {
    const result: CliPathCandidate[] = [];
    const unquoted = platform === "win32" && directory.startsWith('"') && directory.endsWith('"') ? directory.slice(1, -1) : directory;
    for (const extension of extensions) {
      const candidate = api.resolve(cwd, unquoted || ".", `ocx${extension}`);
      const found = observe(candidate);
      if (found.kind === "unreadable") add("path-unreadable");
      if (found.kind === "usable") result.push({ path: candidate, realpath: found.realpath, pathIndex, extension });
    }
    return result;
  };
  for (const [index, directory] of directories.slice(0, 256).entries()) candidates.push(...scan(directory, index));
  const pathFirst = candidates[0] ?? null;
  const currentDirectoryCandidate = platform === "win32" ? scan(cwd, -1)[0] ?? null : null;
  let expectedRealpath: string | null = null;
  if (target) {
    const found = observe(target);
    if (found.kind === "missing") add("desktop-target-missing");
    else if (found.kind !== "usable") add("desktop-target-unusable");
  }
  if (expected) {
    const found = observe(expected);
    if (found.kind === "missing") add("expected-command-missing");
    else if (found.kind !== "usable") add("expected-command-unusable");
    else expectedRealpath = found.realpath;
    if (!pathFirst) add("path-missing");
    else if (!same(pathFirst.path, expected) && (!expectedRealpath || !same(pathFirst.realpath, expectedRealpath))) add("path-first-not-desktop");
    if (currentDirectoryCandidate && !same(currentDirectoryCandidate.path, expected)
      && (!expectedRealpath || !same(currentDirectoryCandidate.realpath, expectedRealpath))) add("windows-current-directory-shadow");
  }
  return {
    configured, recordPath: read.path, packageHandoff: platform === "win32" ? "disabled-on-windows" : "enabled",
    recordState: read.state, expectedExecutable: expected, handoffTarget: platform === "win32" ? null : target,
    candidates, pathFirst,
    desktopFirstOnPath: configured && !issues.includes("path-unreadable") && !issues.includes("path-scan-truncated")
      ? Boolean(pathFirst && expected && expectedRealpath
        && (same(pathFirst.path, expected) || same(pathFirst.realpath, expectedRealpath))) : null,
    currentDirectoryCandidate, shellResolution: "unobserved", issues,
  };
}

export function formatCliCommandLine(value: CliPathDiagnostics): string {
  const first = value.pathFirst ? redactUserPath(value.pathFirst.path).replace(/[\x00-\x1f\x7f]/g, "?") : "none observed";
  return `ocx command: PATH first=${first}; Desktop=${!value.configured ? "not configured" : value.desktopFirstOnPath === null ? "unobserved" : value.desktopFirstOnPath ? "first" : "not first"}; ${value.packageHandoff === "disabled-on-windows" ? "package handoff=disabled on Windows (user Path selects Desktop); " : ""}shell=unobserved${value.issues.length ? `; issues=${value.issues.join(",")}` : ""}`;
}

export function formatCliStatusHealthLabel(health: string, value: CliPathDiagnostics, local: boolean): string {
  return `${health}${local ? " (local)" : ""}\n   ${formatCliCommandLine(value)}`;
}

export function cliCommandDoctorChecks(value: CliPathDiagnostics): { level: "OK" | "WARN" | "FAIL"; message: string }[] {
  const hard = value.issues.some(issue => issue.startsWith("record-") || issue.startsWith("desktop-target-") || issue.startsWith("expected-command-"));
  const recovery = value.issues.some(issue => issue.startsWith("record-"))
    ? ` The terminal-command record at ${redactUserPath(value.recordPath).replace(/[\x00-\x1f\x7f]/g, "?")} could not be used. Open OpenCodex Desktop to repair the terminal command.${value.packageHandoff === "disabled-on-windows" ? "" : " Or run with OCX_NO_DESKTOP_HANDOFF=1."}${value.issues.includes("record-too-large") ? ` The record limit is ${DESKTOP_CLI_RECORD_MAX_BYTES} bytes.` : ""}`
    : value.issues.includes("cleanup-pending") ? " Open OpenCodex Desktop to finish terminal-command cleanup." : "";
  return [{ level: hard ? "FAIL" : value.issues.length ? "WARN" : "OK", message: formatCliCommandLine(value) + recovery }];
}

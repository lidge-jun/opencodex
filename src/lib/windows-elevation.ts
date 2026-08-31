import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { dlopen, ptr, type Pointer } from "bun:ffi";
import { isTestHomeGuardArmed } from "./test-home-guard";

type ElevationSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

let elevationSpawn: ElevationSpawn = spawn;

/** Test-only seam for the elevated PowerShell launcher. */
export function setWindowsElevationSpawnForTests(next: ElevationSpawn | null): void {
  elevationSpawn = next ?? spawn;
}

type GetSystemDirectoryW = (buffer: Pointer, size: number) => number;
type TrustedSystemDirectoryResolver = () => string;
type IsUserAnAdmin = () => number;
type WindowsElevationProbe = () => boolean | null;

export class WindowsSystemDirectoryFfiUnavailableError extends Error {
  constructor() {
    super("Failed to load GetSystemDirectoryW from kernel32.dll.");
    this.name = "WindowsSystemDirectoryFfiUnavailableError";
  }
}

let getSystemDirectoryWFn: GetSystemDirectoryW | null | undefined;
let trustedSystemDirectoryResolverForTests: TrustedSystemDirectoryResolver | null = null;
let isUserAnAdminFn: (() => boolean) | null | undefined;
let windowsElevationProbeForTests: WindowsElevationProbe | null = null;

/** Test-only seam to replace GetSystemDirectoryW-backed resolution. */
export function setTrustedWindowsSystemDirectoryResolverForTests(
  next: TrustedSystemDirectoryResolver | null,
): void {
  trustedSystemDirectoryResolverForTests = next;
}

/** Test-only seam for the locale-independent current-token elevation probe. */
export function setWindowsElevationProbeForTests(next: WindowsElevationProbe | null): void {
  windowsElevationProbeForTests = next;
}

function loadIsUserAnAdmin(): (() => boolean) | null {
  if (isUserAnAdminFn !== undefined) return isUserAnAdminFn;
  if (process.platform !== "win32") {
    isUserAnAdminFn = null;
    return null;
  }
  try {
    const lib = dlopen("shell32.dll", {
      IsUserAnAdmin: {
        args: [],
        // Win32 BOOL is a signed 32-bit integer, not C/C++ bool.
        returns: "i32",
      },
    });
    const isUserAnAdmin = lib.symbols.IsUserAnAdmin as IsUserAnAdmin;
    isUserAnAdminFn = () => isUserAnAdmin() !== 0;
  } catch {
    isUserAnAdminFn = null;
  }
  return isUserAnAdminFn;
}

/**
 * Probe the effective Windows token without parsing localized command output.
 * `null` fails closed: callers must retain the original scheduler error rather
 * than infer that an unknown token state needs elevation.
 */
export function isCurrentWindowsProcessElevated(): boolean | null {
  if (windowsElevationProbeForTests) return windowsElevationProbeForTests();
  const isUserAnAdmin = loadIsUserAnAdmin();
  if (!isUserAnAdmin) return null;
  try {
    return isUserAnAdmin();
  } catch {
    return null;
  }
}

function loadGetSystemDirectoryW(): GetSystemDirectoryW | null {
  if (getSystemDirectoryWFn !== undefined) return getSystemDirectoryWFn;
  if (process.platform !== "win32") {
    getSystemDirectoryWFn = null;
    return null;
  }
  try {
    const lib = dlopen("kernel32.dll", {
      GetSystemDirectoryW: {
        args: ["ptr", "u32"],
        returns: "u32",
      },
    });
    getSystemDirectoryWFn = (buffer, size) => lib.symbols.GetSystemDirectoryW(buffer, size) as number;
  } catch {
    getSystemDirectoryWFn = null;
  }
  return getSystemDirectoryWFn;
}

function decodeWideCString(buf: Uint16Array, length: number): string {
  return String.fromCharCode(...buf.subarray(0, length));
}

/**
 * Resolve the real Windows system directory via GetSystemDirectoryW.
 * Must never trust process.env.SystemRoot / WINDIR — those are caller-controlled and
 * must not select binaries for UAC elevation.
 */
export function resolveTrustedWindowsSystemDirectory(): string {
  if (trustedSystemDirectoryResolverForTests) {
    return trustedSystemDirectoryResolverForTests();
  }
  if (process.platform !== "win32") {
    throw new Error("Trusted Windows system directory resolution is only supported on Windows.");
  }
  const getSystemDirectoryW = loadGetSystemDirectoryW();
  if (!getSystemDirectoryW) {
    throw new WindowsSystemDirectoryFfiUnavailableError();
  }

  let size = 260;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const buf = new Uint16Array(size);
    const written = getSystemDirectoryW(ptr(buf.buffer), size);
    if (written === 0) {
      throw new Error("GetSystemDirectoryW failed while resolving the trusted system directory.");
    }
    // When the buffer is too small, the return value is the required size including NUL.
    if (written >= size) {
      size = written + 1;
      continue;
    }
    const directory = decodeWideCString(buf, written).replace(/[/\\]+$/, "");
    if (!directory || !existsSync(directory)) {
      throw new Error("GetSystemDirectoryW returned an unusable system directory.");
    }
    return resolvePath(directory);
  }
  throw new Error("GetSystemDirectoryW required a system directory path larger than expected.");
}

/**
 * True when `candidatePath` is the trusted directory itself, or a contained child.
 * Uses path.relative so containment works with host-native separators (Linux/macOS CI
 * hosts fake win32 with `/tmp/...` paths; a literal `\\` prefix check rejects them).
 */
function isPathInsideTrustedDirectory(trustedDirectory: string, candidatePath: string): boolean {
  const relativePath = relative(trustedDirectory, candidatePath);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function assertTrustedSystemExecutable(candidate: string, label: string): string {
  const systemDir = resolveTrustedWindowsSystemDirectory();
  const resolved = resolvePath(candidate);
  if (!isPathInsideTrustedDirectory(systemDir, resolved)) {
    throw new Error(`${label} resolved outside the trusted Windows system directory.`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`Trusted ${label} was not found at ${resolved}.`);
  }
  return resolved;
}

/** Test-only access to the trusted-path containment check. */
export function assertTrustedSystemExecutableForTests(candidate: string, label: string): string {
  return assertTrustedSystemExecutable(candidate, label);
}

type ElevationExeOverrides = { powershell?: string; schtasks?: string; taskkill?: string; icacls?: string };
let elevationExeOverridesForTests: ElevationExeOverrides | null = null;

/**
 * Test-only absolute executable overrides for Linux CI (which fakes win32 but has
 * no kernel32/System32). Production resolution never consults this seam.
 */
export function setTrustedWindowsElevationExecutablesForTests(
  next: ElevationExeOverrides | null,
): void {
  elevationExeOverridesForTests = next;
}

/** Absolute path to System32\\WindowsPowerShell\\v1.0\\powershell.exe from a trusted system directory. */
export function resolveTrustedWindowsPowerShellExe(): string {
  if (elevationExeOverridesForTests?.powershell) {
    return elevationExeOverridesForTests.powershell;
  }
  const candidate = join(
    resolveTrustedWindowsSystemDirectory(),
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return assertTrustedSystemExecutable(candidate, "PowerShell");
}

/** Absolute path to System32\\schtasks.exe from a trusted system directory. */
export function resolveTrustedWindowsSchtasksExe(): string {
  if (elevationExeOverridesForTests?.schtasks) {
    return elevationExeOverridesForTests.schtasks;
  }
  const candidate = join(resolveTrustedWindowsSystemDirectory(), "schtasks.exe");
  return assertTrustedSystemExecutable(candidate, "schtasks.exe");
}

/** Absolute path to System32\\taskkill.exe from a trusted system directory. */
export function resolveTrustedWindowsTaskkillExe(): string {
  if (elevationExeOverridesForTests?.taskkill) {
    return elevationExeOverridesForTests.taskkill;
  }
  const candidate = join(resolveTrustedWindowsSystemDirectory(), "taskkill.exe");
  return assertTrustedSystemExecutable(candidate, "taskkill.exe");
}

/** Absolute path to System32\\icacls.exe from a trusted system directory. */
export function resolveTrustedWindowsIcaclsExe(): string {
  if (elevationExeOverridesForTests?.icacls) {
    return elevationExeOverridesForTests.icacls;
  }
  const candidate = join(resolveTrustedWindowsSystemDirectory(), "icacls.exe");
  return assertTrustedSystemExecutable(candidate, "icacls.exe");
}

/** Stable machine-readable marker for a denied `schtasks /create`. Crosses the CLI→proxy boundary. */
export const WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER =
  "OCX_ERROR_CODE=WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED";

/**
 * Reserved elevated-scheduler protocol exit codes.
 * These are OpenCodex-owned values returned by the elevated PowerShell transaction.
 * They must never collide with UAC cancellation (1223).
 *
 * The elevated script never exits with raw schtasks codes — only these protocol values —
 * so the parent can classify the transaction without a user-controlled result file.
 */
export const OCX_ELEVATED_SUCCESS = 0;
export const OCX_ELEVATED_CREATE_FAILED = 10;
export const OCX_ELEVATED_RUN_FAILED_ROLLED_BACK = 11;
export const OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED = 12;
export const OCX_ELEVATED_PROTOCOL_FAILED = 13;
/** Windows ERROR_CANCELLED — reserved for UAC denial; never emitted by the elevated script. */
export const OCX_ELEVATED_UAC_CANCELLED = 1223;

export const OCX_ELEVATED_PROTOCOL_CODES = [
  OCX_ELEVATED_SUCCESS,
  OCX_ELEVATED_CREATE_FAILED,
  OCX_ELEVATED_RUN_FAILED_ROLLED_BACK,
  OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED,
  OCX_ELEVATED_PROTOCOL_FAILED,
] as const;

export type WindowsSchtasksOperation = "create" | "run" | "query" | "delete" | "end" | "other";
export type WindowsSchtasksFailureReason = "access-denied" | "other";

export type WindowsElevationFailureReason =
  | "cancelled"
  | "timeout"
  | "launch-failed"
  | "child-failed"
  | "terminated";

export type ElevatedSchedulerOutcome =
  | "success"
  | "create-failed"
  | "run-failed-rolled-back"
  | "run-failed-rollback-failed"
  | "protocol-failed";

const ELEVATION_OUTPUT_LIMIT = 256 * 1024;

function windowsAccessDeniedText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("access denied")
    || normalized.includes("access is denied")
    || normalized.includes("denied access")
    || normalized.includes("zugriff verweigert");
}

function windowsUacCancelledText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("operation was canceled by the user")
    || normalized.includes("operation was cancelled by the user")
    || normalized.includes("the operation was canceled")
    || normalized.includes("the operation was cancelled")
    || normalized.includes("vom benutzer abgebrochen")
    || normalized.includes("durch den benutzer abgebrochen");
}

/** True when a captured stderr/stdout/message indicates Windows access denial. */
export function isWindowsAccessDenied(detail: string): boolean {
  return windowsAccessDeniedText(detail);
}

/** True when a thrown exec error looks like Windows access denial. */
export function isWindowsAccessDeniedError(error: unknown): boolean {
  if (error instanceof WindowsSchtasksError) return error.reason === "access-denied";
  if (!(error instanceof Error)) return isWindowsAccessDenied(String(error));
  const exec = error as NodeJS.ErrnoException & { stderr?: string | Buffer; stdout?: string | Buffer };
  const parts = [error.message, exec.stderr, exec.stdout]
    .map(part => (typeof part === "string" ? part : part ? String(part) : ""));
  return parts.some(part => windowsAccessDeniedText(part));
}

/** True only for a structured Task Scheduler `/create` access-denied failure. */
export function isWindowsSchtasksCreateAccessDenied(detail: string): boolean {
  return detail.includes(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
}

export function schtasksOperationFromArgs(args: string[]): WindowsSchtasksOperation {
  const flag = (args[0] ?? "").toLowerCase();
  if (flag === "/create") return "create";
  if (flag === "/run") return "run";
  if (flag === "/query") return "query";
  if (flag === "/delete") return "delete";
  if (flag === "/end") return "end";
  return "other";
}

function schedulerExitStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/**
 * The owned scheduler install has a fixed shape. Restrict the locale-independent
 * fallback to that shape so unrelated schtasks failures cannot request elevation.
 */
function isOwnedSchedulerCreate(args: string[]): boolean {
  const normalized = args.map(arg => arg.toLowerCase());
  const taskIndex = normalized.indexOf("/tn");
  const xmlIndex = normalized.indexOf("/xml");
  return normalized[0] === "/create"
    && normalized[taskIndex + 1] === "opencodex-proxy"
    && taskIndex > 0
    && xmlIndex > 0
    && Boolean(args[xmlIndex + 1])
    && normalized.includes("/f");
}

function isWindowsSchtasksAccessDeniedError(error: unknown, args: string[]): boolean {
  if (!isOwnedSchedulerCreate(args)) return false;
  return isWindowsAccessDeniedError(error)
    || (schedulerExitStatus(error) === 1 && isCurrentWindowsProcessElevated() === false);
}

/** Structured Task Scheduler failure that survives formatting and process boundaries. */
export class WindowsSchtasksError extends Error {
  readonly code = "WINDOWS_SCHTASKS_ERROR" as const;

  constructor(
    readonly operation: WindowsSchtasksOperation,
    readonly reason: WindowsSchtasksFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "WindowsSchtasksError";
  }

  get machineMarker(): string | null {
    return this.operation === "create" && this.reason === "access-denied"
      ? WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER
      : null;
  }
}

export class WindowsElevationError extends Error {
  readonly code = "WINDOWS_ELEVATION_ERROR" as const;

  constructor(
    readonly reason: WindowsElevationFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "WindowsElevationError";
  }
}

/** Replace raw schtasks access-denied output with dashboard-friendly guidance. */
export function formatWindowsSchtasksError(error: unknown, args: string[]): string {
  const operation = schtasksOperationFromArgs(args);
  const ownedCreateAccessDenied = isWindowsSchtasksAccessDeniedError(error, args);
  const accessDenied = ownedCreateAccessDenied || isWindowsAccessDeniedError(error);
  if (!accessDenied) {
    return error instanceof Error ? error.message : String(error);
  }
  const argsText = args.map(arg => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
  const guidance = [
    "Windows access denied while running Task Scheduler.",
    `Command: schtasks ${argsText}`,
    "Approve the Windows UAC prompt to install the background service, or run `ocx service install` from an elevated PowerShell window.",
  ].join(" ");
  if (operation === "create" && ownedCreateAccessDenied) {
    return `${guidance}\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`;
  }
  return guidance;
}

export function toWindowsSchtasksError(error: unknown, args: string[]): WindowsSchtasksError {
  if (error instanceof WindowsSchtasksError) return error;
  const operation = schtasksOperationFromArgs(args);
  const reason: WindowsSchtasksFailureReason = isWindowsSchtasksAccessDeniedError(error, args)
    ? "access-denied"
    : "other";
  return new WindowsSchtasksError(operation, reason, formatWindowsSchtasksError(error, args));
}

/**
 * Quote one argument for Win32 CommandLineToArgvW / Start-Process -ArgumentList.
 * Handles empty args, spaces, embedded quotes, and trailing backslashes.
 */
export function windowsCmdQuote(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/.test(value)) return value;
  let result = '"';
  let numBackslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      numBackslashes += 1;
      continue;
    }
    if (ch === '"') {
      result += "\\".repeat(numBackslashes * 2 + 1) + '"';
      numBackslashes = 0;
      continue;
    }
    result += "\\".repeat(numBackslashes) + ch;
    numBackslashes = 0;
  }
  result += "\\".repeat(numBackslashes * 2) + '"';
  return result;
}

/** Build one Win32 argument-list string for Start-Process -ArgumentList. */
export function buildWindowsElevatedArgumentList(args: string[]): string {
  return args.map(windowsCmdQuote).join(" ");
}

/** Classify an elevated-process exit code into a stable scheduler outcome. */
export function classifyElevatedSchedulerExitCode(exitCode: number): ElevatedSchedulerOutcome {
  if (exitCode === OCX_ELEVATED_SUCCESS) return "success";
  if (exitCode === OCX_ELEVATED_CREATE_FAILED) return "create-failed";
  if (exitCode === OCX_ELEVATED_RUN_FAILED_ROLLED_BACK) return "run-failed-rolled-back";
  if (exitCode === OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED) return "run-failed-rollback-failed";
  // Malformed / unexpected / missing-ExitCode-normalized codes fail closed.
  return "protocol-failed";
}

function windowsPowerShell(): string {
  return resolveTrustedWindowsPowerShellExe();
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function appendBounded(current: string, chunk: string, limit = ELEVATION_OUTPUT_LIMIT): string {
  if (current.length >= limit) return current;
  const remaining = limit - current.length;
  return current + chunk.slice(0, remaining);
}

export interface WindowsElevationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WindowsElevationExecution {
  /** Settles only on launcher close/error — never killed by a request-level timeout. */
  completion: Promise<WindowsElevationResult>;
  launcherPid: number | null;
}

/** Request-facing wait for elevation; process observation continues separately. */
export const ELEVATION_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Wait for `promise` up to `timeoutMs` without cancelling it.
 * On timeout the original promise remains active for late settlement.
 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ status: "completed"; value: T } | { status: "timed-out" }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: "timed-out" });
    }, timeoutMs);
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "completed", value });
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Spawn non-elevated PowerShell to run a -Command script.
 * Does not kill the launcher on any timeout — callers race a separate request timeout.
 */
export function startPowerShellCommand(commandScript: string): WindowsElevationExecution {
  if (process.platform !== "win32") {
    return {
      launcherPid: null,
      completion: Promise.reject(new WindowsElevationError(
        "launch-failed",
        "Windows elevation is only supported on Windows.",
      )),
    };
  }

  // HOME isolation cannot contain UAC children or other machine-global effects. Keep the
  // final process boundary closed while the real launcher is installed; explicitly injected
  // launchers remain available to tests that exercise the elevation protocol in memory.
  if (isTestHomeGuardArmed() && elevationSpawn === spawn) {
    return {
      launcherPid: null,
      completion: Promise.reject(new WindowsElevationError(
        "launch-failed",
        "Refusing to launch a live Windows elevation process from an armed test process; inject the elevation launcher instead.",
      )),
    };
  }

  let child: ChildProcess;
  try {
    child = elevationSpawn(
      windowsPowerShell(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", commandScript],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    return {
      launcherPid: null,
      completion: Promise.reject(new WindowsElevationError(
        "launch-failed",
        error instanceof Error ? error.message : String(error),
      )),
    };
  }

  const completion = new Promise<WindowsElevationResult>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout = appendBounded(stdout, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr = appendBounded(stderr, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(() => reject(new WindowsElevationError(
        "launch-failed",
        error.code === "ENOENT"
          ? "Windows PowerShell was not found for elevation."
          : (error.message || "Windows elevation failed to launch."),
      )));
    });

    child.once("close", (code, signal) => {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      if (typeof code === "number") {
        // Only treat UAC-cancellation text as cancelled when the process did not succeed.
        if (
          code === OCX_ELEVATED_UAC_CANCELLED
          || (code !== 0 && windowsUacCancelledText(detail))
        ) {
          settle(() => reject(new WindowsElevationError(
            "cancelled",
            "Windows administrator approval was required, but the UAC prompt was cancelled or denied.",
          )));
          return;
        }
        settle(() => resolve({ exitCode: code, stdout, stderr }));
        return;
      }
      // Launcher terminated without an exit code — elevated child may still exist.
      settle(() => reject(new WindowsElevationError(
        "terminated",
        `Windows elevation terminated by ${signal ?? "unknown signal"}.`,
      )));
    });
  });

  return { completion, launcherPid: child.pid ?? null };
}

/**
 * Launch a file with UAC elevation and wait for it to exit.
 * Throws WindowsElevationError for cancellation, launch failure, or signal termination.
 * Returns the elevated process exit code for completed launches (including non-zero).
 */
export function runWindowsElevated(file: string, args: string[]): Promise<number> {
  const argumentList = buildWindowsElevatedArgumentList(args);
  // Touch .Handle so Windows PowerShell 5.1 keeps a process handle; ExitCode can
  // otherwise stay $null after -Wait and `exit $null` becomes exit 0 (false success).
  const script = [
    `$p = Start-Process -FilePath ${psSingleQuote(file)}`,
    argumentList.length > 0 ? ` -ArgumentList ${psSingleQuote(argumentList)}` : "",
    " -Verb RunAs -WindowStyle Hidden -PassThru -Wait;",
    `if ($null -eq $p) { exit ${OCX_ELEVATED_UAC_CANCELLED} }`,
    "$null = $p.Handle;",
    // Missing ExitCode is a protocol failure for single-file elevation (not success).
    `if ($null -eq $p.ExitCode) { exit ${OCX_ELEVATED_PROTOCOL_FAILED} }`,
    "exit $p.ExitCode",
  ].join("");

  return startPowerShellCommand(script).completion.then(result => result.exitCode);
}

/**
 * Register one scheduled-task definition without exposing a mutable XML pathname to
 * the elevated process. The XML bytes are fixed in the encoded PowerShell command
 * before UAC; Register-ScheduledTask receives that string directly after elevation.
 */
export function runWindowsElevatedScheduledTaskRegistration(
  taskName: string,
  xml: string,
  replace = false,
  expectedExistingXml?: string,
): Promise<number> {
  if (replace && !expectedExistingXml?.trim()) {
    throw new Error("Elevated Task Scheduler replacement requires a captured existing definition.");
  }
  const xmlBase64 = Buffer.from(xml, "utf16le").toString("base64");
  const expectedExistingBase64 = expectedExistingXml === undefined
    ? null
    : Buffer.from(expectedExistingXml, "utf16le").toString("base64");
  const powerShellPath = windowsPowerShell();
  const powerShellDirectory = powerShellPath.replace(/[\\/][^\\/]+$/, "");
  const scheduledTasksModule = `${powerShellDirectory}\\Modules\\ScheduledTasks\\ScheduledTasks.psd1`;
  const inner = [
    `$taskName = ${psSingleQuote(taskName)}`,
    `$xmlBase64 = ${psSingleQuote(xmlBase64)}`,
    "$xml = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($xmlBase64))",
    `$module = Microsoft.PowerShell.Core\\Import-Module -Name ${psSingleQuote(scheduledTasksModule)} -PassThru -Force -ErrorAction Stop`,
    "$registerTask = $module.ExportedCommands['Register-ScheduledTask']",
    "if ($null -eq $registerTask) { throw 'Trusted ScheduledTasks module does not export Register-ScheduledTask.' }",
    ...(replace ? [
      `$expectedBase64 = ${psSingleQuote(expectedExistingBase64!)}`,
      "$expectedXml = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($expectedBase64))",
      `$schtasks = ${psSingleQuote(resolveTrustedWindowsSchtasksExe())}`,
      "$currentXml = & $schtasks /query /tn $taskName /xml 2>$null | Out-String",
      "if ($LASTEXITCODE -ne 0) { throw 'Task Scheduler replacement precondition could not be read.' }",
      "function Normalize-OcxTaskXml([string]$value) { return (($value.TrimStart([char]0xFEFF) -replace \"`r`n?\", \"`n\").Trim()) }",
      "if ((Normalize-OcxTaskXml $currentXml) -cne (Normalize-OcxTaskXml $expectedXml)) { throw 'Task Scheduler replacement precondition changed.' }",
    ] : []),
    `& $registerTask -TaskName $taskName -Xml $xml${replace ? " -Force" : ""} -ErrorAction Stop | Out-Null`,
  ].join("; ");
  const encodedCommand = Buffer.from(inner, "utf16le").toString("base64");
  const script = [
    `$p = Start-Process -FilePath ${psSingleQuote(powerShellPath)}`,
    ` -ArgumentList ${psSingleQuote(buildWindowsElevatedArgumentList([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedCommand,
    ]))}`,
    " -Verb RunAs -WindowStyle Hidden -PassThru -Wait;",
    `if ($null -eq $p) { exit ${OCX_ELEVATED_UAC_CANCELLED} }`,
    "$null = $p.Handle;",
    `if ($null -eq $p.ExitCode) { exit ${OCX_ELEVATED_PROTOCOL_FAILED} }`,
    "exit $p.ExitCode",
  ].join("");

  return startPowerShellCommand(script).completion.then(result => result.exitCode);
}

/**
 * Build the elevated (post-UAC) script: create → run → optional delete rollback.
 * Returns only OpenCodex protocol exit codes (never raw schtasks codes, never 1223).
 * Does not write through any user-controlled pathname.
 */
export function buildElevatedSchtasksCreateAndRunScript(
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
): string {
  const createList = buildWindowsElevatedArgumentList(createArgs);
  const runList = buildWindowsElevatedArgumentList(runArgs);
  const deleteList = buildWindowsElevatedArgumentList(deleteArgs);
  return [
    `$schtasks = ${psSingleQuote(schtasksPath)}`,
    "function Invoke-OcxSchtasks([string]$ArgList) {",
    "  $p = Start-Process -FilePath $schtasks -ArgumentList $ArgList -Wait -PassThru -WindowStyle Hidden",
    "  if ($null -eq $p) { return 1 }",
    "  $null = $p.Handle",
    "  if ($null -eq $p.ExitCode) { return 1 }",
    "  return [int]$p.ExitCode",
    "}",
    `$createCode = Invoke-OcxSchtasks ${psSingleQuote(createList)}`,
    `if ($createCode -ne 0) { exit ${OCX_ELEVATED_CREATE_FAILED} }`,
    `$runCode = Invoke-OcxSchtasks ${psSingleQuote(runList)}`,
    `if ($runCode -eq 0) { exit ${OCX_ELEVATED_SUCCESS} }`,
    `$deleteCode = Invoke-OcxSchtasks ${psSingleQuote(deleteList)}`,
    `if ($deleteCode -eq 0) { exit ${OCX_ELEVATED_RUN_FAILED_ROLLED_BACK} }`,
    `exit ${OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED}`,
  ].join("; ");
}

export interface ElevatedSchtasksCreateAndRunResult {
  outcome: ElevatedSchedulerOutcome;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ElevatedSchtasksCreateAndRunExecution {
  completion: Promise<ElevatedSchtasksCreateAndRunResult>;
  launcherPid: number | null;
}

/**
 * Start create/run/rollback inside one elevated PowerShell process (one UAC prompt).
 * The completion promise outlives any request-level timeout — do not kill the launcher.
 */
export function startElevatedSchtasksCreateAndRun(
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
): ElevatedSchtasksCreateAndRunExecution {
  const inner = buildElevatedSchtasksCreateAndRunScript(schtasksPath, createArgs, runArgs, deleteArgs);
  const launcher = [
    `$p = Start-Process -FilePath ${psSingleQuote(windowsPowerShell())}`,
    ` -ArgumentList ${psSingleQuote(buildWindowsElevatedArgumentList([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      inner,
    ]))}`,
    " -Verb RunAs -WindowStyle Hidden -PassThru -Wait;",
    `if ($null -eq $p) { exit ${OCX_ELEVATED_UAC_CANCELLED} }`,
    "$null = $p.Handle;",
    `if ($null -eq $p.ExitCode) { exit ${OCX_ELEVATED_PROTOCOL_FAILED} }`,
    "exit $p.ExitCode",
  ].join("");

  const started = startPowerShellCommand(launcher);
  return {
    launcherPid: started.launcherPid,
    completion: started.completion.then(result => ({
      outcome: classifyElevatedSchedulerExitCode(result.exitCode),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    })),
  };
}

/**
 * Create, run, and (on /run failure) roll back the scheduler task inside one elevated
 * PowerShell process — one UAC prompt, no user-controlled result file.
 * Waits for the full elevated transaction (no request-timeout kill).
 */
export function runElevatedSchtasksCreateAndRun(
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
): Promise<ElevatedSchtasksCreateAndRunResult> {
  return startElevatedSchtasksCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs).completion;
}

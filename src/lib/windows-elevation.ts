import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function windowsAccessDeniedText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("access denied")
    || normalized.includes("access is denied")
    || normalized.includes("denied access")
    || normalized.includes("zugriff verweigert");
}

/** True when a captured stderr/stdout/message indicates Windows access denial. */
export function isWindowsAccessDenied(detail: string): boolean {
  return windowsAccessDeniedText(detail);
}

/** True when a thrown exec error looks like Windows access denial. */
export function isWindowsAccessDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) return isWindowsAccessDenied(String(error));
  const exec = error as NodeJS.ErrnoException & { stderr?: string | Buffer; stdout?: string | Buffer };
  const parts = [error.message, exec.stderr, exec.stdout]
    .map(part => (typeof part === "string" ? part : part ? String(part) : ""));
  return parts.some(part => windowsAccessDeniedText(part));
}

/** Replace raw schtasks access-denied output with dashboard-friendly guidance. */
export function formatWindowsSchtasksError(error: unknown, args: string[]): string {
  if (!isWindowsAccessDeniedError(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const argsText = args.map(arg => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
  return [
    "Windows access denied while running Task Scheduler.",
    `Command: schtasks ${argsText}`,
    "Approve the Windows UAC prompt to install the background service, or run `ocx service install` from an elevated PowerShell window.",
  ].join(" ");
}

function windowsCmdQuote(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Build one Win32 argument-list string for Start-Process -ArgumentList. */
export function buildWindowsElevatedArgumentList(args: string[]): string {
  return args.map(windowsCmdQuote).join(" ");
}

function windowsPowerShell(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(candidate) ? candidate : "powershell.exe";
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Launch a file with UAC elevation and wait for it to exit. */
export function runWindowsElevated(file: string, args: string[], timeoutMs = 120_000): Promise<number> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Windows elevation is only supported on Windows."));
  }
  const argumentList = buildWindowsElevatedArgumentList(args);
  const script = [
    `$p = Start-Process -FilePath ${psSingleQuote(file)}`,
    argumentList.length > 0 ? ` -ArgumentList ${psSingleQuote(argumentList)}` : "",
    " -Verb RunAs -WindowStyle Hidden -PassThru -Wait;",
    "if ($null -eq $p) { exit 1223 }",
    "exit $p.ExitCode",
  ].join("");
  return new Promise((resolve, reject) => {
    execFile(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    }, (error, _stdout, stderr) => {
      if (!error) {
        resolve(0);
        return;
      }
      const exec = error as NodeJS.ErrnoException & { status?: number | null };
      if (exec.code === "ETIMEDOUT") {
        reject(new Error(`Windows elevation timed out after ${timeoutMs}ms.`));
        return;
      }
      if (typeof exec.status === "number") {
        resolve(exec.status);
        return;
      }
      const detail = stderr.trim() || exec.message;
      reject(new Error(detail || "Windows elevation failed."));
    });
  });
}

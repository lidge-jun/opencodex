import { execFileSync } from "node:child_process";

/** Terminate the owned CLI and its descendants; never resolve on an unconfirmed tree kill. */
export function killWindowsProcessTree(pid: number): void {
  const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
  execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    stdio: "pipe",
    windowsHide: true,
    timeout: 5_000,
  });
}

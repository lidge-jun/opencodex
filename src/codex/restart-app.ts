import { execFileSync, spawn } from "node:child_process";

export type RestartCodexAppResult =
  | { ok: true; scheduled: true }
  | { ok: false; error: string };

export interface RestartCodexAppIo {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFile?: (file: string, args: string[]) => string;
  spawnDetached?: (file: string, args: string[]) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}
const windowsDiscoveryScript = [
  "$ErrorActionPreference = 'Stop'",
  "$app = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*!App' } | Select-Object -First 1",
  "if (-not $app) { throw 'Codex Desktop is not installed' }",
  "$all = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ChatGPT.exe' -and $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' })",
  "$ids = @($all | ForEach-Object { [int]$_.ProcessId })",
  "$roots = @($all | Where-Object { $ids -notcontains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })",
  "[pscustomobject]@{ appId = [string]$app.AppID; pids = $roots } | ConvertTo-Json -Compress",
].join("; ");

export function scheduleCodexAppRestart(io: RestartCodexAppIo = {}): RestartCodexAppResult {
  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const execFile = io.execFile ?? ((file, args) => execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }));
  const spawnDetached = io.spawnDetached ?? ((file, args) => {
    spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  });
  const schedule = io.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));

  try {
    if (platform === "win32") {
      const systemRoot = env.SystemRoot ?? "C:\\Windows";
      const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      const taskkill = `${systemRoot}\\System32\\taskkill.exe`;
      const explorer = `${systemRoot}\\explorer.exe`;
      const raw = execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", windowsDiscoveryScript]);
      const parsed = JSON.parse(raw) as { appId?: unknown; pids?: unknown };
      if (typeof parsed.appId !== "string" || !parsed.appId.startsWith("OpenAI.Codex_") || !parsed.appId.endsWith("!App")) {
        return { ok: false, error: "Codex Desktop is not installed" };
      }
      const rawPids = Array.isArray(parsed.pids) ? parsed.pids : parsed.pids == null ? [] : [parsed.pids];
      const pids = rawPids.filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0);
      schedule(() => {
        for (const pid of pids) {
          try { execFile(taskkill, ["/PID", String(pid), "/T", "/F"]); } catch { /* already closed */ }
        }
        // ponytail: fixed relaunch delay; replace with exit polling only if slow shutdowns appear.
        schedule(() => spawnDetached(explorer, [`shell:AppsFolder\\${parsed.appId}`]), pids.length ? 700 : 0);
      }, 400);
      return { ok: true, scheduled: true };
    }

    if (platform === "darwin") {
      execFile("/usr/bin/open", ["-Ra", "Codex"]);
      schedule(() => {
        try { execFile("/usr/bin/osascript", ["-e", "tell application \"Codex\" to quit"]); } catch { /* already closed */ }
        // ponytail: fixed relaunch delay; replace with exit polling only if slow shutdowns appear.
        schedule(() => spawnDetached("/usr/bin/open", ["-a", "Codex"]), 700);
      }, 400);
      return { ok: true, scheduled: true };
    }

    return { ok: false, error: "Restarting Codex Desktop is supported on Windows and macOS" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

import { execFile as nodeExecFile } from "node:child_process";

export type RestartCodexAppResult =
  | { ok: true; restarted: true }
  | { ok: false; error: string };

export interface RestartCodexAppIo {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFile?: (file: string, args: string[]) => Promise<string>;
  wait?: (delayMs: number) => Promise<void>;
}

const windowsRestartScript = [
  "$ErrorActionPreference = 'Stop'",
  "$app = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*!App' } | Select-Object -First 1",
  "if (-not $app) { throw 'Codex Desktop is not installed' }",
  "$match = '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe'",
  "$running = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ChatGPT.exe' -and $_.ExecutablePath -like $match })",
  "if ($running.Count) { Stop-Process -Id @($running.ProcessId) -Force -ErrorAction SilentlyContinue }",
  "$stopDeadline = (Get-Date).AddSeconds(5)",
  "do { $left = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ChatGPT.exe' -and $_.ExecutablePath -like $match }); if (-not $left.Count) { break }; Start-Sleep -Milliseconds 200 } while ((Get-Date) -lt $stopDeadline)",
  "if ($left.Count) { throw 'Codex Desktop did not stop' }",
  "Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('shell:AppsFolder\\' + [string]$app.AppID)",
  "$startDeadline = (Get-Date).AddSeconds(8)",
  "do { Start-Sleep -Milliseconds 250; $started = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ChatGPT.exe' -and $_.ExecutablePath -like $match }) } while (-not $started.Count -and (Get-Date) -lt $startDeadline)",
  "if (-not $started.Count) { throw 'Codex Desktop did not restart' }",
  "[pscustomobject]@{ appId = [string]$app.AppID; restarted = $true } | ConvertTo-Json -Compress",
].join("; ");

function execFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export async function restartCodexApp(io: RestartCodexAppIo = {}): Promise<RestartCodexAppResult> {
  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const run = io.execFile ?? execFile;
  const wait = io.wait ?? ((delayMs) => new Promise(resolve => setTimeout(resolve, delayMs)));

  try {
    if (platform === "win32") {
      const systemRoot = env.SystemRoot ?? "C:\\Windows";
      const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      const raw = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", windowsRestartScript]);
      const result = JSON.parse(raw) as { appId?: unknown; restarted?: unknown };
      if (typeof result.appId !== "string" || !result.appId.startsWith("OpenAI.Codex_") || result.restarted !== true) {
        return { ok: false, error: "Codex Desktop did not restart" };
      }
      return { ok: true, restarted: true };
    }

    if (platform === "darwin") {
      await run("/usr/bin/open", ["-Ra", "Codex"]);
      await run("/usr/bin/osascript", ["-e", "if application \"Codex\" is running then tell application \"Codex\" to quit"]);
      await wait(700);
      await run("/usr/bin/open", ["-a", "Codex"]);
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((await run("/usr/bin/osascript", ["-e", "application \"Codex\" is running"])).trim() === "true") {
          return { ok: true, restarted: true };
        }
        await wait(250);
      }
      return { ok: false, error: "Codex Desktop did not restart" };
    }

    return { ok: false, error: "Restarting Codex Desktop is supported on Windows and macOS" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

import { delimiter, dirname, extname, join } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { getConfigDir } from "./config";

const SHIM_MARKER = "opencodex codex autostart shim";
const STATE_PATH = join(getConfigDir(), "codex-shim.json");

interface ShimState {
  platform: NodeJS.Platform;
  wrapperPath: string;
  originalPath: string;
  backupPath: string;
}

function cliEntry(): { bun: string; cli: string } {
  return { bun: process.execPath, cli: join(import.meta.dir, "cli.ts") };
}

function commandNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";").filter(Boolean);
  return [name, ...exts.flatMap(ext => [`${name}${ext.toLowerCase()}`, `${name}${ext.toUpperCase()}`])];
}

function isShim(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

function findCodexOnPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of commandNames("codex")) {
      const path = join(dir, name);
      if (!existsSync(path) || isShim(path)) continue;
      try {
        if (!lstatSync(path).isDirectory()) return path;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function backupPathFor(path: string): string {
  const ext = extname(path);
  return ext ? `${path.slice(0, -ext.length)}.opencodex-real${ext}` : `${path}.opencodex-real`;
}

export function buildUnixCodexShim(realCodexPath: string, bunPath: string, cliPath: string): string {
  return `#!/usr/bin/env sh
# ${SHIM_MARKER}
if [ -z "$OCX_SHIM_BYPASS" ]; then
  if ! "${bunPath}" "${cliPath}" status 2>/dev/null | grep -q "Proxy running"; then
    mkdir -p "$HOME/.opencodex"
    nohup env OCX_SERVICE=1 "${bunPath}" "${cliPath}" start >> "$HOME/.opencodex/shim.log" 2>&1 &
    i=0
    while [ "$i" -lt 50 ]; do
      if "${bunPath}" "${cliPath}" status 2>/dev/null | grep -q "Proxy running"; then
        break
      fi
      sleep 0.1
      i=$((i + 1))
    done
  fi
fi
exec "${realCodexPath}" "$@"
`;
}

export function buildWindowsCodexShim(realCodexPath: string, bunPath: string, cliPath: string): string {
  return `@echo off\r
rem ${SHIM_MARKER}\r
if not "%OCX_SHIM_BYPASS%"=="" goto run_codex\r
"${bunPath}" "${cliPath}" status 2>nul | findstr /C:"Proxy running" >nul\r
if %ERRORLEVEL% EQU 0 goto run_codex\r
if not exist "%USERPROFILE%\\.opencodex" mkdir "%USERPROFILE%\\.opencodex"\r
start "" /b cmd /c "set OCX_SERVICE=1 && ""${bunPath}"" ""${cliPath}"" start >> ""%USERPROFILE%\\.opencodex\\shim.log"" 2>&1"\r
for /l %%i in (1,1,50) do (\r
  "${bunPath}" "${cliPath}" status 2>nul | findstr /C:"Proxy running" >nul\r
  if not errorlevel 1 goto run_codex\r
  powershell -NoProfile -Command "Start-Sleep -Milliseconds 100" >nul 2>nul\r
)\r
:run_codex\r
"${realCodexPath}" %*\r
`;
}

function readState(): ShimState | null {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as ShimState;
  } catch {
    return null;
  }
}

function writeState(state: ShimState): void {
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function writeShim(wrapperPath: string, realCodexPath: string): void {
  const { bun, cli } = cliEntry();
  if (process.platform === "win32") {
    writeFileSync(wrapperPath, buildWindowsCodexShim(realCodexPath, bun, cli), "utf8");
  } else {
    writeFileSync(wrapperPath, buildUnixCodexShim(realCodexPath, bun, cli), "utf8");
    chmodSync(wrapperPath, 0o755);
  }
}

export function installCodexShim(): { installed: boolean; message: string } {
  const existing = readState();
  if (existing && existsSync(existing.wrapperPath) && existsSync(existing.backupPath) && isShim(existing.wrapperPath)) {
    if (process.platform === "win32" && existing.originalPath && existsSync(existing.originalPath)) {
      renameSync(existing.originalPath, existing.backupPath);
      writeShim(existing.wrapperPath, existing.backupPath);
      writeState({ ...existing, platform: process.platform });
      return {
        installed: true,
        message: `Codex update detected. Backed up new binary and refreshed shim at ${existing.wrapperPath}.`,
      };
    }
    return { installed: false, message: `Codex autostart shim already installed at ${existing.wrapperPath}.` };
  }
  if (existing && existsSync(existing.backupPath) && (!existsSync(existing.wrapperPath) || !isShim(existing.wrapperPath))) {
    if (existsSync(existing.wrapperPath)) unlinkSync(existing.wrapperPath);
    writeShim(existing.wrapperPath, existing.backupPath);
    writeState({ ...existing, platform: process.platform });
    return {
      installed: true,
      message: `Codex autostart shim repaired at ${existing.wrapperPath}. Original remains at ${existing.backupPath}.`,
    };
  }

  const originalPath = findCodexOnPath();
  if (!originalPath) return { installed: false, message: "Could not find a codex executable on PATH." };

  const backupPath = backupPathFor(originalPath);
  if (existsSync(backupPath)) return { installed: false, message: `Refusing to overwrite existing backup: ${backupPath}` };

  const wrapperPath = process.platform === "win32" ? join(dirname(originalPath), "codex.cmd") : originalPath;
  renameSync(originalPath, backupPath);
  writeShim(wrapperPath, backupPath);
  writeState({ platform: process.platform, wrapperPath, originalPath, backupPath });
  return { installed: true, message: `Codex autostart shim installed at ${wrapperPath}. Original saved at ${backupPath}.` };
}

export function uninstallCodexShim(): { removed: boolean; message: string } {
  const state = readState();
  if (!state) return { removed: false, message: "Codex autostart shim is not installed." };
  if (existsSync(state.wrapperPath) && isShim(state.wrapperPath)) unlinkSync(state.wrapperPath);
  if (existsSync(state.backupPath) && !existsSync(state.originalPath)) renameSync(state.backupPath, state.originalPath);
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
  return { removed: true, message: `Codex autostart shim removed. Restored ${state.originalPath}.` };
}

export function codexShimStatus(): string {
  const state = readState();
  if (!state) return "Codex autostart shim is not installed.";
  const wrapper = existsSync(state.wrapperPath)
    ? isShim(state.wrapperPath)
      ? "shim present"
      : "present but not an opencodex shim"
    : "missing";
  const backup = existsSync(state.backupPath) ? "present" : "missing";
  return `Codex autostart shim: wrapper ${wrapper} at ${state.wrapperPath}; original backup ${backup} at ${state.backupPath}.`;
}

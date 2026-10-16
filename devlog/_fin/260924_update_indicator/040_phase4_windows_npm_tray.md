# Commit 4 — Windows npm tray update dot

## Goal, boundary, prerequisites

One ordered commit makes the installed PowerShell tray show a blue update dot without changing the online/warning/offline safety classification. It reads commit 1's package badge cache via a hidden CLI JSON command, probes every 60 seconds without blocking the 3-second Windows Forms tick, and gives the user an **Update available** menu link to the dashboard. Commit 1 must already provide the read-only, expiring `readUpdateBadge()` result; commits 2–3 may land but the npm tray does not consume desktop snapshots. This implements accepted D6 in `000_plan.md`; do not add automatic install, another update authority, a management-token request, Tauri base-glyph redesign, or public CLI capability. The parent owns integration, push, and PR.

Current anchors: `src/update/badge.ts:6-17,37-67` defines `UpdateBadge` and exports `readUpdateBadge`; `src/cli/registry.ts:591-595` registers a hidden `__refresh-version`; `src/cli/dispatch.ts:725-732` lazy-imports its runner; `src/cli/root.ts:106-112` invokes the shim preflight; `src/cli/codex-shim-autorestore.ts:18-31` holds its exemptions. `src/tray/windows-tray.ps1:137-199` has the asynchronous startup-health probe, `:313-426` has the tick and three-state icon choice, and `:491-522` owns shutdown. `src/tray/windows.ts:18-22,67-86,620-621,659-675,697-750` derives install, rollback, and uninstall assets from one list. The published `.ico` files contain nine PNG frames at 16, 20, 24, 32, 40, 48, 64, 128 and 256 pixels (file header inspection, 2026-09-24). No generator for those three original `.ico` files exists in the tree; `scripts/lib/icon-render.ts:13-20,140-161` provides the available deterministic render/ICO packer. These are code anchors, not claims that the future snippets have shipped.

## File change map and executable edits

Apply the following to the commit-1 tree. All paths are repository-relative. `NEW` binary outputs are specified by the exact generating source and command; binary bytes cannot be represented as a Markdown code fence. No deletions. For modified files, the marked insertions/replacements are the entire intended delta, not a rewrite of unrelated existing content.

| Action | Path | Change |
| --- | --- | --- |
| NEW | `scripts/generate-windows-tray-update-icons.ts` | Complete source below; derive three nine-frame dotted variants from the shipped base frames; `--check` compares bytes. |
| NEW | `src/tray/assets/opencodex-tray-online-update.ico` | Output of generator, blue dot over online glyph. |
| NEW | `src/tray/assets/opencodex-tray-warning-update.ico` | Output of generator, blue dot over warning glyph. |
| NEW | `src/tray/assets/opencodex-tray-offline-update.ico` | Output of generator, blue dot over offline glyph. |
| MODIFY | `src/tray/windows.ts`, `src/lib/config-ownership.ts` | Add all three names to existing ownership/install lists. |
| MODIFY | `src/cli/registry.ts`, `src/cli/dispatch.ts`, `src/cli/codex-shim-autorestore.ts` | Hidden JSON runner and preflight exemption. |
| MODIFY | `src/tray/windows-tray.ps1` | Independent asynchronous badge probe, expiry, icon/menu projection, cleanup. |
| MODIFY | `tests/windows/windows-tray.test.ts`, `tests/windows/tray-proxy.test.ts`, `tests/cli/cli-registry.test.ts`, `tests/helpers/windows-tray-probe-lifecycle-driver.ps1` | Contract and real Windows probe coverage. |
| NEW | `tests/cli/cli-update-badge.test.ts` | Full subprocess test source below. |
| MODIFY | `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | Register the new Bun test. |
| MODIFY | `structure/runtime.md`, `structure/ops/service-and-sidecars.md` | Present-tense CLI/tray ownership contract. |
| MODIFY | `docs-site/src/content/docs/reference/cli/lifecycle.md` and its existing `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw` siblings | Explain indicator and click path. |

### Generator and binary outputs

`scripts/generate-windows-tray-update-icons.ts` (NEW, complete file):

```ts
#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIco, render } from "./lib/icon-render";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = join(root, "src", "tray", "assets");
const names = ["online", "warning", "offline"] as const;
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const;

function frames(bytes: Buffer): Map<number, Buffer> {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    throw new Error("invalid tray ICO header");
  }
  const count = bytes.readUInt16LE(4);
  if (count !== sizes.length) throw new Error(`tray ICO has ${count} frames, expected ${sizes.length}`);
  const result = new Map<number, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const at = 6 + 16 * i;
    if (at + 16 > bytes.length) throw new Error("truncated tray ICO directory");
    const size = bytes[at] || 256;
    const height = bytes[at + 1] || 256;
    const length = bytes.readUInt32LE(at + 8);
    const offset = bytes.readUInt32LE(at + 12);
    if (size !== height || !sizes.includes(size as typeof sizes[number]) || offset + length > bytes.length) {
      throw new Error("invalid tray ICO frame bounds or size");
    }
    const png = bytes.subarray(offset, offset + length);
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("tray ICO frame is not PNG");
    }
    if (result.has(size)) throw new Error(`duplicate ${size}px tray ICO frame`);
    result.set(size, png);
  }
  if (sizes.some(size => !result.has(size))) throw new Error("tray ICO frame missing");
  return result;
}

function dottedFrame(base: Buffer, size: number, scratch: string): Buffer {
  const center = size * 0.79;
  const radius = Math.max(2, size * 0.115);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<image width="${size}" height="${size}" href="data:image/png;base64,${base.toString("base64")}"/>`
    + `<circle cx="${center}" cy="${center}" r="${radius + Math.max(1, size * 0.035)}" fill="#ffffff"/>`
    + `<circle cx="${center}" cy="${center}" r="${radius}" fill="#1683ff"/></svg>`;
  const source = join(scratch, `frame-${size}.svg`);
  const output = join(scratch, `frame-${size}.png`);
  writeFileSync(source, svg);
  render(size, output, source);
  return readFileSync(output);
}

function generated(name: typeof names[number], scratch: string): Buffer {
  const source = readFileSync(join(assets, `opencodex-tray-${name}.ico`));
  const originals = frames(source);
  return buildIco(sizes.map(size => ({ size, bytes: dottedFrame(originals.get(size)!, size, scratch) })));
}

function main(): number {
  const check = process.argv.slice(2).includes("--check");
  const scratch = mkdtempSync(join(tmpdir(), "ocx-tray-icons-"));
  try {
    let drift = false;
    for (const name of names) {
      const output = join(assets, `opencodex-tray-${name}-update.ico`);
      const expected = generated(name, scratch);
      if (check) {
        if (!existsSync(output) || !readFileSync(output).equals(expected)) {
          console.error(`[tray-icons] stale: ${name}-update.ico`);
          drift = true;
        }
      } else {
        writeFileSync(output, expected);
      }
    }
    if (!drift) console.log(check ? "[tray-icons] update ICOs match" : "[tray-icons] wrote update ICOs");
    return drift ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exit(main());
```

The generated three `.ico` files are `buildIco` output from the corresponding current base `.ico`. Run `bun scripts/generate-windows-tray-update-icons.ts`, then `bun scripts/generate-windows-tray-update-icons.ts --check` locally with `rsvg-convert` installed. `render` invokes it (`scripts/lib/icon-render.ts:13-20`); a temporary SVG with an embedded base ICO PNG frame rendered successfully here (exit 0). Keep `--check` as a documented local/manual byte-exact check in a controlled renderer environment, **outside the general Bun suite and Ubuntu test shards**. Renderer versions are not pinned, and those shards do not install librsvg (`.github/workflows/ci.yml`, unlike the desktop Linux job). The general-suite test below parses committed ICO bytes without invoking this script or `rsvg-convert`. Dot/halo legibility at 16 px and Windows 100%/200% visual acceptance belong to Windows QA. A missing renderer or malformed base frame fails local generation; it never silently writes a partial `.ico` file. The generator writes each output only after its whole ICO has been assembled.

`src/tray/windows.ts:18-22`, append these names to `TRAY_ICON_FILES` after the three existing entries; the existing `sourceTrayIconPaths()` and `installedTrayIconPaths()` automatically carry install, rollback, and uninstall (`:67-86,620-621,659-675,697-750`):

```ts
  "opencodex-tray-online-update.ico",
  "opencodex-tray-warning-update.ico",
  "opencodex-tray-offline-update.ico",
```

`src/lib/config-ownership.ts:63-66`, insert the exact same three filenames in sorted order among the literal known-owned entries. They must be recognized before uninstall/cleanup, including an upgrade over an older three-icon installation.

### Hidden CLI JSON read

`src/cli/registry.ts:590-595`, insert after `__refresh-version`:

```ts
  {
    name: "__update-badge",
    hidden: true,
    usage: "ocx __update-badge",
    summary: "Hidden internal: print cached package update badge JSON.",
  },
```

`src/cli/dispatch.ts:725-732`, insert a runner adjacent to `__refresh-version`:

```ts
  "__update-badge": async deps => {
    if (deps.args.length !== 1) {
      console.error("Usage: ocx __update-badge");
      return 64;
    }
    const { readUpdateBadge } = await import("../update/badge");
    console.log(JSON.stringify(readUpdateBadge()));
    return 0;
  },
```

`src/cli/codex-shim-autorestore.ts:18-31`, insert before the final return:

```ts
  if (command === "__update-badge") return true;
```

This exemption is mandatory: `runCli` calls `maybeAutoRestoreCodexShim` before dispatch (`src/cli/root.ts:106-112`). `readUpdateBadge` reads the cached result (`src/update/badge.ts:37-67`) and does not call a refresh. The dispatch dynamic import avoids adding badge dependencies to every command's static import path. The command accepts no flags, returns one JSON object on stdout, and never calls `loadConfig`, `refreshVersionCache`, `runUpdate`, service actions, or `writeVersionCache`. The general CLI entrypoint's existing static imports are unchanged; the Windows CI timing test must establish that a cold invocation completes within the probe timeout. No `src/cli/capabilities.ts` or generated `skills/ocx` edit: that data file describes agent-facing verbs (`src/cli/capabilities.ts:1-23`), whereas this is a hidden runner; `scripts/generate-ocx-skill-surface.ts:15` reads only `CAPABILITIES`, and `bun run skill:surface:check` must remain green.

### PowerShell tray delta

`src/tray/windows-tray.ps1:41-43`: add three loads immediately after the existing three. A missing new file falls back to the matching base icon, not a system icon:

```powershell
$onlineUpdateIcon = Load-TrayIcon "opencodex-tray-online-update.ico" $onlineIcon
$warningUpdateIcon = Load-TrayIcon "opencodex-tray-warning-update.ico" $warningIcon
$offlineUpdateIcon = Load-TrayIcon "opencodex-tray-offline-update.ico" $offlineIcon
```

`src/tray/windows-tray.ps1:243-252`: add the update item immediately after Open Dashboard, initially hidden and disabled; `:428` and `:471` show the existing dashboard action to reuse:

```powershell
$updateItem = $menu.Items.Add("Update available")
$updateItem.Visible = $false
$updateItem.Enabled = $false
```

Add `$updateItem.add_Click({ Start-OcxCommand @("gui") })` beside `$openItem.add_Click`. This intentionally opens the dashboard; the existing sidebar update flow performs the package update, so clicking the tray item itself never installs.

`src/tray/windows-tray.ps1:254-270`: add independent state. The attempt timestamp, not the last successful answer, controls cadence; the answer expires three minutes after its *successful observation* and is never extended by errors:

```powershell
$script:updateAvailable = $false
$script:updateBadgeObservedAt = 0L
$script:updateBadgeAttemptAt = 0L
$script:updateBadgeRefreshMs = 60000L
$script:updateBadgeExpiryMs = 180000L
$script:updateBadgeTimeoutMs = 12000L
$script:updateBadgeMaxBytesPerStream = 16384
$script:updateBadgeProcess = $null
$script:updateBadgeOutputTask = $null
$script:updateBadgeErrorTask = $null
$script:updateBadgeStarted = 0L
$script:updateBadgeTerminating = $false
```

Add the following functions after `Complete-StartupHealthProbe` (`src/tray/windows-tray.ps1:187-199`). The badge child has two independent, 16 KiB byte-capped asynchronous pipe readers (32 KiB combined maximum), a 12-second process deadline, and no synchronous exit wait on the Windows Forms tick. A full pipe can block the child until the next tick notices a fault or timeout, but cannot grow the retained buffer. Read `.Result` only after both tasks complete successfully. Unknown or non-installable badges clear the dot, and diagnostics contain no badge JSON or account data. `Add-Type` compiles the helper once at tray startup before the Forms loop; the Windows AST driver loads this function too:

```powershell
function Initialize-UpdateBadgeReader {
  if (([System.Management.Automation.PSTypeName]"TrayUpdateBadgeReader").Type) { return }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public static class TrayUpdateBadgeReader {
  public static async Task<string> ReadAsync(Stream input, int maxBytes) {
    byte[] chunk = new byte[4096];
    using (var content = new MemoryStream()) {
      while (true) {
        int count = await input.ReadAsync(chunk, 0, chunk.Length).ConfigureAwait(false);
        if (count == 0) break;
        if (content.Length + count > maxBytes) throw new InvalidDataException("badge pipe byte cap exceeded");
        content.Write(chunk, 0, count);
      }
      return new UTF8Encoding(false, true).GetString(content.ToArray());
    }
  }
}
'@
}

function Parse-UpdateBadgeText([string]$Text) {
  $lines = @($Text -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($lines.Count -ne 1) { return $null }
  try {
    $badge = $lines[0] | ConvertFrom-Json
    if (($badge.updateAvailable -isnot [bool]) -or ($badge.unknown -isnot [bool]) -or
        ($badge.canUpdate -isnot [bool])) { return $null }
    return [bool]($badge.updateAvailable -and -not $badge.unknown -and $badge.canUpdate)
  } catch { return $null }
}

function Complete-UpdateBadgeProbe {
  $process = $script:updateBadgeProcess
  $script:updateBadgeProcess = $null
  $script:updateBadgeOutputTask = $null
  $script:updateBadgeErrorTask = $null
  $script:updateBadgeTerminating = $false
  if ($null -ne $process) {
    try {
      $process.StandardOutput.Dispose()
      $process.StandardError.Dispose()
      $process.Dispose()
    } catch { Write-ActionLog "update badge probe dispose failed: $($_.Exception.GetType().Name)" }
  }
}

function Stop-UpdateBadgeProbe([switch]$Shutdown) {
  if ($null -eq $script:updateBadgeProcess) { return }
  $script:updateBadgeTerminating = $true
  try {
    if (-not $script:updateBadgeProcess.HasExited) { $script:updateBadgeProcess.Kill() }
  } catch { Write-ActionLog "update badge probe termination failed: $($_.Exception.GetType().Name)" }
  if ($Shutdown) {
    # Only shutdown may wait, and it is bounded; the UI tick never calls this branch.
    try { [void]$script:updateBadgeProcess.WaitForExit(500) } catch { $null = $_ }
    Complete-UpdateBadgeProbe
  }
}

function Start-UpdateBadgeProbe {
  try {
    Initialize-UpdateBadgeReader
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $BunPath
    $psi.Arguments = ((@($CliPath, "__update-badge") | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " ")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.EnvironmentVariables["CODEX_HOME"] = $CodexHome
    $psi.EnvironmentVariables["OPENCODEX_HOME"] = $OpenCodexHome
    if ($BunRuntimeSource) {
      $psi.EnvironmentVariables["OCX_BUN_RUNTIME_SOURCE"] = $BunRuntimeSource
      $psi.EnvironmentVariables["OCX_BUN_RUNTIME_PATH"] = $BunPath
    }
    $script:updateBadgeProcess = [System.Diagnostics.Process]::Start($psi)
    if ($null -eq $script:updateBadgeProcess) { throw "Process did not start" }
    $script:updateBadgeOutputTask = [TrayUpdateBadgeReader]::ReadAsync($script:updateBadgeProcess.StandardOutput.BaseStream, $script:updateBadgeMaxBytesPerStream)
    $script:updateBadgeErrorTask = [TrayUpdateBadgeReader]::ReadAsync($script:updateBadgeProcess.StandardError.BaseStream, $script:updateBadgeMaxBytesPerStream)
    $script:updateBadgeStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } catch {
    Write-ActionLog "update badge probe launch failed: $($_.Exception.GetType().Name)"
    if ($null -ne $script:updateBadgeProcess) { Stop-UpdateBadgeProbe }
  }
}

function Maintain-UpdateBadgeProbe([long]$Now) {
  if ($null -ne $script:updateBadgeProcess) {
    $terminatingAtStart = $script:updateBadgeTerminating
    $expired = ($Now - $script:updateBadgeStarted) -gt $script:updateBadgeTimeoutMs
    $exited = $false
    try { $exited = $script:updateBadgeProcess.HasExited } catch { Stop-UpdateBadgeProbe }
    $drained = ($null -eq $script:updateBadgeOutputTask -or $script:updateBadgeOutputTask.IsCompleted) -and
      ($null -eq $script:updateBadgeErrorTask -or $script:updateBadgeErrorTask.IsCompleted)
    $failedRead = ($null -ne $script:updateBadgeOutputTask -and
      ($script:updateBadgeOutputTask.IsFaulted -or $script:updateBadgeOutputTask.IsCanceled)) -or
      ($null -ne $script:updateBadgeErrorTask -and
      ($script:updateBadgeErrorTask.IsFaulted -or $script:updateBadgeErrorTask.IsCanceled))
    if ($failedRead -and -not $script:updateBadgeTerminating) {
      Write-ActionLog "update badge probe pipe read failed or exceeded byte cap"
      Stop-UpdateBadgeProbe
    }
    if ($script:updateBadgeTerminating) {
      # Reap on a later tick after both bounded readers settle; no replacement starts meanwhile.
      if ($terminatingAtStart -and -not $exited) { Stop-UpdateBadgeProbe }
      if ($terminatingAtStart -and $exited -and $drained) { Complete-UpdateBadgeProbe }
    } elseif ($exited -and $drained -and $null -ne $script:updateBadgeOutputTask -and
        $null -ne $script:updateBadgeErrorTask) {
      $answer = $null
      try {
        if ($script:updateBadgeProcess.ExitCode -eq 0) {
          $answer = Parse-UpdateBadgeText $script:updateBadgeOutputTask.Result
        }
      } catch { Write-ActionLog "update badge probe read failed: $($_.Exception.GetType().Name)" }
      if ($null -ne $answer) {
        $script:updateAvailable = [bool]$answer
        $script:updateBadgeObservedAt = $Now
      }
      Complete-UpdateBadgeProbe
    } elseif ($expired) {
      Write-ActionLog "update badge probe timed out"
      Stop-UpdateBadgeProbe
    }
  }
  if ($script:updateBadgeObservedAt -eq 0 -or
      ($Now - $script:updateBadgeObservedAt) -gt $script:updateBadgeExpiryMs) {
    $script:updateAvailable = $false
  }
  if ($null -eq $script:updateBadgeProcess -and -not $script:updateBadgeTerminating -and
      ($script:updateBadgeAttemptAt -eq 0 -or ($Now - $script:updateBadgeAttemptAt) -ge $script:updateBadgeRefreshMs)) {
    $script:updateBadgeAttemptAt = $Now
    Start-UpdateBadgeProbe
  }
}
```

Inside the existing top-level `try` block at `src/tray/windows-tray.ps1:491-495`, insert `Initialize-UpdateBadgeReader` immediately before `Update-TrayState`, while leaving the surrounding `finally` in place. The first 3-second tick must never pay the C# compilation cost, and a compilation failure still reaches tray/mutex cleanup. Exact opening:

```powershell
try {
  Initialize-UpdateBadgeReader
  Update-TrayState
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
```

Keep the guard in `Start-UpdateBadgeProbe` so direct driver invocation and any future caller still initialize correctly.

`src/tray/windows-tray.ps1:324-325`: after `$now` is computed, call `Maintain-UpdateBadgeProbe $now` *before* the online-only icon branch. This maintains and kills a child while offline too; the probe runs offline so a cached update can remain indicated next to the offline state. Replace the three icon assignments at `:380,383,389` with the following six-state projection; keep the safety label and enabled/disabled proxy controls unchanged:

```powershell
      $notify.Icon = if ($startup.status -eq "at-risk") {
        if ($script:updateAvailable) { $warningUpdateIcon } else { $warningIcon }
      } else {
        if ($script:updateAvailable) { $onlineUpdateIcon } else { $onlineIcon }
      }
```

```powershell
      $notify.Icon = if ($script:updateAvailable) { $warningUpdateIcon } else { $warningIcon }
```

```powershell
    $notify.Icon = if ($script:updateAvailable) { $offlineUpdateIcon } else { $offlineIcon }
```

After the online/offline branch and before pending-action processing, set `$updateItem.Visible = $script:updateAvailable` and `$updateItem.Enabled = $script:updateAvailable`. The safety precedence is online/protected → online, at-risk or safety unknown → warning, offline → offline; the update boolean selects only the dotted variant of that base. Do not use `updateAvailable` to change `$script:online`, restart safety, or the proxy controls. In `finally` at `src/tray/windows-tray.ps1:502-515`, call `Stop-UpdateBadgeProbe -Shutdown` before `$notify.Dispose()`; that branch alone may wait up to 500 ms. All six owned icon instances are already covered by the `ownedIcons` loop at `:516`.

### Tests and registrations

`tests/cli/cli-update-badge.test.ts` (NEW, complete file):

```ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { skipsCodexShimAutoRestore } from "../../src/cli/codex-shim-autorestore";

describe("hidden package update badge command", () => {
  test("is exempt from CLI shim repair, including malformed arguments", () => {
    expect(skipsCodexShimAutoRestore("__update-badge", ["__update-badge"])).toBe(true);
    expect(skipsCodexShimAutoRestore("__update-badge", ["__update-badge", "unexpected"])).toBe(true);
  });

  test("prints one badge JSON document and leaves the cache and home unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-badge-read-"));
    const home = join(directory, "opencodex");
    const codexHome = join(directory, "codex");
    mkdirSync(home);
    mkdirSync(codexHome);
    const cachePath = join(home, "version.json");
    const cache = '{"latest_version":"99.0.0","last_checked_at":"2026-09-24T00:00:00.000Z","tag":"latest"}\n';
    writeFileSync(cachePath, cache);
    try {
      const env = { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codexHome };
      const result = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "__update-badge"], {
        env, encoding: "utf8", timeout: 12_000, maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const lines = result.stdout.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      const badge = JSON.parse(lines[0]!) as Record<string, unknown>;
      for (const field of ["updateAvailable", "unknown", "canUpdate"]) {
        expect(typeof badge[field]).toBe("boolean");
      }
      expect(readFileSync(cachePath, "utf8")).toBe(cache);
      expect(existsSync(join(home, "admin-api-token"))).toBe(false);
      expect(existsSync(join(home, "service-state.json"))).toBe(false);
      expect(existsSync(join(codexHome, "config.toml"))).toBe(false);

      const malformed = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "__update-badge", "unexpected"], {
        env, encoding: "utf8", timeout: 12_000, maxBuffer: 64 * 1024,
      });
      expect(malformed.status).toBe(64);
      expect(malformed.stdout).toBe("");
      expect(readFileSync(cachePath, "utf8")).toBe(cache);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
```

`scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`: insert alphabetically after `cli-transport-honesty.test.ts` and before `cli-usage-hub.test.ts` (current insertion points are `scripts/test-layout/layout.json:457-458` and `tests/fixtures/test-layout-expected.json:283-284`), respectively:

```json
"cli-update-badge.test.ts": "cli"
```

`tests/cli/cli-registry.test.ts:65-94`: add `"__update-badge"` to the sorted hidden list and to `internalRunners`. Exact insertions:

```ts
// In the sorted hidden-name expectation, between __tray-start and the closing bracket:
"__update-badge",
// In internalRunners, after __refresh-version:
"__update-badge",
```

Assertions: registry parity remains exact, the entry is hidden, and dispatch resolves to its runner. `tests/windows/windows-tray.test.ts:375-439,637-647,670-685`: insert the three `Load-TrayIcon` assertions beside the existing three, and add the following tests in the current tray describe block. Use its existing `readFileSync` and `repoPath` imports; the general-suite ICO test must never import `spawnSync` or execute the generator:

```ts
test("update ICOs contain nine valid PNG frames with the base sizes and changed artwork", () => {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function frames(bytes: Buffer): Map<number, Buffer> {
    expect(bytes.length).toBeGreaterThanOrEqual(6 + 16 * sizes.length);
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    expect(bytes.readUInt16LE(4)).toBe(9);
    const found = new Map<number, Buffer>();
    for (let i = 0; i < 9; i += 1) {
      const at = 6 + 16 * i;
      const width = bytes[at] || 256;
      const height = bytes[at + 1] || 256;
      const length = bytes.readUInt32LE(at + 8);
      const offset = bytes.readUInt32LE(at + 12);
      expect(width).toBe(height);
      expect(offset).toBeGreaterThanOrEqual(6 + 16 * 9);
      expect(length).toBeGreaterThanOrEqual(33);
      expect(offset + length).toBeLessThanOrEqual(bytes.length);
      const png = bytes.subarray(offset, offset + length);
      expect(png.subarray(0, 8)).toEqual(signature);
      expect(png.readUInt32BE(8)).toBe(13); // first PNG chunk is IHDR
      expect(png.toString("ascii", 12, 16)).toBe("IHDR");
      expect(png.readUInt32BE(16)).toBe(width);
      expect(png.readUInt32BE(20)).toBe(height);
      expect(found.has(width)).toBe(false);
      found.set(width, png);
    }
    expect([...found.keys()]).toEqual(sizes);
    return found;
  }
  for (const name of ["online", "warning", "offline"]) {
    const asset = (suffix: string) => readFileSync(repoPath("src", "tray", "assets", `opencodex-tray-${name}${suffix}.ico`));
    const base = frames(asset(""));
    const dotted = frames(asset("-update"));
    for (const size of sizes) {
      expect(dotted.get(size)?.equals(base.get(size)!)).toBe(false); // committed dot changes each raster
    }
  }
});

test("badge probe is bounded and selected after safety classification", () => {
  const source = readFileSync(repoPath("src", "tray", "windows-tray.ps1"), "utf8");
  expect(source).toContain('@($CliPath, "__update-badge")');
  expect(source).toContain('$script:updateBadgeRefreshMs = 60000L');
  expect(source).toContain('$script:updateBadgeExpiryMs = 180000L');
  expect(source).toContain('$script:updateBadgeTimeoutMs = 12000L');
  expect(source).toContain('$script:updateBadgeMaxBytesPerStream = 16384');
  expect(source).toContain('[TrayUpdateBadgeReader]::ReadAsync');
  expect(source).toContain('$script:updateBadgeTerminating = $true');
  expect(source).toContain('Stop-UpdateBadgeProbe');
  expect(source.indexOf('Maintain-UpdateBadgeProbe $now')).toBeLessThan(source.indexOf('  if ($script:online) {\n    $statusItem.Text'));
  expect(source.indexOf('  Stop-UpdateBadgeProbe -Shutdown\n  $notify.Dispose()')).toBeGreaterThanOrEqual(0);
  for (const name of ["online", "warning", "offline"]) {
    expect(source).toContain(`Load-TrayIcon "opencodex-tray-${name}-update.ico"`);
  }
});
```

The current PowerShell source assertion at `tests/windows/windows-tray.test.ts:378` expects the old literal `$notify.Icon = $offlineIcon`; replace it with `expect(source).toContain('if ($script:updateAvailable) { $offlineUpdateIcon } else { $offlineIcon }')`. The existing `src/tray/windows.ts` install/rollback loops must still use only `TRAY_ICON_FILES`; add `expect(tray).toContain('opencodex-tray-online-update.ico')` and the analogous warning/offline checks to the existing owned-script test. `tests/windows/tray-proxy.test.ts` currently tests `src/cli/tray-proxy.ts` behavior (`:1-10,27-290`); append a narrow text contract because this task explicitly requires extending it. Add `readFileSync` from `node:fs` and `repoPath` from `../helpers/repo-root`:

```ts
test("update dot preserves base safety icon and opens dashboard", () => {
  const source = readFileSync(repoPath("src", "tray", "windows-tray.ps1"), "utf8");
  expect(source).toContain('if ($startup.status -eq "at-risk") {');
  expect(source).toContain('if ($script:updateAvailable) { $warningUpdateIcon } else { $warningIcon }');
  expect(source).toContain('if ($script:updateAvailable) { $onlineUpdateIcon } else { $onlineIcon }');
  expect(source).toContain('if ($script:updateAvailable) { $offlineUpdateIcon } else { $offlineIcon }');
  expect(source).toContain('$updateItem = $menu.Items.Add("Update available")');
  expect(source).toContain('$updateItem.add_Click({ Start-OcxCommand @("gui") })');
});
```

Extend the *existing* `tests/helpers/windows-tray-probe-lifecycle-driver.ps1` rather than adding another helper. Its current AST loader and Windows process verdict are at `:35-63,110-176`; these are exact edits:

```powershell
# Add four badge cases to the Scenario ValidateSet.
[ValidateSet("Offline", "Online", "BadgeOffline", "BadgeOverflowStdout", "BadgeOverflowStderr", "BadgeStaleFailure")][string]$Scenario = "Offline"
# Append to $wanted:
"Initialize-UpdateBadgeReader", "Parse-UpdateBadgeText", "Complete-UpdateBadgeProbe", "Stop-UpdateBadgeProbe",
"Start-UpdateBadgeProbe", "Maintain-UpdateBadgeProbe"
# Replace the null icon stand-ins with distinct observable values, and append the menu stand-in:
$onlineIcon = "online-base"
$warningIcon = "warning-base"
$offlineIcon = "offline-base"
$onlineUpdateIcon = "online-update"
$warningUpdateIcon = "warning-update"
$offlineUpdateIcon = "offline-update"
$updateItem = [PSCustomObject]@{ Visible = $false; Enabled = $false }
# Append to state initialization:
$script:updateAvailable = $false
$script:updateBadgeObservedAt = 0L
$script:updateBadgeAttemptAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:updateBadgeRefreshMs = 60000L
$script:updateBadgeExpiryMs = 180000L
$script:updateBadgeTimeoutMs = 12000L
$script:updateBadgeMaxBytesPerStream = 16384
$script:updateBadgeProcess = $null
$script:updateBadgeOutputTask = $null
$script:updateBadgeErrorTask = $null
$script:updateBadgeStarted = 0L
$script:updateBadgeTerminating = $false
# After state initialization, seed the stale case as a previously valid offline dot.
# The old observation must not be refreshed by the failed probe.
if ($Scenario -eq "BadgeStaleFailure") {
  $script:updateAvailable = $true
  $script:updateBadgeObservedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $script:updateBadgeExpiryMs - 1000L
  $notify.Icon = $offlineUpdateIcon
  $updateItem.Visible = $true
  $updateItem.Enabled = $true
  if ($notify.Icon -ne "offline-update" -or -not $updateItem.Visible -or -not $updateItem.Enabled) {
    throw "stale case did not start from a dotted icon and available menu"
  }
}
```

The initialized current attempt time suppresses the badge probe in existing `Offline`/`Online` startup-health scenarios, preserving their one-child expectation. Replace driver lines 107-133 (scenario selection through `$watch.Stop()`) with the following. Hung/overflow badge cases retain the terminating process on the first tick, then reap it on later ticks. `BadgeStaleFailure` starts with an offline dotted icon, an available menu item, and an observation over 180 seconds old; its child exits nonzero and both pipe reads settle before the next tick. The probe must leave the old observation untouched, then expiry must clear the icon and menu on that tick. Overflow cases wait for the capped read to fault, with a 5-second test deadline, without backdating the process timeout. Each `Update-TrayState` tick is timed individually:

```powershell
  $badgeCase = $Scenario.StartsWith("Badge")
  if ($badgeCase) {
    $script:updateBadgeAttemptAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Start-UpdateBadgeProbe
    if ($null -eq $script:updateBadgeProcess) { throw "badge probe did not start" }
  } elseif ($Scenario -eq "Online") {
    Update-TrayState
    if (-not $script:online) { throw "online scenario never came online" }
    if ($null -eq $script:startupProbeProcess) { throw "cameOnline gate did not launch a probe" }
  } else {
    Start-StartupHealthProbe
    if ($null -eq $script:startupProbeProcess) { throw "probe did not start" }
  }
  $probe = if ($badgeCase) { $script:updateBadgeProcess } else { $script:startupProbeProcess }
  $childPid = $probe.Id
  $iconBeforeMaintenance = $notify.Icon
  $updateAvailableBeforeMaintenance = $script:updateAvailable
  $observedAtBeforeMaintenance = $script:updateBadgeObservedAt
  $failedProbeExitCode = $null
  if ($Scenario -eq "BadgeStaleFailure") {
    $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 5000
    while ((-not $probe.HasExited -or -not $script:updateBadgeOutputTask.IsCompleted -or
            -not $script:updateBadgeErrorTask.IsCompleted) -and
           [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
      Start-Sleep -Milliseconds 20
    }
    if (-not $probe.HasExited -or -not $script:updateBadgeOutputTask.IsCompleted -or
        -not $script:updateBadgeErrorTask.IsCompleted) { throw "failed badge probe did not settle" }
    $failedProbeExitCode = $probe.ExitCode
    if ($failedProbeExitCode -ne 1) { throw "stale badge probe did not fail with exit 1" }
  } elseif ($Scenario -like "BadgeOverflow*") {
    $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 5000
    $task = if ($Scenario -eq "BadgeOverflowStdout") { $script:updateBadgeOutputTask } else { $script:updateBadgeErrorTask }
    while (-not $task.IsFaulted -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
      Start-Sleep -Milliseconds 20
    }
    if (-not $task.IsFaulted) { throw "badge overflow reader did not enforce the byte cap" }
  } else {
    Start-Sleep -Milliseconds 500
  }
  if ($Scenario -ne "BadgeStaleFailure" -and $probe.HasExited) { throw "probe child exited before maintenance" }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($Scenario -eq "BadgeOffline") {
    $script:updateBadgeStarted = $now - $script:updateBadgeTimeoutMs - 5000
  } elseif (-not $badgeCase) {
    $script:startupProbeStarted = $now - $script:startupProbeTimeoutMs - 5000
  }
  $observedAgeMsAtMaintenance = $now - $observedAtBeforeMaintenance

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  Update-TrayState
  $maintenanceMs = $watch.ElapsedMilliseconds
  $onlineObserved = $script:online
  $iconAfterMaintenance = $notify.Icon
  $updateAvailableAfterMaintenance = $script:updateAvailable
  $observedAtAfterMaintenance = $script:updateBadgeObservedAt
  $updateItemVisibleAfterMaintenance = $updateItem.Visible
  $updateItemEnabledAfterMaintenance = $updateItem.Enabled
  $terminatingAfterMaintenance = if ($badgeCase) { $script:updateBadgeTerminating } else { $false }
  $trackedAfterMaintenance = if ($badgeCase) { $null -ne $script:updateBadgeProcess } else { $false }
  $maxTickMs = $maintenanceMs
  $reapDeadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 2000
  do {
    Start-Sleep -Milliseconds 20
    $tick = [System.Diagnostics.Stopwatch]::StartNew()
    Update-TrayState
    $tick.Stop()
    if ($tick.ElapsedMilliseconds -gt $maxTickMs) { $maxTickMs = $tick.ElapsedMilliseconds }
    $cleared = if ($badgeCase) { $null -eq $script:updateBadgeProcess } else { $null -eq $script:startupProbeProcess }
  } until ($cleared -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $reapDeadline)
  $watch.Stop()
```

In the verdict object replace `probeCleared` and add the badge and projection facts captured before the reaping loop:

```powershell
probeCleared = [bool]$cleared
terminatingAfterMaintenance = [bool]$terminatingAfterMaintenance
trackedAfterMaintenance = [bool]$trackedAfterMaintenance
maxTickMs = $maxTickMs
failedProbeExitCode = $failedProbeExitCode
iconBeforeMaintenance = $iconBeforeMaintenance
updateAvailableBeforeMaintenance = [bool]$updateAvailableBeforeMaintenance
iconAfterMaintenance = $iconAfterMaintenance
updateAvailableAfterMaintenance = [bool]$updateAvailableAfterMaintenance
observedAtBeforeMaintenance = $observedAtBeforeMaintenance
observedAgeMsAtMaintenance = $observedAgeMsAtMaintenance
observedAtAfterMaintenance = $observedAtAfterMaintenance
updateItemVisibleAfterMaintenance = [bool]$updateItemVisibleAfterMaintenance
updateItemEnabledAfterMaintenance = [bool]$updateItemEnabledAfterMaintenance
```

Keep the existing PID-file `launches` count and child-termination check. In the Bun test at `tests/windows/windows-tray.test.ts:457`, rename it to `terminates and later reaps hung, overflowing, or failed tray probes without stacking`, and use `const scenarios = ["Offline", "Online", "BadgeOffline", "BadgeOverflowStdout", "BadgeOverflowStderr", "BadgeStaleFailure"] as const` for the loop. The fake child exits 1 immediately in `BadgeStaleFailure`; other badge cases still hang or overflow. Keep the 30-second outer driver deadline and final PID cleanup. Extend the verdict TypeScript shape with the fields in the following block. Keep the existing `onlineObserved === (scenario === "Online")`, `childTerminated === true`, `probeCleared === true`, and `launches === 1` assertions. Hung/overflow cases assert termination and retained process state; the stale failure case instead asserts exit 1, unchanged old observation, cleared update flag, exact non-dotted icon for the offline safety state, and hidden/disabled menu immediately after the failed probe's next tick. Apply the `< 250` assertion to all `Badge*` cases and retain the current 20-second bound for `Offline`/`Online`.

Replace the test's `hangChild` write with this exact source construction and place the checks after its existing `launches` assertion (the branch-specific timing check replaces the unconditional `totalMs < 20_000` only for badge cases):

```ts
writeFileSync(hangChild, [
  "$pidFile = $env:OCX_PROBE_TEST_PID_FILE",
  "if ($pidFile) { Add-Content -LiteralPath $pidFile -Value $PID }",
  ...(scenario === "BadgeOverflowStdout" ? ["[Console]::Out.Write('x' * 32768)"] : []),
  ...(scenario === "BadgeOverflowStderr" ? ["[Console]::Error.Write('x' * 32768)"] : []),
  ...(scenario === "BadgeStaleFailure" ? ["exit 1"] : ["Start-Sleep -Seconds 120"]),
].join("\r\n"));

// Replace the existing parsed-verdict type with this complete shape.
const verdict = JSON.parse(readFileSync(resultPath, "utf8")) as {
  scenario: string;
  onlineObserved: boolean;
  maintenanceMs: number;
  totalMs: number;
  childPid: number;
  childTerminated: boolean;
  probeCleared: boolean;
  launches: number;
  terminatingAfterMaintenance: boolean;
  trackedAfterMaintenance: boolean;
  maxTickMs: number;
  failedProbeExitCode: number | null;
  iconBeforeMaintenance: string | null;
  updateAvailableBeforeMaintenance: boolean;
  iconAfterMaintenance: string | null;
  updateAvailableAfterMaintenance: boolean;
  observedAtBeforeMaintenance: number;
  observedAgeMsAtMaintenance: number;
  observedAtAfterMaintenance: number;
  updateItemVisibleAfterMaintenance: boolean;
  updateItemEnabledAfterMaintenance: boolean;
};

if (scenario.startsWith("Badge")) {
  expect(verdict.maxTickMs, `${scenario}: UI tick blocked`).toBeLessThan(250);
  if (scenario === "BadgeStaleFailure") {
    expect(verdict.failedProbeExitCode, `${scenario}: probe did not fail`).toBe(1);
    expect(verdict.iconBeforeMaintenance).toBe("offline-update");
    expect(verdict.updateAvailableBeforeMaintenance).toBe(true);
    expect(verdict.observedAtBeforeMaintenance).toBeGreaterThan(0);
    expect(verdict.observedAgeMsAtMaintenance).toBeGreaterThan(180_000);
    expect(verdict.observedAtAfterMaintenance).toBe(verdict.observedAtBeforeMaintenance);
    expect(verdict.updateAvailableAfterMaintenance).toBe(false);
    expect(verdict.iconAfterMaintenance).toBe("offline-base");
    expect(verdict.updateItemVisibleAfterMaintenance).toBe(false);
    expect(verdict.updateItemEnabledAfterMaintenance).toBe(false);
  } else {
    expect(verdict.terminatingAfterMaintenance, `${scenario}: no terminating state after kill`).toBe(true);
    expect(verdict.trackedAfterMaintenance, `${scenario}: disposed on the timeout tick`).toBe(true);
  }
} else {
  expect(verdict.totalMs, `${scenario}: startup-health tick blocked`).toBeLessThan(20_000);
}
```

Test names and required assertions: `hidden package update badge command > is exempt from CLI shim repair, including malformed arguments` (both true); `... > prints one badge JSON document and leaves the cache and home unchanged` (single line, fields, 0/64 exits, no cache/home mutation); `Windows tray > update ICOs contain nine valid PNG frames with the base sizes and changed artwork` (renderer-free structure and raster comparison); `Windows tray > terminates and later reaps hung, overflowing, or failed tray probes without stacking` (Windows child gone, both pipe caps enforced, no replacement before 60 s, each badge tick under 250 ms, stale failure returns to base icon and hides menu); `tray proxy coordinator > update dot preserves base safety icon and opens dashboard` (all six branches, GUI menu action). Any new driver file must be registered only if its basename ends in `.test.ts`; `tests/helpers/` is exempt from test-layout registration. All source-oracle test reads use `repoPath()`/`helperPath()` from `tests/helpers/repo-root.ts` (`tests/windows/windows-tray.test.ts:13`, `:455-456`).

## Field and value chains — PLAN-FIELD-CHAIN-01

| Value or state | Creation | Serialization | Deserialization | Consumers |
| --- | --- | --- | --- | --- |
| Hidden `__update-badge` command | `src/cli/registry.ts`, `src/cli/dispatch.ts` | CLI stdout from `JSON.stringify(readUpdateBadge())` | `Parse-UpdateBadgeText` in `src/tray/windows-tray.ps1` | Tray probe only; `src/cli/codex-shim-autorestore.ts` exemption; `tests/cli/cli-registry.test.ts` parity. No HTTP route. |
| Badge fields `updateAvailable`, `unknown`, `canUpdate` | Commit 1 `src/update/badge.ts:6-17,37-67` | CLI JSON | PowerShell validates three booleans; malformed/extra lines rejected | `updateAvailable && !unknown && canUpdate` sets `updateAvailable`; icon/menu projection. Other badge fields remain in JSON for contract parity, unused by tray. |
| `updateBadgeAttemptAt`, 60 s refresh | `Maintain-UpdateBadgeProbe` before spawn | N/A: process-local timer | N/A | Start guard, including launch failure and timeout; no 3-second retry storm. |
| `updateBadgeObservedAt`, 180 s expiry | Valid exit-0 JSON result only | N/A: process-local timer | N/A | Clears stale update flag/menu/dot despite ongoing failures. |
| `updateBadgeProcess`, output/error tasks, start time, `updateBadgeTerminating` | `Start-UpdateBadgeProbe` and `Stop-UpdateBadgeProbe` | N/A: process-local handles | N/A | Both streams capped at 16 KiB; overflow or 12-second timeout requests Kill on the UI tick, later ticks reap/dispose, no-overlap gate holds throughout; shutdown may wait 500 ms. |
| Three `*-update.ico` names | Generator output and `TRAY_ICON_FILES` | Copy to owned config home (`src/tray/windows.ts:697-699`) | `Load-TrayIcon` | Six-state icon selection, install rollback/uninstall and `src/lib/config-ownership.ts` cleanup recognition. |
| `Update available` menu item | Context-menu construction | N/A: UI object only | N/A | Visibility/enabled from fresh badge boolean; click delegates to existing `gui` action, never runs update. |

## Conditional paths — C-ACTIVATION-GROUNDING-01

| Guard/failure | Activation in test or QA | Observable effect |
| --- | --- | --- |
| No cache, expired commit-1 cache, source/mise install | Temp home without cache; stale fixture; source checkout | CLI JSON has no actionable true badge; tray clears dot/menu. No refresh/write. |
| Extra CLI argument | Invoke `__update-badge unexpected` | Exit 64 and empty stdout before badge read; shim repair remains skipped. |
| Child launch failure, malformed JSON, multiple stdout lines, nonzero exit | Fake CLI path / malformed fixture / exit 1 | Attempt stamped; no new dot; last valid dot may remain only until 180 s expiry; next attempt no sooner than 60 s. |
| Probe exceeds 12 s, process exits before its pipe tasks, or process-inspection throws | Hung fake child and backdated start; inspect terminating state across timed ticks | No blocking `.Result` or `WaitForExit` on a tick; Kill requested, process retained until later reap, no overlapping replacement. |
| Stdout or stderr exceeds 16 KiB | Fake CLI emits 32 KiB on one selected pipe, then sleeps | Reader task faults at byte cap; next tick requests Kill, later ticks reap, no JSON/account data logged, no replacement before 60 s. |
| Stale result after 180 s despite repeated failures | `BadgeStaleFailure` seeds `updateAvailable=true`, `updateBadgeObservedAt` 181 s old, dotted offline icon and visible/enabled menu; fake CLI exits 1, both readers settle, then `Update-TrayState` ticks | Exit 1 does not refresh observed-at; first tick selects exact `offline-base` icon for offline safety, clears update flag, and hides/disables menu. Bun asserts before/after icon, age, unchanged timestamp, and menu state. |
| Safety at-risk or unavailable | Fake startup result `at-risk`/null with update=true | Warning dotted icon; warning remains warning after update clears. |
| Proxy offline | Fake `/healthz` failure with update=true | Offline dotted icon; updater menu remains available because cache is local. |
| Missing/corrupt dotted icon | Remove one owned asset in a tray fixture | `Load-TrayIcon` falls back to that base icon; menu remains based on badge, with no crash. |
| Tray exits during probe | Exit immediately after starting hung child | Child Kill requested, bounded 500 ms shutdown wait, then handles disposed before NotifyIcon/icons/menu disposal. |
| Generator source frame missing/corrupt; generated output drift | Corrupt scratch copy / edit output byte | Generator fails; `--check` exits 1 and names stale variant. |

## Ratchet, documentation, verifier, rollback

`tests/fixtures/file-size-baseline.json` has no per-file entry for any planned growing source/test/script path above; the ratchet's default/new-file limit is 2,000 lines (`scripts/file-size-ratchet.ts:4,114-125`). Current line counts against shared HEAD: `src/cli/registry.ts` 637, `src/cli/dispatch.ts` 1,109, `src/cli/codex-shim-autorestore.ts` 56, `src/tray/windows.ts` 785, `src/tray/windows-tray.ps1` 522, `src/lib/config-ownership.ts` 384, `tests/windows/windows-tray.test.ts` 740, `tests/windows/tray-proxy.test.ts` 290, `tests/cli/cli-registry.test.ts` 153, `tests/helpers/windows-tray-probe-lifecycle-driver.ps1` 178, `scripts/test-layout/layout.json` 1,818, `tests/fixtures/test-layout-expected.json` 1,624. The scanned files therefore have 1,363, 891, 1,215, 1,616, 1,260, 1,710, 1,847, 182, and 376 lines of default-cap headroom respectively for `registry`, `dispatch`, `windows`, `config-ownership`, `windows-tray.test`, `tray-proxy.test`, `cli-registry.test`, `layout.json`, and `test-layout-expected.json`; the listed `.ps1` files are outside the scan. The JSON files remain below 2,000 after their one-line additions. `scripts/generate-windows-tray-update-icons.ts` and `tests/cli/cli-update-badge.test.ts` start at 0 and must each remain below 2,000. No listed path has a baseline cap to apply; the unrelated `tests/codex-integration/codex-shim.test.ts` entry remains 2,388. Recount against the shared HEAD immediately before B. Binary `.ico` and `.ps1` are outside the ratchet scan; `devlog/` is excluded, whereas `.md` elsewhere and `.json` are scanned (`scripts/file-size-ratchet.ts:7-25`).

`structure/runtime.md` is already **600/600 lines** (`structure/manifest.json:3`), so this commit must make a net-zero, replace-in-place edit. On its existing single-line `src/cli/index.ts` table row (`structure/runtime.md:125`), replace the exact sentence pair below; do not insert a row, newline, or paragraph. Keep all other text on that row byte-for-byte, including any commit-1 edits elsewhere in the file. Recount before committing; the resulting file must still be 600 lines:

```text
BEFORE: Windows adds tray. The full command surface is `src/cli/help.ts`; this table names the groups, not every verb.
AFTER:  Windows adds tray. Hidden `__update-badge` prints the read-only package badge JSON without refresh or shim repair for the npm tray. The full command surface is `src/cli/help.ts`; this table names the groups, not every verb.
```

Put the lifecycle detail in `structure/ops/service-and-sidecars.md` after its existing `## Background service command selection` section, before `## Windows startup ownership listing reuse`. Insert this exact paragraph there (the ops page is 256/600 lines today):

```md
## Windows npm tray update badge

The npm Windows tray owns six installed ICOs: online, warning, and offline base safety glyphs plus one blue-dot variant of each. Its hidden `ocx __update-badge` child reads the package cache without refreshing or writing it. The tray samples no more often than every 60 seconds, caps stdout and stderr at 16 KiB each, requests termination after 12 seconds or a pipe overflow, and reaps the child on later Windows Forms ticks before allowing another launch. A successful badge observation expires after 180 seconds; failed reads do not extend it. The **Update available** item opens the dashboard and never installs a package. Shutdown requests child termination, waits at most 500 ms, and disposes the probe before tray UI disposal.
```

Review `structure/gui-and-management-api.md:339-341` for consistency: its statement that the tray owns its icon and delegates actions stays true, so no edit there.

`docs-site/src/content/docs/reference/cli/lifecycle.md:682-686`: append to the `ocx tray` paragraph: “When a newer package version is known, the tray adds a blue dot to its online, warning, or offline icon and shows **Update available**. The tray checks its local cached badge about once a minute; stale or unavailable results remove the dot. The menu item opens the dashboard, where you can start the package update. It does not install automatically.” Add semantically equivalent text in the same `ocx tray` paragraph of each existing `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw` lifecycle sibling. Keep `ocx tray`, **Update available** (actual English UI label), 60 seconds, stale clearing, dashboard navigation, and no automatic install exact in every locale; do not add a public `__update-badge` CLI entry. No GUI i18n catalog key changes: PowerShell owns this Windows Forms string and no `gui/src/i18n/{en,de,fr,ja,ko,ru,tr,vi,zh,zh-TW}.ts` consumer is added.

Verifier ledger for this docs-only P phase (exit codes recorded from commands run now; implementation commands are “runs after B” and have no claimed result):

| Command | When/result | Reads target? |
| --- | --- | --- |
| `bun test tests/windows/windows-tray.test.ts tests/windows/tray-proxy.test.ts tests/cli/cli-registry.test.ts tests/update/update-badge.test.ts` | Run now: exit 0, 62 pass/0 fail, 293 assertions. Re-run after B. | Current tests read current sources, not this `040_...md`; after B they exercise target source. The Windows-only process driver returns early on macOS. |
| `bun run skill:surface:check` | Run now: exit 0, generated skill surface current. Re-run after B. | Reads current capabilities/generated skill; does not read this document. |
| `bun scripts/generate-windows-tray-update-icons.ts --check` | Manual/local verification after B only, with a controlled `rsvg-convert` installation. New script/outputs do not exist now. Never call from the general Bun suite. | Byte-exact generated binary target in that renderer environment. |
| `bun test tests/cli/cli-update-badge.test.ts` | Runs after B; new test does not exist now. | Hidden command implementation. |
| `bun run typecheck` | Run now: exit 0; re-run after B. | Current TypeScript only, not proposed code in this document. |
| `bun run structure:check` | Run now: exit 0, `structure/ SSOT checks passed`; re-run after B, including 600-line runtime budget. | Reads current tracked structure/source topology, not this plan. |
| `bun run privacy:scan` | Run now: exit 0, `Privacy scan passed`; re-run after B. | Reads current repository paths, not the proposed source diff. |
| `cd docs-site && bun run build` | Run now: exit 127, `astro: command not found`; re-run after B with docs-site dependencies installed. | Would read docs-site pages after B, not this plan. |

Receipt, 2026-09-24 after root and GUI dependencies were installed: the focused Bun command above exited **0** (60 pass, 0 fail, 287 assertions across four files). `bun run skill:surface:check` exited **0** (`01_management_surface.md is current`); `bun run typecheck` exited **0**; `bun run structure:check` exited **0**; `bun run privacy:scan` exited **0**. The earlier Python document check exited **0** at 718 lines and 48 balanced fences. `cd docs-site && bun run build` exited **127** because the separate docs-site `astro` binary was absent. These are baseline results before B, not validation of the proposed source. Focused existing tests on macOS cannot execute Windows Forms visual rendering or the win32-only hung-child, overflow, and stale-failure cases; Windows CI and manual 100%/200% tray inspection remain acceptance evidence. Probe duration is measured in Windows CI; 60-second cadence remains binding D6, so an invocation over 12 seconds requires optimization rather than silently increasing the interval.

Auditor-blocker-3 correction receipt, 2026-09-24: the same focused Bun command exited **0** again (60 pass, 0 fail, 287 assertions), but reads only current source and skips Windows process work on macOS. The first attempt to parse every TypeScript fence exited **1** on a pre-existing intentionally incomplete `TRAY_ICON_FILES` fragment. Parsing the touched `BadgeStaleFailure` TypeScript fence alone exited **0**. The direct Python document check exited **0** (804 lines, 48 balanced fence markers, no trailing whitespace); `command -v pwsh` exited **1**, so the proposed PowerShell scenario cannot be executed here. Windows CI must run it after B against the implemented tray code.

Risk: a dot can obscure the smallest base glyph or be cached by Explorer; inspect 16/20 px at 100%/200% and normal/warning/offline on Windows. A slow CLI import can time out; the bounded probe leaves the previous answer until 180 seconds, then clears it. A failed generator, install, or tray launch must preserve/restore the prior three-icon installation through the existing `src/tray/windows.ts` rollback. Roll back commit 4 as one unit: remove the hidden runner/exemption, dotted assets/generator, tray probe/menu code, and related tests/docs; leave commit-1 package cache behavior intact. Installed older tray assets are owned by the existing list logic after repair/uninstall; verify cleanup in Windows CI. No persisted update state or new credential is introduced.

Unresolved for main: `tests/windows/tray-proxy.test.ts` does not currently parse PowerShell; the requested extension is specified above as a narrow source-oracle test. This is a placement choice, not a change to accepted D6. The separate docs-site dependency install is needed before its build can provide evidence. The Windows Forms tick and rendered dot still require Windows CI/manual proof after B.

## wp4 P revalidation

Revalidated against shared HEAD `3b734973912f68a2a478c418fa39839c789c1f9b` on 2026-09-25. The phase design is unchanged.

| `040` lines | Drift found | In-place fix |
| --- | --- | --- |
| 7, 165, 739 | The commit-1 badge implementation moved `readUpdateBadge` to lines 37-67 and the `UpdateBadge` shape to lines 6-17; the document still cited the old 48/19-29,48-74 ranges. | Updated all badge anchors and retained the three-field contract `updateAvailable`, `unknown`, and `canUpdate`. |
| 443 | The two layout files grew after commits 1-3, and the old description did not name the real insertion neighbors. | Changed the insertion point to after `cli-transport-honesty.test.ts` and before `cli-usage-hub.test.ts`, at current lines 457-458 and 283-284. |
| 764 | Current layout counts are 1818 and 1624, rather than the recorded 1813 and 1620. | Recounted all listed paths, recorded default-cap headroom, and kept the 2,000-line rule. |
| 766-781 | `structure/ops/service-and-sidecars.md` is 256/600, not 248/600; the GUI tray ownership sentence is at 339-341, not 334-337. The runtime row still exists at line 125, but the old replacement fragment omitted the current sentence context. | Updated the ops and GUI anchors and made the runtime BEFORE/AFTER replacement target the exact current sentence pair while preserving the required net-zero 600/600 budget. |
| 789 | The current focused suite is 62 pass with 293 assertions, rather than the earlier 60-pass receipt. | Updated the live verifier row; the dated historical receipts remain explicitly historical. |

The unchanged anchors were also checked against HEAD: CLI registry 591-595, dispatch 725-732, root 106-112, shim exemptions 18-31, tray icon loads 41-43, startup probe 137-199, menu 243-252, update state 254-270, tick 313-426, shutdown 491-522, Windows tray ownership/install ranges 18-22, 67-86, 620-621, 659-675, 697-750, config ownership 63-66, icon rendering 13-20 and 140-161, registry tests 65-94, Windows tray tests 375-439/637-647/670-685/457, and the helper ranges 35-63/110-176. The lifecycle documentation target remains 680-686. The hidden command still does not collide with the agent surface: `src/cli/capabilities.ts:1-23` remains the capability data boundary, `scripts/generate-ocx-skill-surface.ts:15` reads only `CAPABILITIES`, and the generated `skills/ocx` surface contains no `__update-badge` entry.

Headroom at this HEAD is: `src/cli/registry.ts` 1363, `src/cli/dispatch.ts` 891, `src/tray/windows.ts` 1215, `src/lib/config-ownership.ts` 1616, `tests/windows/windows-tray.test.ts` 1260, `tests/windows/tray-proxy.test.ts` 1710, `tests/cli/cli-registry.test.ts` 1847, `scripts/test-layout/layout.json` 182, and `tests/fixtures/test-layout-expected.json` 376 lines under the 2,000 default. The two layout files would be 1819 and 1625 after their planned one-line insertions. None of those paths has a file-size baseline entry; the unrelated `tests/codex-integration/codex-shim.test.ts:2388` entry does not apply. The `.ps1` paths remain outside the ratchet extension set. Structure budgets are runtime 600/600, ops 256/600, and GUI 400/600; the planned runtime edit is one-for-one, the ops insertion remains below 600, and the GUI document is unchanged.

Fresh checks against this tree: the focused Bun suite passed 62/62 with 293 assertions; `bun run skill:surface:check`, `bun run typecheck`, `bun run structure:check`, and `bun run privacy:scan` all exited 0. No design change is required.

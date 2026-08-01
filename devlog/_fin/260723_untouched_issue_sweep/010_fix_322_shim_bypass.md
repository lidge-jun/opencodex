# 010 — Fix #322: Shim First-Arg Bypass

## Summary

The codex autostart shim checks only $1 against CODEX_INTERNAL_COMMANDS.
When global flags precede the subcommand (e.g. `codex -s read-only -a untrusted
app-server`), $1 is "-s" and the bypass is missed — ocx ensure runs and
respawns the proxy after every `ocx stop`.

## File Change Map

### src/codex/shim.ts — MODIFY

CODEX_INTERNAL_COMMANDS at line 15 — no change needed.

**Change 1: Unix shim (line ~199) — scan all args before `--`**

Replace first-argument `case "$1"` with a for-loop that scans every arg:

```diff
-case "$1" in
-  ${internalCommands}|--help|-h|--version|-V)
-    ;;
-  *)
-    if [ -z "$OCX_SHIM_BYPASS" ]; then
-      ${shQuote(bunPath)} ${shQuote(cliPath)} ensure >/dev/null 2>&1 || true
-    fi
-    ;;
-esac
+skipEnsure=
+if [ -n "$OCX_SHIM_BYPASS" ]; then
+  skipEnsure=1
+else
+  for arg in "$@"; do
+    case "$arg" in
+      --)
+        break
+        ;;
+      ${internalCommands}|--help|-h|--version|-V)
+        skipEnsure=1
+        break
+        ;;
+    esac
+  done
+fi
+
+if [ -z "$skipEnsure" ]; then
+  ${shQuote(bunPath)} ${shQuote(cliPath)} ensure >/dev/null 2>&1 || true
+fi
```

**Change 2: Windows cmd shim (line ~230-250) — scan with shift loop**

Replace `%~1`-only checks with a `:scan_codex_args` loop using shift:

```diff
 if not "%OCX_SHIM_BYPASS%"=="" goto run_codex
-${internalCommandChecks}
-if /I "%~1"=="--help" goto run_codex
-...
+:scan_codex_args
+if "%~1"=="" goto ensure_ocx
+if "%~1"=="--" goto ensure_ocx
+${internalCommandChecks}
+if /I "%~1"=="--help" goto run_codex
+if /I "%~1"=="-h" goto run_codex
+if /I "%~1"=="--version" goto run_codex
+if /I "%~1"=="-V" goto run_codex
+shift
+goto scan_codex_args
+:ensure_ocx
+"%OCX_BUN%" "%OCX_CLI%" ensure >nul 2>nul
+:run_codex
```

Note: internalCommandChecks already generated, just used inside the loop now.
`%*` preserves original args despite shift (batch behavior).

**Change 3: PowerShell shim (line ~263) — foreach scan**

Replace `$firstArg` single-check with foreach loop:

```diff
-$firstArg = if ($args.Count -gt 0) { [string]$args[0] } else { "" }
-$skipEnsure = $env:OCX_SHIM_BYPASS -or $internalCommands -contains $firstArg ...
+$skipEnsure = [bool]$env:OCX_SHIM_BYPASS
+if (-not $skipEnsure) {
+  foreach ($candidate in $args) {
+    $candidate = [string]$candidate
+    if ($candidate -eq "--") { break }
+    if (($internalCommands -contains $candidate) -or
+        (@("--help", "-h", "--version", "-V") -contains $candidate)) {
+      $skipEnsure = $true
+      break
+    }
+  }
+}
```

### tests/codex-shim.test.ts — MODIFY

Extend existing shim tests (Unix execution ~line 200, Windows builder ~line 235):

Test cases:
- `codex app-server` → no ensure (existing, verify still works)
- `codex -s read-only -a untrusted app-server` → no ensure (THE FIX)
- `codex -s read-only exec hello` → ensure runs (exec not internal)
- `codex hello` / no args → ensure runs
- `codex -s read-only --help` → no ensure
- `codex -- app-server` → ensure runs (after `--` = prompt text)
- `OCX_SHIM_BYPASS=1` → no ensure

## Scope Boundary

- IN: shim.ts Unix/Windows/PS shim generation, shim tests
- OUT: CODEX_INTERNAL_COMMANDS array itself (correct as-is)
- OUT: shim install/uninstall logic

## Edge Cases

- Flags with values (`-s read-only`): scan doesn't try to parse flag values,
  just checks each token for exact match — `read-only` doesn't match any command
- `--flag=value`: complete token doesn't match internal command
- `--` separator: stop scanning, everything after is prompt text
- False positive: flag value named `doctor` could trigger bypass — acceptable
  tradeoff vs. duplicating Codex's option parser in 3 shell languages
- Batch `%*` after shift: batch preserves original args in `%*`

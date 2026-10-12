#!/usr/bin/env bash
set -euo pipefail

app_input="${1:?usage: verify-macos-runtime.sh /path/to/OpenCodex.app}"
app="$(cd "$(dirname "$app_input")" && pwd)/$(basename "$app_input")"
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS bundle verification requires macOS' >&2; exit 1; }
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
[[ -n "$executable" && "$executable" != */* ]] || { echo 'Invalid app executable name' >&2; exit 1; }
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opencodex-bundle-check.XXXXXX")"
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT

codesign --verify --strict --deep "$app"
verify_member() {
  local role="$1" member="$2"
  codesign --display --entitlements - --xml "$member" > "$scratch/$role.plist" 2> "$scratch/$role-entitlements.log"
  codesign --display --verbose=4 "$member" > "$scratch/$role-signature.log" 2>&1
  python3 - "$role" "$scratch/$role.plist" "$scratch/$role-signature.log" <<'PY'
import pathlib, plistlib, re, sys
role, entitlements, signature = sys.argv[1:]
actual = plistlib.loads(pathlib.Path(entitlements).read_bytes())
expected = {"com.apple.security.app-sandbox": True} if role == "widget" else {"com.apple.security.cs.allow-jit": True}
if actual != expected:
    raise SystemExit(f"Unexpected {role} entitlement dictionary")
text = pathlib.Path(signature).read_text()
if not re.search(r"flags=.*\bruntime\b", text):
    raise SystemExit(f"Missing hardened runtime on {role}")
PY
}
verify_member app "$app"
verify_member ocx "$app/Contents/MacOS/ocx"
verify_member widget "$app/Contents/PlugIns/OpenCodexWidget.appex"
# Release stripping removes the nlist symbol table; inspect the loader's bindings.
xcrun llvm-objdump --macho --dyld-info "$app/Contents/MacOS/$executable" > "$scratch/native-symbols.txt"
grep -q NSGlassEffectView "$scratch/native-symbols.txt" || { echo 'Native Liquid Glass code is absent' >&2; exit 1; }
mkdir "$scratch/home"
OPENCODEX_HOME="$scratch/home" "$app/Contents/MacOS/ocx" resolve --json > "$scratch/resolve.json"
python3 - "$scratch/resolve.json" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert value.get("schema") == "ocx-resolve/1", "Unexpected resolve schema"
assert value.get("liveness", {}).get("status") in ("live", "absent-proven"), "Unusable resolve result"
PY

# Reproduce the packaged-keyring boundary from an unrelated cwd. This is deliberately load-only:
# an ad-hoc CI identity can trigger a Keychain consent dialog, while issue #6139 is module resolution.
mkdir -p "$scratch/home" "$scratch/work"
python3 - "$app/Contents/MacOS/ocx" "$scratch/work" "$scratch/home" "$scratch/keyring.json" <<'PY'
import os, pathlib, subprocess, sys
ocx, work, home, output = sys.argv[1:]
env = os.environ.copy()
env.update(HOME=home, OPENCODEX_HOME=str(pathlib.Path(home) / ".opencodex"))
try:
    with open(output, "wb") as stdout:
        subprocess.run(
            [ocx, "__keyring-load-check"], cwd=work, env=env, stdout=stdout,
            stderr=subprocess.PIPE, check=True, timeout=15,
        )
except subprocess.TimeoutExpired as error:
    raise SystemExit("Packaged keyring load probe timed out") from error
except subprocess.CalledProcessError as error:
    sys.stderr.buffer.write((error.stderr or b"")[-4096:])
    raise SystemExit(f"Packaged keyring load probe exited {error.returncode}") from error
PY
python3 - "$scratch/keyring.json" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert value == {"schema": "ocx-keyring-load/1", "available": True}, "Packaged keyring binding is unavailable"
PY
printf '%s\n' 'PASS: macOS signatures, entitlements, hardened runtime, Liquid Glass, bundled CLI resolve and packaged keyring'

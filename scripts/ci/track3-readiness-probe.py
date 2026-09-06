"""Diagnostic-only Windows experiment. Never merge this driver or its source mutations."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path.cwd()
OUT = ROOT / ".tmp" / "readiness-proof"
OUT.mkdir(parents=True, exist_ok=True)
CASE = "an abruptly exited child releases the OS-backed profile transaction"
TEST = Path("tests/codex-integration/native-profile-manager.test.ts")
CHILD = Path("tests/helpers/native-profile-lock-child.ts")
MANAGER = Path("src/codex/native-profile-manager.ts")
SOURCES = [TEST, CHILD, MANAGER]
REVISIONS = [
    ("baseline", "24c761a052957883f9279c291b16194f91affcc3"),
    ("candidate", "93184f64c432311c80966c5ea6dd48ad36fac75f"),
]
WAIT = "await waitForPath(readyPath, child, INTERNAL_DEADLINE_MS);"
FIXED_WAIT = "await waitForPath(readyPath, child, process.platform === \"win32\" ? SPAWN_BUDGET_MS - INTERNAL_DEADLINE_MS : INTERNAL_DEADLINE_MS);"
EXIT_ASSERT = "expect(await child.exited).toBe(87);"
CHILD_ENTRY = "const codexHome = process.env.NATIVE_PROFILE_TEST_CODEX_HOME;"
LOCK_ENTRY = "  private async withLock<T>(operation: () => Promise<T>): Promise<T> {"
MUTANT = '''
    if (process.env.OCX_T3_ABLATE_STALE_LOCK === "1" && process.env.NATIVE_PROFILE_TEST_CRASH !== "1") {
      throw new NativeProfileError("NATIVE_PROFILE_BUSY", "controlled_stale_profile_lock", 409, true);
    }
'''
records = []


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError("Unexpected source oracle occurrence count: " + old)
    return text.replace(old, new, 1)


def execute(label, variant, env):
    started = time.monotonic()
    command = ["bun", "test", "--isolate", "--timeout", "60000", str(TEST), "--test-name-pattern", CASE]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                               encoding="utf-8", errors="replace", env=env)
    try:
        output, _ = process.communicate(timeout=90)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], check=False)
        output, _ = process.communicate(timeout=20)
        (OUT / f"{label}-{variant}.log").write_text(output, encoding="utf-8")
        raise RuntimeError("Owned probe exceeded process bound")
    clean = re.sub(r"\x1b\[[0-9;]*m", "", output)
    (OUT / f"{label}-{variant}.log").write_text(clean, encoding="utf-8")
    observed = any(CASE in line and ("(pass)" in line or "(fail)" in line) for line in clean.splitlines())
    if not observed:
        raise RuntimeError("Requested test was not observed in execution output")
    row = {"revision": label, "variant": variant, "exitCode": process.returncode,
           "elapsedSeconds": round(time.monotonic() - started, 3),
           "childExit87Observed": "T3_CHILD_EXIT_87_CONFIRMED" in clean}
    records.append(row)
    (OUT / "results.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(json.dumps(row), flush=True)
    return process.returncode, clean


for label, revision in REVISIONS:
    # Python has loaded this driver before checkout removes the diagnostic-only file.
    subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "checkout", "--detach", revision], check=True)
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if actual != revision:
        raise RuntimeError("Source revision mismatch")
    subprocess.run(["bun", "install", "--frozen-lockfile"], check=True)
    original = {path: path.read_bytes() for path in SOURCES}
    (OUT / f"{label}-source.json").write_text(json.dumps({
        "sha": actual, "files": {str(p): hashlib.sha256(b).hexdigest() for p, b in original.items()}
    }, indent=2), encoding="utf-8")
    try:
        for variant in ["original-observation", "old-delay", "fixed-delay", "fixed-mutant", "fixed-uninstrumented"]:
            for path, content in original.items():
                path.write_bytes(content)
            test = original[TEST].decode("utf-8")
            if variant.startswith("fixed"):
                test = replace_once(test, WAIT, FIXED_WAIT)
            if variant != "fixed-uninstrumented":
                test = replace_once(test, EXIT_ASSERT, EXIT_ASSERT + '\n    console.log("T3_CHILD_EXIT_87_CONFIRMED");')
            TEST.write_bytes(test.encode("utf-8"))
            if variant in {"old-delay", "fixed-delay", "fixed-mutant"}:
                child = original[CHILD].decode("utf-8")
                child = replace_once(child, CHILD_ENTRY,
                    'console.error("T3_HELPER_DELAY_BEGIN");\nawait Bun.sleep(17_000);\n' + CHILD_ENTRY)
                CHILD.write_bytes(child.encode("utf-8"))
            env = dict(os.environ)
            env.pop("OCX_T3_ABLATE_STALE_LOCK", None)
            if variant == "fixed-mutant":
                manager = original[MANAGER].decode("utf-8")
                MANAGER.write_bytes(replace_once(manager, LOCK_ENTRY, LOCK_ENTRY + MUTANT).encode("utf-8"))
                env["OCX_T3_ABLATE_STALE_LOCK"] = "1"
            code, output = execute(label, variant, env)
            timeout = "Timed out waiting for child marker" in output
            if variant == "original-observation":
                if code != 0 and not timeout:
                    raise RuntimeError("Unexpected original-test failure")
            elif variant == "old-delay":
                if code == 0 or not timeout or "T3_HELPER_DELAY_BEGIN" not in output:
                    raise RuntimeError("Old wait did not reject the controlled healthy delay")
            elif variant == "fixed-mutant":
                if code == 0 or "controlled_stale_profile_lock" not in output or "T3_CHILD_EXIT_87_CONFIRMED" not in output:
                    raise RuntimeError("Successor-denial mutant was not detected after child exit 87")
            elif code != 0:
                raise RuntimeError("Proposed readiness wait did not pass original assertions")
    finally:
        for path, content in original.items():
            path.write_bytes(content)
        if any(path.read_bytes() != content for path, content in original.items()):
            raise RuntimeError("Diagnostic source restoration failed")
print("CONTROLLED_READINESS_PROOF_PASS", flush=True)

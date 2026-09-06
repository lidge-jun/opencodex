"""Remote diagnostic only; no mutation or this workflow belongs in shipping history."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

OUT = Path.cwd() / ".tmp" / "quota-startup-proof"
OUT.mkdir(parents=True, exist_ok=True)
TEST = Path("tests/codex-integration/main-quota-provenance.test.ts")
SOURCE = Path("src/codex/quota.ts")
CASE = "restart beyond six hours retains missing-reset policy evidence only for observed A"
IMPORT = 'import { repoPath, repoRoot } from "../helpers/repo-root";'
TIMEOUT = 'env: process.env, timeout: 10_000,'
FIXED = 'env: process.env, timeout: process.platform === "win32" ? SPAWN_BUDGET_MS - INTERNAL_DEADLINE_MS : 10_000,'
END = '      expect(result.credentialMatches).toBe(false);\n    });'
GUARD = 'if (!mainPolicyQuota || mainPolicyQuota.identityKey !== getObservedMainQuotaIdentityKey()) return null;'
records = []


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise RuntimeError("Source oracle count mismatch: " + before)
    return text.replace(before, after, 1)


def execute(label, variant):
    pattern = "restart beyond six hours retains" if variant == "fixed-uninstrumented" else CASE
    command = ["bun", "test", "--isolate", "--timeout", "60000", str(TEST), "--test-name-pattern", pattern]
    started = time.monotonic()
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, encoding="utf-8", errors="replace")
    try:
        output, _ = child.communicate(timeout=90)
    except subprocess.TimeoutExpired as error:
        partial = error.output or b""
        if isinstance(partial, bytes): partial = partial.decode("utf-8", errors="replace")
        (OUT / f"{label}-{variant}-partial.log").write_text(partial, encoding="utf-8")
        subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], timeout=15, check=False)
        raise RuntimeError("Owned probe exceeded its process bound")
    output = re.sub(r"\x1b\[[0-9;]*m", "", output)
    (OUT / f"{label}-{variant}.log").write_text(output, encoding="utf-8")
    lines = output.splitlines()
    if not any(CASE in line and ("(pass)" in line or "(fail)" in line) for line in lines):
        raise RuntimeError("Requested test did not execute")
    if variant == "fixed-uninstrumented" and not any("future-reset policy evidence only for observed A" in line and "(pass)" in line for line in lines):
        raise RuntimeError("Future-reset sibling was not observed passing")
    infos = [json.loads(line[len("T3_QUOTA_PROCESS="):]) for line in lines if line.startswith("T3_QUOTA_PROCESS=")]
    info = infos[0] if len(infos) == 1 else None
    row = {"revision": label, "variant": variant, "exitCode": child.returncode,
           "elapsedSeconds": round(time.monotonic() - started, 3), "processObservation": info}
    records.append(row)
    (OUT / "results.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(json.dumps(row), flush=True)
    return child.returncode, lines, info


for label, revision in [("baseline", "24c761a052957883f9279c291b16194f91affcc3"),
                        ("candidate", "6401e2393d6214a8d860aec1fbc8019eb8e7734c")]:
    subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "checkout", "--detach", revision], check=True)
    if subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != revision:
        raise RuntimeError("Wrong source revision")
    subprocess.run(["bun", "install", "--frozen-lockfile"], check=True)
    original = {p: p.read_bytes() for p in [TEST, SOURCE]}
    (OUT / f"{label}-source.json").write_text(json.dumps({"sha": revision,
        "files": {str(p): hashlib.sha256(b).hexdigest() for p, b in original.items()}}, indent=2), encoding="utf-8")
    for variant in ["original-observation", "old-delay", "fixed-delay", "identity-mutant", "fixed-uninstrumented"]:
        try:
            test = original[TEST].decode("utf-8")
            if variant in {"fixed-delay", "identity-mutant", "fixed-uninstrumented"}:
                test = replace_once(test, IMPORT, IMPORT + '\nimport { SPAWN_BUDGET_MS, INTERNAL_DEADLINE_MS } from "../helpers/test-budget";')
                test = replace_once(test, TIMEOUT, FIXED)
                test = replace_once(test, END, '      expect(result.credentialMatches).toBe(false);\n    }, SPAWN_BUDGET_MS);')
            if variant != "fixed-uninstrumented":
                test = replace_once(test, '      const child = Bun.spawnSync({', '      const probeStart = performance.now();\n      const child = Bun.spawnSync({')
                test = replace_once(test, '      expect(child.exitCode).toBe(0);', '''      console.log("T3_QUOTA_PROCESS=" + JSON.stringify({ exitCode: child.exitCode, success: child.success,
        signalCode: child.signalCode, expired: child.exitedDueToTimeout,
        elapsedMs: performance.now() - probeStart, stderr: child.stderr.toString().trim() }));
      expect(child.exitCode).toBe(0);
      console.log("T3_QUOTA_EXIT_ZERO_CONFIRMED");''')
                test = replace_once(test, '      expect(result.before).toBeNull();', '      console.log("T3_QUOTA_BEFORE_NULL=" + (result.before === null));\n      expect(result.before).toBeNull();')
            if variant in {"old-delay", "fixed-delay", "identity-mutant"}:
                test = replace_once(test, '        const before = getMainPolicyQuota();', '        console.error("T3_QUOTA_DELAY_BEGIN");\n        await Bun.sleep(12_000);\n        const before = getMainPolicyQuota();')
            TEST.write_bytes(test.encode("utf-8"))
            if variant == "identity-mutant":
                SOURCE.write_bytes(replace_once(original[SOURCE].decode("utf-8"), GUARD, 'if (!mainPolicyQuota) return null;').encode("utf-8"))
            code, lines, info = execute(label, variant)
            if variant == "original-observation":
                if code != 0 and not (info and info.get("exitCode") is None):
                    raise RuntimeError("Unexpected original test failure")
            elif variant == "old-delay":
                expired = info and (info.get("expired") is True or
                    (info.get("exitCode") is None and info.get("elapsedMs", 0) >= 9500))
                if code == 0 or not expired or "T3_QUOTA_DELAY_BEGIN" not in info.get("stderr", "").splitlines():
                    raise RuntimeError("Old process budget did not reject the controlled delay")
            elif variant == "identity-mutant":
                if code == 0 or not info or info.get("exitCode") != 0 or "T3_QUOTA_EXIT_ZERO_CONFIRMED" not in lines or "T3_QUOTA_BEFORE_NULL=false" not in lines or not any(line.startswith("error: expect(received).toBeNull") for line in lines):
                    raise RuntimeError("Identity isolation mutation was not caught by original assertion")
            elif code != 0:
                raise RuntimeError("Fixed process budget did not pass original assertions")
        finally:
            for p, content in original.items(): p.write_bytes(content)
            if any(p.read_bytes() != content for p, content in original.items()):
                raise RuntimeError("Source restoration failed")
print("QUOTA_STARTUP_PROOF_PASS", flush=True)

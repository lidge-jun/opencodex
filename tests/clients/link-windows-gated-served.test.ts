import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { recordServingRuntime } from "../../src/config/serving-runtimes";
import { remoteUpdatePlanArgv } from "../../src/link/child-gated-ocx";
import { LinkSshArgumentError, remoteGatedOcxArgv } from "../../src/link/ssh-argv";
import { POWERSHELL_ENCODED_MAX, windowsNativeArgv, windowsOverwriteSyncArgv, windowsPinnedSyncArgv, windowsScriptData } from "../../src/link/remote-windows";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { windowsServedHome } from "../helpers/windows-served-home";

/**
 * #8359 step 3: Windows link sync and update planning run the install that last started serving the Child, like
 * discovery and runtime inspection already do. Each fixture's Desktop copy is this bun.exe, which reports Bun's
 * version and so fails every gate: a script that picks it instead of the served pair exits 121.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });
const LINK = "lnk_0123456789abcdef";

function served(version: string) {
  const f = windowsServedHome(root => { roots.push(root); }, version);
  recordServingRuntime({ command: [process.execPath, f.entry], version, servedAt: "2026-11-16T00:00:00.000Z" }, f.ocxHome);
  return f;
}

/** The JSON the served entry printed after the stdout delimiter. */
function servedOutput(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  expect(lines[0]).toBe("ocx-fanout:stdout-begin");
  return JSON.parse(lines.slice(1).join("\n"));
}

test.skipIf(process.platform !== "win32")("Windows pinned sync runs the served bun.exe entry pair (#8359)", async () => {
  const f = served("2.99.0");
  const result = await f.run(windowsPinnedSyncArgv(LINK));
  expect(result.code).toBe(0);
  expect(result.stderr.split(/\r?\n/u)).toContain("ocx-fanout:selected:2.99.0");
  expect(servedOutput(result.stdout)).toEqual({ served: true, args: ["sync", "--expect-link", LINK, "--json"], input: "fixture-key-stdin" });
}, SPAWN_BUDGET_MS);

test.skipIf(process.platform !== "win32")("Windows overwrite sync runs the served bun.exe entry pair (#8359)", async () => {
  const f = served("2.101.0");
  const result = await f.run(windowsOverwriteSyncArgv(LINK, true, "codex"));
  expect(result.code).toBe(0);
  expect(result.stderr.split(/\r?\n/u)).toContain("ocx-fanout:selected:2.101.0");
  expect(servedOutput(result.stdout)).toEqual({
    served: true, args: ["sync", "--expect-link", LINK, "--json", "--overwrite-conflict", "--overwrite-client", "codex"], input: "fixture-key-stdin",
  });
}, SPAWN_BUDGET_MS);

test.skipIf(process.platform !== "win32")("the Windows update plan probe plans through the served bun.exe entry pair (#8359)", async () => {
  const f = served("2.101.0");
  const result = await f.run(remoteUpdatePlanArgv("2.101.0", "windows"));
  expect(result.code).toBe(0);
  expect(result.stderr.split(/\r?\n/u)).toContain("ocx-fanout:selected:2.101.0");
  expect(servedOutput(result.stdout)).toEqual({ served: true, args: ["update", "--plan", "--json", "--version", "2.101.0"], input: "fixture-key-stdin" });
}, SPAWN_BUDGET_MS);

test("the packed transport carries every argument byte for any payload length", () => {
  // Each length lands the deflated stream on a different bit offset of the packed characters.
  for (let length = 0; length < 48; length++) {
    const args = ["x".repeat(length), randomBytes(length).toString("hex"), "雪🔥 'q' \"d\""];
    const script = Buffer.from(windowsNativeArgv("C:\\fixture\\ocx.exe", args)[5]!, "base64").toString("utf16le");
    expect(windowsScriptData(script)).toEqual({ executable: "C:\\fixture\\ocx.exe", args });
  }
});

test("the packed payload uses only characters a single-quoted PowerShell literal keeps verbatim", () => {
  const script = Buffer.from(windowsPinnedSyncArgv(LINK)[5]!, "base64").toString("utf16le");
  const packed = /\$ocxPacked='([^']+)'/u.exec(script)![1]!;
  // No ASCII, no smart quotes (U+2018-U+201B, which PowerShell also ends a literal on) and no surrogates.
  expect([...packed].every(ch => ch.charCodeAt(0) >= 0x3400 && ch.charCodeAt(0) <= 0x73ff)).toBe(true);
});

test("every Windows gated command keeps headroom under the cmd.exe budget", () => {
  const longest = "9999.9999.9999-preview.20261111.12345678";
  for (const argv of [windowsPinnedSyncArgv(LINK), windowsOverwriteSyncArgv(LINK, true, "gentle-shell"), remoteUpdatePlanArgv(longest, "windows")]) {
    expect(argv[5]!.length).toBeLessThanOrEqual(POWERSHELL_ENCODED_MAX - 1_000);
  }
});

test("a Windows gated command over the budget throws the named error", () => {
  // Random hex does not deflate, so this argument alone outgrows the cmd.exe command line.
  const args = ["sync", randomBytes(4_000).toString("hex")];
  expect(() => remoteGatedOcxArgv({ minVersion: "2.93.0", lacksMarker: "child-ocx-lacks-expect-link", acceptEphemeral: true, reportEntry: false,
    reportClock: false, launcher: "none", args }, "windows")).toThrow(new LinkSshArgumentError("windows-command-too-long"));
});

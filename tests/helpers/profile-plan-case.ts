import * as fs from "node:fs";
import { dirname, join, relative } from "node:path";
import { spyOn } from "bun:test";
import type { OcxConfig } from "../../src/types";
import { assertNotRealCodexHomeUnderTest, isTestHomeGuardArmed } from "../../src/lib/test-home-guard";

const owned = fs.realpathSync.native(process.env.OCX_TEST_PROFILE_OWNED_HOME!);
const { CODEX_PROFILE_PATH } = await import("../../src/codex/paths");
if (!isTestHomeGuardArmed()) throw new Error("test home guard is not armed");
assertNotRealCodexHomeUnderTest(owned);
if (process.env.OCX_REAL_HOME) {
  let refused = false;
  try { assertNotRealCodexHomeUnderTest(join(process.env.OCX_REAL_HOME, ".codex")); }
  catch (error) {
    if (/refusing to write the real Codex home/.test(String(error))) refused = true;
    else throw error;
  }
  if (!refused) throw new Error("real Codex home guard identity mismatch");
}
if (relative(owned, fs.realpathSync.native(process.env.CODEX_HOME!)) !== "" ||
    relative(owned, fs.realpathSync.native(dirname(CODEX_PROFILE_PATH))) !== "") {
  throw new Error("refusing profile operation outside owned child home");
}

const { deriveCodexInjectionPlan, readCodexProfileSource } = await import("../../src/codex/inject/plan");
const loopback = { baseUrl: "http://127.0.0.1:10100/v1", requiresAdmissionToken: false, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" as const };
const existing = 'stream_idle_timeout_ms = 60000\nfeatures = { fast_mode = false }\n\n[features]\nfast_mode = false\n';
const plan = (fastMode = false) => deriveCodexInjectionPlan('model = "fixture-model"\n', {
  config: fastMode ? { fastMode: true } as OcxConfig : {} as OcxConfig,
  routingTarget: loopback, catalogPathOption: null, journalReadOnly: true,
});
const errorText = (run: () => unknown) => {
  try { run(); return null; } catch (error) { return String(error); }
};
let out: unknown;
switch (process.argv[2]) {
  case "profile-source":
    fs.writeFileSync(CODEX_PROFILE_PATH, existing);
    out = plan(true);
    break;
  case "removed": {
    fs.writeFileSync(CODEX_PROFILE_PATH, "stream_max_retries = 8\n");
    const realRead = fs.readFileSync;
    let removed = false;
    const read = spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (args[0] === CODEX_PROFILE_PATH && !removed) {
        removed = true;
        fs.rmSync(CODEX_PROFILE_PATH);
      }
      return realRead(...args);
    });
    try { out = { plan: plan(), removed }; } finally { read.mockRestore(); }
    break;
  }
  case "reader": {
    const missing = readCodexProfileSource();
    fs.writeFileSync(CODEX_PROFILE_PATH, "stream_max_retries = 8\n");
    const present = readCodexProfileSource();
    fs.rmSync(CODEX_PROFILE_PATH);
    fs.mkdirSync(CODEX_PROFILE_PATH);
    out = { missing, present, error: errorText(() => readCodexProfileSource()) };
    break;
  }
  case "unreadable":
    fs.mkdirSync(CODEX_PROFILE_PATH);
    out = { error: errorText(() => plan()) };
    break;
  default: throw new Error("unknown profile-plan scenario");
}
console.log(JSON.stringify(out));

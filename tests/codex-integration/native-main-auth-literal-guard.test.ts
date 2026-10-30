import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
const ROOT = repoRoot();
const ALLOWED: string[] = [
  "src/cli/codex-launch-auth.ts:36", // launch layer presence probe (lstat), reads no bytes
  "src/cli/doctor.ts:316", // diagnostics presence check, reads no bytes
  "src/codex/auth-api/main-account-probe.ts:164", // presence check, reads no bytes
  "src/codex/auth-collision.ts:132", // reads through readNativeMainAuthBytes of the module
  "src/codex/auth-collision.ts:61", // reads through readNativeMainAuthBytes of the module
  "src/codex/desktop-compatibility/runtime.ts:133", // wires the identity reader of the module
  "src/codex/home.ts:170", // presence check, reads no bytes
  "src/codex/main-account.ts:215", // reads through readNativeMainAuthBytes of the module
  "src/codex/native-profile-manager.ts:1090", // staged-home read through readNativeEnvelope of the module
  "src/codex/native-profile-manager.ts:718", // staged-home cleanup, deletes instead of reading
  "src/codex/native-profile-store.ts:363", // context path; bytes read through readNativeMainAuthBytes
  "src/codex/orca-auth-source.ts:85", // Orca location validation, reads no bytes
  "src/codex/orca-import.ts:106", // native-main login path; bytes read through readNativeMainAuthBytes
  "src/codex/orca-import.ts:152", // Orca account home, not the native-main login
  "src/config.ts:219", // OpenCodex provider store, ACL hardening only
  "src/integrations/hermes-profiles.ts:30", // identity marker list, reads no bytes
  "src/lib/config-ownership.ts:41", // ownership manifest name list, reads no bytes
  "src/local-credentials/inventory.ts:141", // reads through readBounded of the module
  "src/local-credentials/inventory.ts:88", // integrity target list, the read goes through readBounded
  "src/local-credentials/inventory.ts:93", // OpenCodex provider store, not the native-main login
  "src/oauth/command-code.ts:40", // CommandCode store, not the native-main login
  "src/oauth/local-token-detect.ts:16", // Grok store, not the native-main login
  "src/oauth/meta-muse.ts:33", // muse pointer path, not the native-main login
  "src/oauth/store.ts:82", // OpenCodex provider store, not the native-main login
  "src/server/configured-credentials.ts:186", // OpenCodex provider store, not the native-main login
];

test("every auth.json literal line in src matches the file:line allowlist", () => {
  const scan = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? scan(join(dir, entry.name)) : /\.(ts|mts|mjs)$/.test(entry.name) ? [join(dir, entry.name)] : []);
  const found = scan(join(ROOT, "src")).flatMap(file => readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
    line.includes('"auth.json"') || line.includes("'auth.json'") ? [`${file.slice(ROOT.length + 1).replaceAll("\\", "/")}:${index + 1}`] : []));
  expect(found.sort()).toEqual(ALLOWED.slice().sort());
});

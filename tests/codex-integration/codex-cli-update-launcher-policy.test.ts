import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  carriesCodexCliUpdateInspectionContext,
  codexCliInspectionLookupSeeds,
  isCodexCliUpdateInspectionArgv,
  NODE_LAUNCH_CONTEXT_MAX_CHARS,
} from "../../src/update/codex-cli-update-launch-policy.mjs";
import { repoPath } from "../helpers/repo-root";

describe("Codex CLI updater launcher policy", () => {
  test("covers the whole exact namespace including malformed actions", () => {
    expect(isCodexCliUpdateInspectionArgv(["node", "ocx", "system", "codex-cli-update", "check"])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv(["node", "ocx", "system", "codex-cli-update", "bad"])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv([
      "node", "ocx", "--ocx-internal-launch-proof=bad", "system", "codex-cli-update", "check",
    ])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv([
      "node", "ocx", "--ocx-internal-launch-proof=bad", "system", "codex-cli-update", "bad",
    ])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv(["node", "ocx", "system", "update"])).toBe(false);
  });

  test("published start carries only the proof-bound updater snapshot, without becoming a one-shot inspection", () => {
    expect(carriesCodexCliUpdateInspectionContext(["node", "ocx", "start", "--port", "12345"])).toBe(true);
    expect(carriesCodexCliUpdateInspectionContext(["node", "ocx", "--ocx-internal-launch-proof=bad", "start"])).toBe(true);
    expect(carriesCodexCliUpdateInspectionContext(["node", "ocx", "status"])).toBe(false);
    expect(isCodexCliUpdateInspectionArgv(["node", "ocx", "start", "--port", "12345"])).toBe(false);
  });

  test("launcher skips boot repair and lazy Bun installation for this namespace", () => {
    const source = readFileSync(repoPath("bin", "ocx.mjs"), "utf8");
    // Read the guard that actually wraps the probe rather than a fixed pair of adjacent
    // clauses. The boot probe is npm's transactional layout (stage/swap/backup) and pnpm
    // rolls back through its own global path, so the condition list grows; what must not
    // change is that this namespace is excluded from it.
    const probeCall = source.indexOf("const probe = bootRestoreProbe(");
    expect(probeCall).toBeGreaterThan(0);
    const guard = source.slice(source.lastIndexOf("if (", probeCall), probeCall);
    expect(guard).toContain("!codexCliUpdateInspection");
    expect(guard).toContain("isNodeModulesInstall()");
    expect(source).toContain("resolveBun({ allowInstall: !codexCliUpdateInspection })");
    // A missing bundle makes installJs nullable; allowInstall still gates its execution.
    expect(source).toContain(
      'if (allowInstall && installJs && existsSync(installJs)) {\n    const r = probeSpawnSync(process.execPath, [installJs], { stdio: "inherit" });',
    );
  });

  test("lookup seeds are withheld on Windows and dropped — not fatal — on context overflow", () => {
    // Windows never models the POSIX global-module lookup, so the seeds are not
    // sent at all no matter how the ambient environment spells or sizes them;
    // the child's own env copies stay inherited for its general use.
    expect(codexCliInspectionLookupSeeds("win32", "C:\\Users\\u", "C:\\lib;D:\\lib", 100))
      .toEqual({ home: null, nodePath: null });
    // POSIX keeps both seeds whenever the serialized context still fits,
    // including exactly at the reader's limit.
    expect(codexCliInspectionLookupSeeds("linux", "/home/u", "/a:/b", 100))
      .toEqual({ home: "/home/u", nodePath: "/a:/b" });
    expect(codexCliInspectionLookupSeeds("linux", "/h", "/n", NODE_LAUNCH_CONTEXT_MAX_CHARS))
      .toEqual({ home: "/h", nodePath: "/n" });
    // One char over: the seeds are dropped so the selection snapshot survives;
    // the inspection then models no global lane and fails only the content
    // observation closed. A context that overflows even without the seeds is a
    // different, pre-existing refusal — mandatory fields are not dropped here.
    expect(codexCliInspectionLookupSeeds("linux", "/h", "/n", NODE_LAUNCH_CONTEXT_MAX_CHARS + 1))
      .toEqual({ home: null, nodePath: null });
  });

  test("the published launcher measures the serialized context and reserializes dropped seeds", () => {
    const source = readFileSync(repoPath("bin", "ocx.mjs"), "utf8");
    const capture = source.slice(source.indexOf("function createNodeLaunchContext()"), source.indexOf("const child = spawn(bun,"));
    expect(capture).toContain("let launchContext = serializeContext({ home: preBunHome, nodePath: preBunNodePath });");
    expect(capture).toContain("process.platform, preBunHome, preBunNodePath, launchContext.length,");
    expect(capture).toContain("launchContext = serializeContext(lookupSeeds);");
    // HOME/NODE_PATH remain inherited for the child; only the optional proof
    // copy is removed. Every case spelling of the mandatory duplicate fields
    // is removed by the existing lowercase match before spawning.
    expect(capture).toContain('["PATH", "PATHEXT", ...CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS,');
    expect(capture).toContain("...CODEX_CLI_TRANSPORT_ENV_KEYS].map(name => name.toLowerCase())");
    expect(capture).toContain("if (snapshotted.has(name.toLowerCase())) delete inheritedEnv[name];");
    expect(source).toContain("|| (process.platform !== \"win32\" && carriesCodexCliUpdateInspectionContext(process.argv))");
    expect(capture).toContain("codexCliInspectionEnv: codexCliUpdateInspectionContext ? {");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanCodexSessionProcessesAsync } from "../../src/codex/app-server-processes";
import { createCodexCliApplyFixture } from "../helpers/codex-cli-apply-fixture";
import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });
function fixture() {
  const root = createCodexCliTestRoot("ocx-apply-private-"); roots.push(root);
  return createCodexCliApplyFixture(root, process.platform, process.arch);
}
function cli(f: ReturnType<typeof fixture>, args: string[], exitCode = 0) {
  const result = spawnSync(Bun.which("node")!, [repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", ...args, "--json"], {
    cwd: f.root, encoding: "utf8", env: f.env, timeout: 60_000,
  });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(exitCode);
  return JSON.parse(result.stdout);
}

describe.skipIf(process.platform === "win32")("Codex CLI private-prefix POSIX apply", () => {
  test.each([
    ["active", JSON.stringify({ scans: ["active"] }), "blocked_active_session"],
    ["unavailable", JSON.stringify({ scans: ["unavailable"] }), "blocked_process_state_unknown"],
    ["malformed", "not-json", "blocked_process_state_unknown"],
    ["exhausted", JSON.stringify({ scans: [] }), "blocked_process_state_unknown"],
  ])("fixture scan %s keeps the real plan refusal", (_name, state, refusal) => {
    const f = fixture();
    writeFileSync(join(f.root, "process-scan-state.json"), state);
    const plan = cli(f, ["plan"]);
    expect(plan).toMatchObject({ applicable: false, refusal });
    expect(readFileSync(f.trace, "utf8")).toBe("");
  }, 120_000);

  test.each([["active", "blocked_active_session"], ["unavailable", "blocked_process_state_unknown"]] as const)(
    "fixture final scan %s refuses before installer admission", (last, refusal) => {
      const f = fixture();
      const plan = cli(f, ["plan"]);
      expect(plan.applicable).toBe(true);
      writeFileSync(join(f.root, "process-scan-state.json"), JSON.stringify({ scans: ["empty", "empty", last] }));
      const result = cli(f, ["apply", "--plan-id", plan.planId, "--yes"], 1);
      expect(result).toMatchObject({ outcome: "refused", reason: refusal });
      const scans = readFileSync(join(f.root, "process-scan-trace.jsonl"), "utf8").trim().split("\n")
        .map(line => JSON.parse(line) as { value: string; index: number });
      expect(scans).toEqual([{ value: "empty", index: 1 }, { value: "empty", index: 1 },
        { value: "empty", index: 2 }, { value: last, index: 3 }]);
      expect(readFileSync(f.trace, "utf8")).toBe("");
    }, 120_000);

  test("published launcher remains isolated from a real owned Codex-shaped process", async () => {
    const f = fixture();
    const node = Bun.which("node");
    if (!node) throw new Error("fixture node executable unavailable");
    const entry = join(f.root, "codex");
    writeFileSync(entry, 'process.stdout.write("READY\\n"); process.stdin.resume();\n');
    const child = spawn(node, [entry], { cwd: f.root, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      const ready = new Promise<string>((resolve, reject) => {
        let output = "";
        child.stdout!.on("data", chunk => {
          output += String(chunk);
          if (output.includes("\n")) resolve(output);
        });
        child.once("error", reject);
        closed.then(() => reject(new Error("owned fixture process exited before READY")));
      });
      expect(await ready).toBe("READY\n");
      const scan = await scanCodexSessionProcessesAsync();
      expect(scan.kind).toBe("observed");
      if (scan.kind !== "observed") throw new Error("native session scan unavailable");
      expect(scan.processes.some(process => process.pid === child.pid)).toBe(true);
      const bunfig = join(f.root, "bunfig.toml");
      const fixtureConfig = readFileSync(bunfig, "utf8");
      writeFileSync(bunfig, "");
      expect(cli(f, ["plan"])).toMatchObject({ applicable: false, refusal: "blocked_active_session" });
      writeFileSync(bunfig, fixtureConfig);
      const plan = cli(f, ["plan"]);
      expect(plan.applicable).toBe(true);
      const result = cli(f, ["apply", "--plan-id", plan.planId, "--yes"]);
      expect(result).toMatchObject({ status: "applied", outcome: "applied", childState: "terminal" });
      expect(readFileSync(f.trace, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      child.stdin?.end();
      const exit = await closed;
      expect(exit).toEqual({ code: 0, signal: null });
    }
  }, 120_000);

});

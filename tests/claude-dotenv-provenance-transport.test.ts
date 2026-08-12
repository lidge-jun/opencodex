import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PROBE_TIMEOUT_MS = 3_000;

/**
 * Project dotenv can write environment variables before OpenCodex evaluates,
 * but it cannot add the random proof argument emitted by the plain-Node npm
 * launcher. Exercise that split through a real Bun child on every CI platform.
 */
describe("Node launcher context transport", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-launch-context-"));
  const probe = join(dir, "probe.ts");
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "cli", "launcher-context.ts")).href;
  writeFileSync(
    probe,
    `import { initializeNodeLauncherContext } from ${JSON.stringify(moduleUrl)};\n`
      + "const context = initializeNodeLauncherContext();\n"
      + "process.stdout.write(JSON.stringify({ context, args: process.argv.slice(2), contextEnv: process.env.OCX_NODE_LAUNCH_CONTEXT ?? null }));\n",
  );

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const proof = "A".repeat(43);
  const context = JSON.stringify({
    version: 1,
    proof,
    anthropicEnvSlots: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  });

  function run(args: string[], contextEnv: string | undefined) {
    const env = { ...process.env };
    delete env.OCX_PRE_BUN_ANTHROPIC_ENV;
    if (contextEnv === undefined) delete env.OCX_NODE_LAUNCH_CONTEXT;
    else env.OCX_NODE_LAUNCH_CONTEXT = contextEnv;
    const result = spawnSync(process.execPath, [probe, ...args], {
      encoding: "utf8",
      env,
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as {
      context: { anthropicEnvSlots: string[] } | null;
      args: string[];
      contextEnv: string | null;
    };
  }

  test("matching argv proof authenticates and consumes the parent snapshot", () => {
    const seen = run([`--ocx-internal-launch-proof=${proof}`, "claude"], context);
    expect(seen.context?.anthropicEnvSlots).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    expect(seen.args).toEqual(["claude"]);
    expect(seen.contextEnv).toBeNull();
  });

  test("a dotenv-forged context without the argv proof is rejected", () => {
    const seen = run(["claude"], context);
    expect(seen.context).toBeNull();
    expect(seen.args).toEqual(["claude"]);
    expect(seen.contextEnv).toBeNull();
  });

  test("duplicate internal proofs fail closed and are removed from user argv", () => {
    const seen = run([
      `--ocx-internal-launch-proof=${proof}`,
      `--ocx-internal-launch-proof=${proof}`,
      "claude",
    ], context);
    expect(seen.context).toBeNull();
    expect(seen.args).toEqual(["claude"]);
  });
});

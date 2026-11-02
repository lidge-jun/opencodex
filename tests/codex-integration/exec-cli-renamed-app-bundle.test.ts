import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { spawnCodex, type CodexSpawnDeps } from "../../src/cli/codex-launcher";

const root = "/opt/OpenAI/ChatGPT Beta.app";
const binary = `${root}/Contents/Resources/codex`;
const alias = "/usr/local/bin/codex";
let errors: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => { errors = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });

function harness(command: string, backing: boolean, target = binary) {
  let allowed = true;
  const checks: string[][] = [], spawns: string[] = [];
  const deps: CodexSpawnDeps = {
    findOnPath: () => backing ? "/owned/codex-wrapper" : command,
    inspectShim: () => (backing
      ? { status: "matched", selectedRole: "wrapper", backingPath: command }
      : { status: "absent" }) as ReturnType<NonNullable<CodexSpawnDeps["inspectShim"]>>,
    execBoundary: {
      platform: "darwin", executable: () => true,
      // Model a PATH symlink to the canonical member; no conventional bundle alias exists.
      realpath: path => path === command ? target : path,
      macBundleTrustReasonAsync: async (bundle, executable) => {
        checks.push([bundle, executable]);
        return allowed ? null : "signature revoked";
      },
    },
    spawn: ((file: string) => {
      spawns.push(file);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }) as typeof spawn,
  };
  return { deps, checks, spawns, revoke: () => { allowed = false; } };
}

for (const backing of [false, true]) for (const symlink of [false, true]) {
  test(`CLI renamed bundle rechecks revocation: shim backing=${backing}, symlink=${symlink}`, async () => {
    const h = harness(symlink ? alias : binary, backing);
    expect(await spawnCodex(["--version"], {}, h.deps)).toBe(0);
    h.revoke();
    expect(await spawnCodex(["--version"], {}, h.deps)).toBe(1);
    expect(h.checks).toEqual([[root, binary], [root, binary]]);
    expect(h.spawns).toEqual([binary]);
    expect(errors.mock.calls.flat().join(" ")).toContain("signature revoked");
  });
}

test("CLI validates the outer renamed root for a nested app executable", async () => {
  const nested = `${root}/Contents/Resources/CodexCLI.app/Contents/MacOS/codex`;
  const h = harness(alias, true, nested);
  h.revoke();
  expect(await spawnCodex(["app-server"], {}, h.deps)).toBe(1);
  expect(h.checks).toEqual([[root, nested]]);
  expect(h.spawns).toEqual([]);
});

test("CLI refuses an unresolved renamed bundle member before trust or spawn", async () => {
  const h = harness(binary, false);
  h.deps.execBoundary!.realpath = path => path === binary ? null : path;
  expect(await spawnCodex(["--help"], {}, h.deps)).toBe(1);
  expect(h.checks).toEqual([]);
  expect(h.spawns).toEqual([]);
});

test("CLI ordinary executable aliases still bypass bundle verification", async () => {
  const target = "/opt/npm/bin/codex";
  const h = harness(alias, true, target);
  h.revoke();
  expect(await spawnCodex(["--help"], {}, h.deps)).toBe(0);
  expect(h.checks).toEqual([]);
  expect(h.spawns).toEqual([alias]);
});

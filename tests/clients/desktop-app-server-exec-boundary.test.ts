import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildChatgptShimLauncher } from "../../src/chatgpt/app-server-shim/launcher";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const shellTest = process.platform !== "win32" && spawnSync("/bin/bash", ["-c", "exit 0"]).status === 0 ? test : test.skip;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function executable(dir: string, name: string, body: string) {
  const path = join(dir, name); writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755); return path;
}
function fixture(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ocx-app-exec-"));
  try { run(dir); } finally { removeTreeWithRetry(dir); }
}

shellTest("each respawn validates and executes the returned target with original argv, stdin and PID", () => fixture(dir => {
  const trace = join(dir, "trace");
  const recorded = executable(dir, "recorded.sh", "exit 99");
  const verified = executable(dir, "canonical with 'quote.sh", 'printf "PID:%s ARGS:%s\\n" "$$" "$*"\ncat\nexit 7');
  const validator = executable(dir, "validate", `echo validate >> ${quote(trace)}\nprintf '%s\\n' ${quote(verified)}`);
  const launcher = executable(dir, "launcher", buildChatgptShimLauncher([join(dir, "missing-filter")], recorded, [validator]));
  for (let i = 0; i < 2; i++) {
    const out = spawnSync("/bin/bash", [launcher, "app-server", "arg with spaces"], { encoding: "utf8", input: "stdin\n", timeout: 5000 });
    expect(out.error).toBeUndefined(); expect(out.status).toBe(7);
    expect(out.stdout).toBe(`PID:${out.pid} ARGS:app-server arg with spaces\nstdin\n`);
  }
  expect(readFileSync(trace, "utf8")).toBe("validate\nvalidate\n");
}));

shellTest("revocation after launcher creation blocks later execution even when uname says Linux", () => fixture(dir => {
  const marker = join(dir, "spawned"), allow = join(dir, "allowed");
  const real = executable(dir, "real", `echo ran >> ${quote(marker)}`);
  const validator = executable(dir, "validate", `[ -e ${quote(allow)} ] || exit 1\nprintf '%s\\n' "$2"`);
  executable(dir, "uname", "echo Linux");
  const launcher = executable(dir, "launcher", buildChatgptShimLauncher([join(dir, "missing-filter")], real, [validator]));
  const run = () => spawnSync("/bin/bash", [launcher], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 5000 });
  writeFileSync(allow, "allowed");
  expect(run().status).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe("ran\n");
  unlinkSync(allow);
  const out = run();
  expect(out.status).toBe(126); expect(readFileSync(marker, "utf8")).toBe("ran\n");
  expect(out.stderr).toContain("execution verification failed");
}));

for (const status of [0, 1]) shellTest(`filter preflight ${status} cannot bypass the last executable check`, () => fixture(dir => {
  const trace = join(dir, "trace"), marker = join(dir, "spawned");
  executable(dir, "uname", "echo Darwin");
  const real = executable(dir, "real", `echo ran >> ${quote(marker)}`);
  const filter = executable(dir, "filter", `echo filter >> ${quote(trace)}\nexit ${status}`);
  const validator = executable(dir, "validate", `echo validate >> ${quote(trace)}\nexit 1`);
  const launcher = executable(dir, "launcher", buildChatgptShimLauncher([filter], real, [validator]));
  const out = spawnSync("/bin/bash", [launcher], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 5000 });
  expect(out.status).toBe(126); expect(existsSync(marker)).toBe(false);
  expect(readFileSync(trace, "utf8")).toBe("filter\nvalidate\n");
}));

shellTest("missing validator refuses instead of falling back to the unchecked target", () => fixture(dir => {
  const marker = join(dir, "spawned");
  const real = executable(dir, "real", `echo ran >> ${quote(marker)}`);
  const launcher = executable(dir, "launcher", buildChatgptShimLauncher([join(dir, "filter")], real, [join(dir, "missing-validator")]));
  const out = spawnSync("/bin/bash", [launcher], { encoding: "utf8", timeout: 5000 });
  expect(out.status).toBe(126); expect(existsSync(marker)).toBe(false);
}));

shellTest("an empty successful validator result does not authorize the recorded target", () => fixture(dir => {
  const marker = join(dir, "spawned");
  const real = executable(dir, "real", `echo ran >> ${quote(marker)}`);
  const validator = executable(dir, "validate", "exit 0");
  const launcher = executable(dir, "launcher", buildChatgptShimLauncher([join(dir, "filter")], real, [validator]));
  const out = spawnSync("/bin/bash", [launcher], { encoding: "utf8", timeout: 5000 });
  expect(out.status).toBe(126); expect(existsSync(marker)).toBe(false);
}));

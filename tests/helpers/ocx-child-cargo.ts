import { expect } from "bun:test";
import { repoPath } from "./repo-root";
import { rustToolchainEnv } from "./rust-toolchain-env";

/**
 * One `cargo test` run in native/ocx-child, for the TypeScript tests through which CI reaches the crate.
 * Each file that calls it runs alone (SERIAL_FULL_SUITE_FILES in scripts/test.ts) under the batch runner's
 * 120 s process deadline, so a file makes one Cargo run, bounded inside that deadline.
 */
export const OCX_CHILD_CARGO_RUN_MS = 100_000;

export const ocxChildToolchain = rustToolchainEnv("cargo");

/**
 * ocx-child's Cargo tests are not run on Windows. On the hosted Windows runner (dev run 43413601225) the crate built
 * and the real-binary link WebSocket target did not finish inside OCX_CHILD_CARGO_RUN_MS. Nothing else in CI builds
 * or runs ocx-child on Windows either: the remote-helper job's ocx-child step is Linux only, and
 * link-ocx-child-e2e.test.ts skips Windows. Linux and macOS run both Cargo tests.
 */
export const ocxChildCargoUnsupported = process.platform === "win32";

export function ocxChildCargoTest(args: string[]): string {
  const run = Bun.spawnSync([ocxChildToolchain.bin!, "test", "--locked", "--manifest-path", repoPath("native", "ocx-child", "Cargo.toml"), ...args], {
    env: ocxChildToolchain.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: OCX_CHILD_CARGO_RUN_MS,
  });
  // libtest reports each finished case on stdout, so a run cut by the bound shows which cases had not finished.
  if (run.signalCode) throw new Error(`cargo test ${args.join(" ")} ended by ${run.signalCode}:\n${run.stderr.toString()}\nstdout:\n${run.stdout.toString()}`);
  expect(run.exitCode, `${run.stderr.toString()}\ntoolchain: ${ocxChildToolchain.describe()}`).toBe(0);
  return run.stdout.toString();
}

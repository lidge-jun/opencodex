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

export function ocxChildCargoTest(args: string[]): string {
  const run = Bun.spawnSync([ocxChildToolchain.bin!, "test", "--locked", "--manifest-path", repoPath("native", "ocx-child", "Cargo.toml"), ...args], {
    env: ocxChildToolchain.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: OCX_CHILD_CARGO_RUN_MS,
  });
  if (run.signalCode) throw new Error(`cargo test ${args.join(" ")} ended by ${run.signalCode}:\n${run.stderr.toString()}`);
  expect(run.exitCode, `${run.stderr.toString()}\ntoolchain: ${ocxChildToolchain.describe()}`).toBe(0);
  return run.stdout.toString();
}

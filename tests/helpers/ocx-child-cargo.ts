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
 * The two link WebSocket Cargo runs are skipped on Windows. On the hosted Windows runner (dev run 43413601225) the
 * crate built and the real-binary `link_websocket` target did not finish inside OCX_CHILD_CARGO_RUN_MS. The run
 * without the feature is skipped there as a precaution; the gate it proves is a compile-time cfg, closed in every
 * build without the feature on any platform, and Linux and macOS keep proving it. Other Cargo runs of ocx-child
 * (the conformance target in link-ocx-child-conformance.test.ts) still build and run the crate on Windows.
 */
export const ocxChildLinkWsCargoSkipped = process.platform === "win32";

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

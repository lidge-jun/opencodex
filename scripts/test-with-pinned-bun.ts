import { getTestRunnerBun } from "./lib/test-runner-bun";

// Preserve the caller's test arguments, working directory and Bun test configuration.
const child = Bun.spawn([getTestRunnerBun(), "test", ...process.argv.slice(2)], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
const signalExitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
let interruptionExitCode: number | undefined;
const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
  const handler = () => {
    interruptionExitCode ??= signalExitCodes[signal];
    try { child.kill(signal); } catch { /* child already exited */ }
  };
  process.on(signal, handler);
  return { signal, handler };
});
let exitCode: number;
try {
  exitCode = await child.exited;
} finally {
  for (const { signal, handler } of handlers) process.off(signal, handler);
}
process.exit(interruptionExitCode ?? exitCode);

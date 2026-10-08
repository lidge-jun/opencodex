import { getTestRunnerBun } from "./lib/test-runner-bun";

// Preserve the caller's test arguments, working directory and Bun test configuration.
const child = Bun.spawn([getTestRunnerBun(), "test", ...process.argv.slice(2)], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);

import { appendFileSync } from "node:fs";

const pidFile = process.env.OCX_PROBE_TEST_PID_FILE;
if (!pidFile) throw new Error("Missing OCX_PROBE_TEST_PID_FILE");
const scenario = process.env.OCX_PROBE_TEST_SCENARIO;
// Readiness remains observable, including deliberately delayed initialization.
if (scenario === "Online") await Bun.sleep(1500);
appendFileSync(pidFile, `${process.pid}\n`);
if (scenario === "BadgeOverflowStdout") process.stdout.write("x".repeat(32768));
if (scenario === "BadgeOverflowStderr") process.stderr.write("x".repeat(32768));
if (scenario === "BadgeStaleFailure") process.exit(1);
await Bun.sleep(120_000);

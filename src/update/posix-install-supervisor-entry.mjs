import { runPosixInstallerSupervisorMain } from "./posix-install-supervisor.mjs";

runPosixInstallerSupervisorMain().catch(error => {
  console.error("opencodex: installer supervisor failed: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});

import { collectStartupHealth } from "../../src/codex/autostart-health";
import { getCachedStartupHealth } from "../../src/server/startup-health-cache";

if (process.argv[2] === "__startup-health") {
  console.log(JSON.stringify(collectStartupHealth({})));
} else if (process.argv[2] === "cached") {
  console.log(JSON.stringify(await getCachedStartupHealth({})));
} else {
  console.error("unexpected packaged entrypoint", process.argv.slice(2));
  process.exitCode = 2;
}

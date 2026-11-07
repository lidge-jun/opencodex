import { inspectUpdateServiceHome } from "./service-home-authority";
import { isUpdateHomeProbe } from "./service-home-policy.mjs";

// This entry deliberately does not import the CLI root, status collector or launcher.
// --no-env-file is supplied by the Node parent; malformed/old entrypoints are unknown.
if (import.meta.main) {
  if (!isUpdateHomeProbe(process.argv.slice(2))) process.exit(1);
  console.log(JSON.stringify({ schemaVersion: 1, ...inspectUpdateServiceHome() }));
}

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markSiblingStart } from "../../src/codex/sibling-start";
import { startClientRuntime } from "../../src/client/runtime";
import { clientTunnelPidfilePath } from "../../src/client/link-tunnel";
import { getConfigDir } from "../../src/config/paths";

const ownerPort = Number(process.env.OCX_TEST_OWNER_PORT);
const port = Number(process.env.OCX_TEST_CLIENT_PORT);
if (!Number.isInteger(ownerPort) || !Number.isInteger(port)) throw new Error("fixture ports missing");

// The already-owned pidfile makes the real supervisor enter its connected state without
// starting SSH. Removing the sidecar then takes the real onLinkEnded → recycle path.
const pidfile = clientTunnelPidfilePath();
mkdirSync(dirname(pidfile), { recursive: true, mode: 0o700 });
writeFileSync(pidfile, JSON.stringify({
  version: 1,
  linkId: "lnk_0123456789abcdef",
  pid: process.pid,
  ownerPid: process.pid,
  argv: ["fixture-ssh"],
}));
markSiblingStart(ownerPort);
// The production recycle re-enters the CLI. This fixture was the initial process's entrypoint;
// point selfLaunchArgv at the real CLI before the link-end callback spawns its replacement.
process.argv[1] = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
await startClientRuntime({ port, block: false });
await new Promise<void>(resolve => setImmediate(resolve));
writeFileSync(join(getConfigDir(), "client-runtime-ready"), String(process.pid));

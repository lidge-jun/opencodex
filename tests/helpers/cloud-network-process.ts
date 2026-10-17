import { join } from "node:path";
import { serveCloudMapping } from "../../src/chatgpt/cloud-network/helper";
import { CloudHostsMapping } from "../../src/chatgpt/cloud-network/hosts";
import { withCloudHelperLock } from "../../src/chatgpt/cloud-network/helper-system";
import { startCloudNetwork } from "../../src/chatgpt/cloud-network/runtime";
import { applyProxyEnv } from "../../src/config/proxy-env";
import { createChatgptCloudNetworkLifecycle } from "../../src/server/index/chatgpt-cloud-network-lifecycle";

// Test-only subprocess harness. Production internal commands accept none of these fixture paths.
if (import.meta.main) {
  const [role, root, port] = process.argv.slice(2);
  if (!root || !["helper", "runtime"].includes(role!)) throw new Error("Invalid fixture invocation");
  const socketPath = join(root, "helper.sock");
  let finish!: () => void;
  const interrupted = new Promise<void>(resolve => { finish = resolve; });
  process.once("SIGTERM", finish); process.once("SIGINT", finish);
  if (role === "helper") {
    await withCloudHelperLock(root, async () => {
      const mapping = new CloudHostsMapping({ hosts: join(root, "hosts.fixture"), journal: join(root, "state/mapping.pending") }, () => {});
      const helper = await serveCloudMapping({ socketPath, mapping, uid: process.getuid!(), gid: process.getgid!() });
      console.log(JSON.stringify({ ready: true, role }));
      await interrupted;
      await helper.stop();
    });
  } else {
    const config = { providers: {}, defaultProvider: "openai", proxy: `http://127.0.0.1:${port}`, chatgptDesktop: { cloudNetwork: true } };
    applyProxyEnv(config);
    const lifecycle = createChatgptCloudNetworkLifecycle({ platform: "darwin", start: () => startCloudNetwork({ helperSocket: socketPath, listenPort: 0 }) });
    lifecycle.start(config); await lifecycle.settled();
    console.log(JSON.stringify({ ready: lifecycle.status().state === "active", role, network: lifecycle.status() }));
    await interrupted;
    await lifecycle.stop();
  }
}

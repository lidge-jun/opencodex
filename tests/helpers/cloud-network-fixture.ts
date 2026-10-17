import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudHostsMapping } from "../../src/chatgpt/cloud-network/hosts";
import { serveCloudMapping } from "../../src/chatgpt/cloud-network/helper";

export function cloudFixture() {
  // macOS's long per-user temp path exceeds sockaddr_un with a descriptive suffix.
  const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ocn-"));
  mkdirSync(join(root, "state"));
  const hosts = join(root, "hosts.fixture"), journal = join(root, "state/mapping.pending"), socketPath = join(root, "helper.sock");
  writeFileSync(hosts, "127.0.0.1 localhost\n::1 localhost\n", { mode: 0o640 });
  const flushes: string[] = [];
  const mapping = new CloudHostsMapping({ hosts, journal }, () => { flushes.push(readFileSync(hosts, "utf8")); });
  return { root, hosts, journal, socketPath, mapping, flushes,
    read: () => readFileSync(hosts, "utf8"), cleanup: () => rmSync(root, { recursive: true, force: true }),
    startHelper: () => serveCloudMapping({ socketPath, mapping, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
  };
}

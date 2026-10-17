import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloudFixture } from "../helpers/cloud-network-fixture";
import { CloudHostsMapping } from "../../src/chatgpt/cloud-network/hosts";
import { installCloudHelper } from "../../src/chatgpt/cloud-network/install";
import { serveCloudMapping } from "../../src/chatgpt/cloud-network/helper";
import { cloudHelperRequest, acquireCloudMapping } from "../../src/chatgpt/cloud-network/helper-client";
import { CLOUD_HOST, CLOUD_HELPER_LABEL } from "../../src/chatgpt/cloud-network/contract";

test.skipIf(process.platform === "win32")("the real installer copies owned files, starts idle, refuses active uninstall and removes only its files", async () => {
  const f = cloudFixture(), root = join(f.root, "install"), executable = join(f.root, "source-runtime");
  writeFileSync(executable, "fixture-runtime", { mode: 0o755 });
  const mapping = new CloudHostsMapping({ hosts: f.hosts, journal: join(root, "state/mapping.pending") }, () => {});
  let service: Awaited<ReturnType<typeof serveCloudMapping>> | undefined;
  const commands: string[][] = [];
  const uid = process.getuid!(), gid = process.getgid!();
  const options: Parameters<typeof installCloudHelper>[1] = {
    root, parents: [], plist: join(f.root, "launchdaemons/cloud.plist"), plistDirectory: join(f.root, "launchdaemons"),
    socketPath: f.socketPath, uid, gid, owner: uid, executable, standalone: false, mapping,
    bundle: async () => "// bundled helper fixture\n", request: () => cloudHelperRequest("status", f.socketPath),
    launchctl: async args => {
      commands.push(args);
      if (args[0] === "print") return service ? 0 : 113;
      if (args[0] === "bootout") { await service!.stop(); service = undefined; return 0; }
      if (args[0] === "bootstrap") { service = await serveCloudMapping({ socketPath: f.socketPath, mapping, uid, gid }); return 0; }
      throw new Error("unexpected system operation");
    },
  };
  try {
    expect(await installCloudHelper("install", options)).toBe(0);
    expect(readFileSync(join(root, "runtime"), "utf8")).toBe("fixture-runtime");
    expect(statSync(join(root, "runtime")).mode & 0o777).toBe(0o755);
    expect(readFileSync(options.plist, "utf8")).toContain(`${root}/runtime`);
    expect(readFileSync(options.plist, "utf8")).not.toContain(executable);
    expect(f.read()).not.toContain(CLOUD_HOST);
    expect(commands).toEqual([["print", `system/${CLOUD_HELPER_LABEL}`], ["bootstrap", "system", options.plist]]);
    const lease = await acquireCloudMapping(f.socketPath);
    await expect(installCloudHelper("uninstall", options)).rejects.toThrow("disable_cloud_network_before_install_or_uninstall");
    expect(existsSync(join(root, "runtime"))).toBe(true);
    await lease.release();
    expect(await installCloudHelper("uninstall", options)).toBe(0);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(options.plist)).toBe(false);
    expect(readFileSync(executable, "utf8")).toBe("fixture-runtime");
    expect(f.read()).not.toContain(CLOUD_HOST);
  } finally { await service?.stop(); f.cleanup(); }
});

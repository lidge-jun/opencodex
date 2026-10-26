import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";
import { linkKnownHostsPath, linkStorePath } from "../../src/link/paths";
import { classifyRemotePlatform } from "../../src/link/remote-platform";
import { REMOTE_PLATFORM_UNSUPPORTED, WINDOWS_OS_PROBE } from "../../src/link/ssh-argv";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const CMD_REFUSAL = "'sh' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
const POWERSHELL_REFUSAL = "sh : The term 'sh' is not recognized as the name of a cmdlet, function, script file, or operable program.\r\n";
const ok = (stdout: string): SshRunResult => ({ code: 0, stdout, stderr: "" });
const failed = (code: number, stderr: string): SshRunResult => ({ code, stdout: "", stderr });

const ids = { localized: "lnk_0000000000000010", mingw: "lnk_000000000000000a", cmd: "lnk_000000000000000b", ps: "lnk_000000000000000c", linux: "lnk_000000000000000d", down: "lnk_000000000000000e", joined: "lnk_000000000000000f" } as const;
const store: LinkStore = {
  version: 1,
  listenerPort: 56603,
  links: [
    { id: ids.mingw, alias: "mini", direction: "hub-initiated", hostKeyFingerprint: "SHA256:aaaaaaaaaaaaaaaa", tunnelPort: 52889, apiKeyId: "key-mini", createdAt: "2026-10-11T13:35:02.871Z" },
    { id: ids.cmd, alias: "win-cmd", direction: "hub-initiated", hostKeyFingerprint: "SHA256:bbbbbbbbbbbbbbbb", tunnelPort: 52890, apiKeyId: "key-cmd", createdAt: "2026-10-11T13:35:02.871Z" },
    { id: ids.ps, alias: "win-ps", direction: "hub-initiated", hostKeyFingerprint: "SHA256:cccccccccccccccc", tunnelPort: 52891, apiKeyId: "key-ps", createdAt: "2026-10-11T13:35:02.871Z" },
    { id: ids.linux, alias: "studio", direction: "hub-initiated", hostKeyFingerprint: "SHA256:dddddddddddddddd", tunnelPort: 52892, apiKeyId: "key-linux", createdAt: "2026-10-11T13:35:02.871Z" },
    { id: ids.down, alias: "offline", direction: "hub-initiated", hostKeyFingerprint: "SHA256:eeeeeeeeeeeeeeee", tunnelPort: 52893, apiKeyId: "key-down", createdAt: "2026-10-11T13:35:02.871Z" },
    { id: ids.localized, alias: "win-de", direction: "hub-initiated", hostKeyFingerprint: "SHA256:ffffffffffffffff", tunnelPort: 52895, apiKeyId: "key-de", createdAt: "2026-10-11T13:35:02.871Z" },
    { id: ids.joined, alias: "laptop", direction: "client-initiated", hostKeyFingerprint: null, tunnelPort: 52894, apiKeyId: "key-joined", createdAt: "2026-10-11T13:35:02.871Z" },
  ],
};
const answers: Record<string, SshRunResult> = {
  mini: ok("MINGW64_NT-10.0-26200\n"),
  "win-cmd": failed(1, CMD_REFUSAL),
  "win-ps": failed(1, POWERSHELL_REFUSAL),
  studio: ok("Linux\n"),
  "win-de": failed(1, "Die Benennung \"sh\" wurde nicht als Name eines Cmdlet erkannt.\r\n"),
  offline: failed(255, "ssh: connect to host offline port 22: Connection refused\n"),
};

let root: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-cleanup-test-"));
  process.env.OPENCODEX_HOME = root;
  writeLinkStore(linkStorePath(), store);
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

function harness() {
  const calls: (readonly string[])[] = [], out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  const runner: SshRunner = {
    async run(argv) {
      calls.push(argv);
      const alias = argv[argv.indexOf("--") + 1]!;
      // The locale-independent follow-up: only the localized Windows host answers Windows_NT.
      if (argv.at(-1) === WINDOWS_OS_PROBE) return alias === "win-de" ? ok("Windows_NT\r\n") : failed(127, "cmd: not found");
      const answer = answers[alias];
      if (!answer) throw new Error(`unexpected ssh to ${alias}`);
      return answer;
    },
    spawnTunnel() { throw new Error("cleanup must not start a tunnel"); },
  };
  const deps: LinkCliDeps = {
    sshRunner: runner,
    // Cleanup is local: any management request would be a revoke path or a status read it does not need.
    fetchImpl: async () => { throw new Error("cleanup must not call the management API"); },
    findLiveProxy: async () => { throw new Error("cleanup must not discover the proxy"); },
  };
  return { calls, out, err, deps, restore: () => { console.log = log; console.error = error; } };
}

describe("classifyRemotePlatform", () => {
  test.each([
    ["Git Bash uname", ok("MINGW64_NT-10.0-26200\n"), "windows"],
    ["MSYS uname", ok("MSYS_NT-10.0\n"), "windows"],
    ["Cygwin uname", ok("CYGWIN_NT-10.0\n"), "windows"],
    ["ocx prelude status", failed(REMOTE_PLATFORM_UNSUPPORTED, ""), "windows"],
    ["cmd.exe refusal", failed(1, CMD_REFUSAL), "windows"],
    ["PowerShell refusal", failed(1, POWERSHELL_REFUSAL), "windows"],
    ["PowerShell 7 refusal", failed(1, "sh: The term 'sh' is not recognized as a name of a cmdlet, function, script file, or executable program."), "windows"],
    ["Linux", ok("Linux\n"), "posix"],
    ["macOS", ok("Darwin\n"), "posix"],
    ["ssh transport failure", failed(255, "Connection refused"), "unknown"],
    ["empty output", ok(""), "unknown"],
  ] as const)("%s", (_label, result, platform) => {
    expect(classifyRemotePlatform(result)).toBe(platform);
  });
});

describe("ocx link cleanup", () => {
  test("explains every Windows Child with the forced-revoke recovery order and changes nothing", async () => {
    const before = readFileSync(linkStorePath(), "utf8");
    const h = harness(); try {
      expect(await runLinkCommand(["cleanup", "--json"], h.deps)).toBe(0);
      const report = JSON.parse(h.out.join("\n"));
      expect(report.changed).toBe(false);
      expect(report.links.map((entry: { linkId: string; platform: string }) => [entry.linkId, entry.platform])).toEqual([
        [ids.mingw, "windows"], [ids.cmd, "windows"], [ids.ps, "windows"],
        [ids.linux, "posix"], [ids.down, "unknown"], [ids.localized, "windows"], [ids.joined, "not_checked"],
      ]);
      const mini = report.links[0];
      expect(mini.recovery).toEqual([
        "On mini, run 'ocx disconnect' and then 'ocx restart' so it stops using this link.",
        `On this Home, run 'ocx link revoke --link-id ${ids.mingw} --force --yes'. A plain revoke cannot disconnect a Windows Child remotely.`,
        "Then connect mini in Hub mode: run 'ocx hub invite' on a Hub and the printed 'ocx connect' command on mini.",
      ]);
      expect(report.links[3].recovery).toEqual([]);
      expect(report.links[4].reason).toContain("Connection refused");
      // Only Home-initiated records are asked over the link's own trust: one uname each, plus the
      // %OS% follow-up for the one localized refusal (never for ssh's 255 or a Linux answer).
      expect(h.calls).toHaveLength(7);
      expect(h.calls.filter(argv => argv.at(-1) === WINDOWS_OS_PROBE).map(argv => argv[argv.indexOf("--") + 1])).toEqual(["win-de"]);
      for (const argv of h.calls) {
        expect(argv).toContain(`UserKnownHostsFile=${linkKnownHostsPath()}`);
        expect(argv).toContain("StrictHostKeyChecking=yes");
      }
      expect(readFileSync(linkStorePath(), "utf8")).toBe(before);
      expect(h.err).toEqual([]);
    } finally { h.restore(); }
  });

  test("human output names the Windows Child, its steps and that nothing was revoked", async () => {
    const h = harness(); try {
      expect(await runLinkCommand(["cleanup", "--link-id", ids.mingw], h.deps)).toBe(0);
      expect(h.calls).toHaveLength(1);
      expect(h.out[0]).toBe(`${ids.mingw} (mini): Windows Child. Remote Link does not support Windows Children; this link predates that refusal.`);
      expect(h.out.slice(1, 4).every(line => /^  [123]\. /.test(line))).toBe(true);
      expect(h.out.at(-1)).toBe("Nothing was revoked or changed.");
    } finally { h.restore(); }
  });

  test.each([[["--link-id", "lnk_ffffffffffffffff"]], [["--link-id", "bad"]], [["--unknown"]]])("refuses %j before any SSH", async args => {
    const h = harness(); try {
      expect(await runLinkCommand(["cleanup", ...args], h.deps)).toBe(2);
      expect(h.calls).toHaveLength(0);
    } finally { h.restore(); }
  });
});

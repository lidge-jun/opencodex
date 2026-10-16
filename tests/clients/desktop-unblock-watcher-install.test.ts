import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoPath } from "../helpers/repo-root";
import {
  CHATGPT_UNBLOCK_WATCHER_LABEL,
  chatgptUnblockWatcherLoaded,
  chatgptUnblockWatcherStatus,
  installChatgptUnblockWatcher,
  probeChatgptUnblockListener,
  uninstallChatgptUnblockWatcher,
  type LaunchctlRunner,
} from "../../src/chatgpt/desktop-unblock/launch-watcher";
import { CHATGPT_UNBLOCK_SERVICE_ID, startChatgptUnblockListener } from "../../src/chatgpt/desktop-unblock/listener";
import { ensureLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";

let dir: string;
let plistPath: string;
let scriptPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-chatgpt-watcher-"));
  plistPath = join(dir, "agent.plist");
  scriptPath = join(dir, "chatgpt-unblock-watcher.sh");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** launchctl stand-in answering each verb with a fixed status, recording every call. */
function launchctl(statuses: { bootout?: number; bootstrap?: number }): { run: LaunchctlRunner; calls: string[] } {
  const calls: string[] = [];
  const run: LaunchctlRunner = args => {
    calls.push(args[0]!);
    const status = (args[0] === "bootout" ? statuses.bootout : statuses.bootstrap) ?? 0;
    return { ok: status === 0, status, output: status === 0 ? "" : `${args[0]} failed: ${status}: Input/output error` };
  };
  return { run, calls };
}

const install = (run: LaunchctlRunner) =>
  installChatgptUnblockWatcher({ port: 10300, configDir: dir, plistPath, assumeSupported: true, launchctl: run });

describe("chatgpt launch watcher loaded state", () => {
  for (const loaded of [false, true]) {
    test(`reads only the launchd print result (loaded=${loaded})`, () => {
      const calls: string[][] = [];
      const result = chatgptUnblockWatcherLoaded(args => {
        calls.push(args);
        return { ok: loaded, status: loaded ? 0 : 113, output: "" };
      });
      expect(result).toBe(loaded);
      expect(calls).toEqual([["print", `gui/${process.getuid?.() ?? 0}/${CHATGPT_UNBLOCK_WATCHER_LABEL}`]]);
    });
  }
});

describe("chatgpt launch watcher install", () => {
  test("a fresh install unloads nothing, writes both files and loads the agent", () => {
    // 3 = "No such process": nothing of ours was loaded, the normal fresh-install answer.
    const fake = launchctl({ bootout: 3 });
    install(fake.run);
    expect(fake.calls).toEqual(["bootout", "bootstrap"]);
    expect(existsSync(plistPath)).toBe(true);
    expect(existsSync(scriptPath)).toBe(true);
  });

  test.skipIf(process.platform === "win32")("fresh watcher plists match both watched paths and old lock-only plists are stale", () => {
    // Isolate HOME so the real status reader never touches an installed LaunchAgent.
    const child = spawnSync(process.execPath, ["--eval", `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      import {
        buildChatgptUnblockWatcherPlist, chatgptUnblockWatcherPaths,
        chatgptUnblockWatcherStatus, installChatgptUnblockWatcher,
      } from ${JSON.stringify(repoPath("src/chatgpt/desktop-unblock/launch-watcher.ts"))};
      const dir = process.env.HOME;
      const paths = chatgptUnblockWatcherPaths(dir);
      if (!paths.plistPath.startsWith(dir + "/")) throw new Error("test home was not isolated");
      mkdirSync(dirname(paths.plistPath), { recursive: true });
      const results = [];
      for (const entryPort of [undefined, 10301]) {
        installChatgptUnblockWatcher({
          port: 10300, configDir: dir, plistPath: paths.plistPath, entryPort,
          assumeSupported: true, launchctl: () => ({ ok: true, status: 0, output: "" }),
        });
        const pac = entryPort === undefined ? undefined : { entryPort };
        const fresh = chatgptUnblockWatcherStatus(10300, dir, false, pac);
        writeFileSync(paths.plistPath, buildChatgptUnblockWatcherPlist(paths.scriptPath, paths.lockPath, paths.errPath));
        const stale = chatgptUnblockWatcherStatus(10300, dir, false, pac);
        results.push({ fresh: fresh.plistUpToDate, script: fresh.scriptUpToDate, stale: stale.plistUpToDate });
      }
      console.log(JSON.stringify(results));
    `], { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: dir, USERPROFILE: dir } });
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(child.stdout)).toEqual([
      { fresh: true, script: true, stale: false },
      { fresh: true, script: true, stale: false },
    ]);
  });

  test("a failed bootstrap is reported with its diagnostic and leaves nothing behind", () => {
    const fake = launchctl({ bootout: 3, bootstrap: 5 });
    expect(() => install(fake.run)).toThrow("launchctl bootstrap exited 5: bootstrap failed: 5: Input/output error");
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(scriptPath)).toBe(false);
  });

  test("a previous agent that cannot be unloaded stops the install before anything is written", () => {
    const fake = launchctl({ bootout: 5 });
    expect(() => install(fake.run)).toThrow("could not unload the previous watcher");
    expect(fake.calls).toEqual(["bootout"]);
    expect(existsSync(plistPath)).toBe(false);
  });
});

describe("chatgpt launch watcher install (PAC mode)", () => {
  test("installing with an entryPort writes the PAC-mode script that probes the entry", () => {
    const fake = launchctl({ bootout: 3 });
    installChatgptUnblockWatcher({ port: 10300, configDir: dir, plistPath, assumeSupported: true, launchctl: fake.run, entryPort: 10301 });
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, "utf8");
    // The PAC is rebuilt from the file at run time and passed inline (a file:// PAC is ignored).
    expect(script).toContain("--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,");
    expect(script).toContain("chatgpt-unblock.pac");
    expect(script).toContain("PAC_MODE=1");
    expect(script).toContain("127.0.0.1:10301");
    expect(script).toContain("entry_ours");
  });

  test("the PAC-mode script's up-to-date check matches only the same mode", () => {
    const fake = launchctl({ bootout: 3 });
    installChatgptUnblockWatcher({ port: 10300, configDir: dir, plistPath, assumeSupported: true, launchctl: fake.run, entryPort: 10301 });
    expect(chatgptUnblockWatcherStatus(10300, dir, false, { entryPort: 10301 }).scriptUpToDate).toBe(true);
    expect(chatgptUnblockWatcherStatus(10300, dir, false).scriptUpToDate).toBe(false);
  });
});

describe("chatgpt launch watcher uninstall", () => {
  const uninstall = (run: LaunchctlRunner) => uninstallChatgptUnblockWatcher({ configDir: dir, plistPath, launchctl: run });

  test("unloading removes both files", () => {
    install(launchctl({ bootout: 3 }).run);
    uninstall(launchctl({ bootout: 0 }).run);
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(scriptPath)).toBe(false);
  });

  test("an agent that was not loaded still has its files removed", () => {
    install(launchctl({ bootout: 3 }).run);
    uninstall(launchctl({ bootout: 113 }).run);
    expect(existsSync(plistPath)).toBe(false);
  });

  test("a failed unload keeps the files so disk and launchd never disagree", () => {
    install(launchctl({ bootout: 3 }).run);
    expect(() => uninstall(launchctl({ bootout: 5 }).run)).toThrow("watcher files kept");
    expect(existsSync(plistPath)).toBe(true);
    expect(existsSync(scriptPath)).toBe(true);
  });
});

describe("chatgpt listener probe", () => {
  const answering = (body: unknown) => async () => JSON.stringify(body);
  const open = async () => true;

  test("opencodex's listener is recognised and its preserved send blocks reported", async () => {
    const blocks = [{ name: "tpp_send", reason: "work_subscription_required", lastSeen: "2026-09-26T00:00:00.000Z" }];
    const probe = await probeChatgptUnblockListener(10300, answering({ service: CHATGPT_UNBLOCK_SERVICE_ID, preservedSendBlocks: blocks }), open);
    expect(probe).toEqual({ state: "ours", preservedSendBlocks: blocks });
  });

  test("any other answer on the port is a foreign process", async () => {
    expect((await probeChatgptUnblockListener(10300, answering({ service: "something-else" }), open)).state).toBe("foreign");
    expect((await probeChatgptUnblockListener(10300, async () => "<html></html>", open)).state).toBe("foreign");
    // Open port, but no usable HTTP answer: still not ours.
    expect((await probeChatgptUnblockListener(10300, async () => null, open)).state).toBe("foreign");
  });

  test("a closed port means nothing is listening, without asking for identity", async () => {
    let asked = false;
    const request = async () => { asked = true; return "{}"; };
    expect((await probeChatgptUnblockListener(10300, request, async () => false)).state).toBe("down");
    expect(asked).toBe(false);
  });

  test("the default TCP check reports a really closed loopback port as down", async () => {
    const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = socket.port;
    socket.stop(true);
    expect((await probeChatgptUnblockListener(port)).state).toBe("down");
  });

  test("a real listener is recognised even with a proxy in the environment", async () => {
    // Bun's fetch would send this loopback request to HTTPS_PROXY; the probe must not.
    const listener = startChatgptUnblockListener({ leaf: issueLocalInterceptLeaf(ensureLocalInterceptCa(dir), ["chatgpt.com"]) });
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY };
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.HTTP_PROXY = "http://127.0.0.1:9";
    try {
      const probe = await probeChatgptUnblockListener(listener.port!, undefined, undefined, dir);
      expect(probe).toEqual({ state: "ours", preservedSendBlocks: [] });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await listener.stop(true);
    }
  });
});


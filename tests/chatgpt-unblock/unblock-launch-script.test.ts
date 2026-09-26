import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChatgptUnblockWatcherPlist,
  buildChatgptUnblockWatcherScript,
  chatgptCommandLineHasPac,
  chatgptCommandLineHasRule,
} from "../../src/chatgpt/desktop-unblock/launch-watcher";

const PORT = 10300;
const RESOLVER = "--host-resolver-rules=MAP chatgpt.com 127.0.0.1:10300";

const SCUTIL_NO_PROXY = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}`;

// Shape of a VPN client in system-proxy mode (captured from Clash on macOS).
const SCUTIL_SYSTEM_PROXY = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
  }
  HTTPEnable : 1
  HTTPPort : 7892
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7892
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7892
  SOCKSProxy : 127.0.0.1
}`;

const SCUTIL_SOCKS_ONLY = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 10.0.0.2
}`;

const SCUTIL_PAC = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:7890/proxy.pac
  SOCKSEnable : 0
}`;

type AppState = "none" | "plain" | "flagged" | "pac";

const APP_BINARY = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
// A shell whose command line mentions the rule, e.g. someone grepping for it. Matching on
// command lines mistook exactly this for a correctly launched app.
const DECOY = `zsh -c pgrep -f 'ChatGPT.app/Contents/MacOS/ChatGPT .*${RESOLVER}'`;

let stubs: string;
let dir: string;

function stub(name: string, body: string): void {
  const path = join(stubs, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

// Stubs are written once: macOS scans every new executable on first run, which costs ~1s each.
beforeAll(() => {
  stubs = mkdtempSync(join(tmpdir(), "ocx-chatgpt-launch-bin-"));
  // A process table of "pid|name|command" lines; pgrep and ps answer from it like the real ones.
  stub("pgrep", `[ "$1" = -x ] || { echo "stub pgrep only supports -x" >&2; exit 2; }
found=1
while IFS='|' read -r pid name command; do
  [ "$name" = "$2" ] && { echo "$pid"; found=0; }
done < "$STUB_DIR/processes"
exit $found`);
  stub("ps", `pid="\${@: -1}"
while IFS='|' read -r p name command; do
  [ "$p" = "$pid" ] && { echo "$command"; exit 0; }
done < "$STUB_DIR/processes"
exit 1`);
  // The listener's identity path: opencodex answers with its service id, another server with
  // something else, and a closed port makes curl fail. The entry probe fetches through the
  // entry as an HTTP proxy (-x plus a target URL) and answers 0 when the entry is up, a
  // connection-level failure when not. Distinguished by "$6" = -x.
  stub("curl", `if [ "$6" = -x ]; then
  case "$STUB_ENTRY" in
    up) exit 0 ;;
    up56) exit 56 ;;
    *) exit 7 ;;
  esac
fi
case "$STUB_LISTENER" in
  ours) echo '{"service":"opencodex-chatgpt-unblock","preservedSendBlocks":[]}' ;;
  foreign) echo '<html>another server</html>' ;;
  *) exit 7 ;;
esac`);
  stub("scutil", `cat "$STUB_DIR/scutil.txt"`);
  // Quitting removes the app's main process (helpers exit with it only in reality; irrelevant here).
  stub("osascript", `echo quit >> "$STUB_DIR/calls"
if [ "$STUB_QUIT_IGNORED" != 1 ]; then
  grep -v '|ChatGPT|' "$STUB_DIR/processes" > "$STUB_DIR/processes.tmp"
  mv -f "$STUB_DIR/processes.tmp" "$STUB_DIR/processes"
fi`);
  // Records only what follows --args, i.e. what the app itself receives.
  stub("open", `echo open >> "$STUB_DIR/calls"
args=(); after=0
for a in "$@"; do
  if [ $after = 1 ]; then args+=("$a"); elif [ "$a" = --args ]; then after=1; fi
done
[ \${#args[@]} -gt 0 ] && printf '%s\\n' "\${args[@]}" > "$STUB_DIR/open-args"
echo "500|ChatGPT|${APP_BINARY} \${args[*]}" >> "$STUB_DIR/processes"`);
  stub("sleep", ":");
});

afterAll(() => {
  rmSync(stubs, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-chatgpt-launch-"));
  mkdirSync(join(dir, "tmp"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(mode: "watch" | "launch" | "native", options: {
  app: AppState;
  scutil?: string;
  listener?: "ours" | "foreign" | "down";
  quitIgnored?: boolean;
  decoy?: boolean;
  configDir?: string;
  entry?: "up" | "up56" | "down";
  pac?: boolean;
  entryPort?: number;
}) {
  const pacMode = options.pac === true;
  const entryPort = options.entryPort ?? 10301;
  const PAC_ARG = `--proxy-pac-url=file://${options.configDir ?? dir}/chatgpt-unblock.pac`;
  const processes = [
    options.app === "plain" ? `400|ChatGPT|${APP_BINARY}` : null,
    options.app === "flagged" ? `400|ChatGPT|${APP_BINARY} ${RESOLVER} --proxy-bypass-list=chatgpt.com` : null,
    options.app === "pac" ? `400|ChatGPT|${APP_BINARY} ${PAC_ARG}` : null,
    // Helpers share the bundle but not the process name; they must never count as the app.
    options.app !== "none" ? `401|ChatGPT Helper|/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper --type=utility ${RESOLVER}` : null,
    options.decoy ? `300|zsh|${DECOY}` : null,
  ].filter(Boolean);
  writeFileSync(join(dir, "processes"), processes.map(line => `${line}\n`).join(""));
  writeFileSync(join(dir, "scutil.txt"), options.scutil ?? SCUTIL_NO_PROXY);
  const script = join(dir, "launch.sh");
  writeFileSync(script, buildChatgptUnblockWatcherScript(PORT, options.configDir ?? dir, pacMode, entryPort));
  const result = spawnSync("/bin/bash", [script, mode], {
    encoding: "utf8",
    env: {
      PATH: `${stubs}:/usr/bin:/bin`,
      TMPDIR: join(dir, "tmp"),
      STUB_DIR: dir,
      STUB_LISTENER: options.listener ?? "ours",
      STUB_QUIT_IGNORED: options.quitIgnored ? "1" : "0",
      STUB_ENTRY: options.entry ?? (pacMode ? "up" : "n/a"),
    },
  });
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: read("calls").split("\n").filter(Boolean),
    openArgs: read("open-args").split("\n").filter(Boolean),
    log: read("chatgpt-unblock-watcher.log"),
  };
}

describe("chatgpt launch arguments per network mode", () => {
  test("no system proxy: the resolver switch alone", () => {
    const r = run("launch", { app: "none", scutil: SCUTIL_NO_PROXY });
    expect(r.status).toBe(0);
    expect(r.openArgs).toEqual([RESOLVER]);
  });

  test("system proxy: explicit proxy with direct fallback, apex host bypassed", () => {
    const r = run("launch", { app: "none", scutil: SCUTIL_SYSTEM_PROXY });
    expect(r.openArgs).toEqual([
      RESOLVER,
      "--proxy-server=http://127.0.0.1:7892,direct://",
      "--proxy-bypass-list=chatgpt.com",
    ]);
  });

  test("SOCKS-only system proxy is passed as socks5", () => {
    const r = run("launch", { app: "none", scutil: SCUTIL_SOCKS_ONLY });
    expect(r.openArgs).toEqual([
      RESOLVER,
      "--proxy-server=socks5://10.0.0.2:1080,direct://",
      "--proxy-bypass-list=chatgpt.com",
    ]);
  });

  test("PAC proxy: the resolver switch alone, PAC left in charge", () => {
    const r = run("launch", { app: "none", scutil: SCUTIL_PAC });
    expect(r.openArgs).toEqual([RESOLVER]);
  });

  test("unreadable scutil output degrades to the resolver switch alone", () => {
    const r = run("launch", { app: "none", scutil: "" });
    expect(r.openArgs).toEqual([RESOLVER]);
  });
});

describe("chatgpt launch watcher", () => {
  test("a Dock launch without the rule is quit, then relaunched with it", () => {
    const r = run("watch", { app: "plain", scutil: SCUTIL_SYSTEM_PROXY });
    expect(r.status).toBe(0);
    // `open` on a still-running app would only activate it, so quit must come first.
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs[0]).toBe(RESOLVER);
    expect(r.log).toContain("restarting it");
  });

  test("an app already carrying the rule is left alone", () => {
    const r = run("watch", { app: "flagged" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test("the watcher does not start an app that is not running", () => {
    const r = run("watch", { app: "none" });
    expect(r.calls).toEqual([]);
  });

  test("with the intercept not answering the app is left native", () => {
    expect(run("watch", { app: "plain", listener: "down" }).calls).toEqual([]);
    const launch = run("launch", { app: "none", listener: "down" });
    expect(launch.status).toBe(1);
    expect(launch.calls).toEqual([]);
    expect(launch.stderr).toContain("not answering on port 10300");
  });

  test("another process holding the port is never treated as the intercept", () => {
    // Routing the app there would break every chatgpt.com request it makes.
    expect(run("watch", { app: "plain", listener: "foreign" }).calls).toEqual([]);
    expect(run("launch", { app: "none", listener: "foreign" }).status).toBe(1);
  });

  test("a config dir with quotes and ampersands still yields a working script", () => {
    const odd = join(dir, "it's & co");
    mkdirSync(odd);
    const r = run("watch", { app: "plain", configDir: odd });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["quit", "open"]);
    expect(readFileSync(join(odd, "chatgpt-unblock-watcher.log"), "utf8")).toContain("restarting it");
  });

  test("an app that refuses to quit is never re-opened (no activation-only restart loop)", () => {
    const r = run("watch", { app: "plain", quitIgnored: true });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(["quit", "quit", "quit"]);
    expect(r.log).toContain("did not quit");
  });

  test("a shell mentioning the rule is not mistaken for a correctly launched app", () => {
    const r = run("watch", { app: "plain", decoy: true });
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs[0]).toBe(RESOLVER);
  });

  test("a concurrent run holding the lock makes this one a no-op", () => {
    mkdirSync(join(dir, "tmp", "opencodex-chatgpt-launch.lock"));
    const r = run("watch", { app: "plain" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test("the lock is released after a run", () => {
    run("watch", { app: "plain" });
    expect(existsSync(join(dir, "tmp", "opencodex-chatgpt-launch.lock"))).toBe(false);
  });

  test("launch mode reports an already correct app without restarting it", () => {
    const r = run("launch", { app: "flagged" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toContain("already running with the launch switches");
  });
});

describe("chatgpt restore (native networking)", () => {
  test("restore undoes a PAC switch after pacFallback was turned off", () => {
    const r = run("native", { app: "pac" });
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs).toEqual([]);
  });

  test("restore undoes a resolver rule after pacFallback was turned on", () => {
    const r = run("native", { app: "flagged", pac: true });
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs).toEqual([]);
  });

  test("a mapped app is quit and reopened without any arguments", () => {
    const r = run("native", { app: "flagged" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs).toEqual([]);
    expect(r.stdout).toContain("native networking");
  });

  test("restore works while the listener is gone, which is when it is needed", () => {
    const r = run("native", { app: "flagged", listener: "down" });
    expect(r.calls).toEqual(["quit", "open"]);
  });

  test("an app already on native networking, or not running, is left alone", () => {
    expect(run("native", { app: "plain" }).calls).toEqual([]);
    expect(run("native", { app: "none" }).calls).toEqual([]);
  });

  test("an app that refuses to quit is reported, not reopened", () => {
    const r = run("native", { app: "flagged", quitIgnored: true });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(["quit", "quit", "quit"]);
  });
});

describe("chatgpt launch helpers", () => {
  test("the launchd agent runs the script in watch mode", () => {
    const plist = buildChatgptUnblockWatcherPlist("/x/launch.sh", "/x/SingletonLock", "/x/err");
    expect(plist).toContain("<string>/x/launch.sh</string>\n    <string>watch</string>");
  });

  test("plist paths are XML-escaped", () => {
    const plist = buildChatgptUnblockWatcherPlist("/a&b/<launch>.sh", "/x/SingletonLock", "/x/\"err\"");
    expect(plist).toContain("<string>/a&amp;b/&lt;launch&gt;.sh</string>");
    expect(plist).toContain("<string>/x/&quot;err&quot;</string>");
    expect(plist).not.toContain("/a&b");
  });

  test("status counts only the switch form of the rule on the app's command line", () => {
    expect(chatgptCommandLineHasRule(`${APP_BINARY} ${RESOLVER} --proxy-bypass-list=chatgpt.com`, PORT)).toBe(true);
    // The bare rule the original launcher passed is ignored by Chromium; it must not count.
    expect(chatgptCommandLineHasRule(`${APP_BINARY} MAP chatgpt.com 127.0.0.1:10300`, PORT)).toBe(false);
    expect(chatgptCommandLineHasRule(APP_BINARY, PORT)).toBe(false);
    expect(chatgptCommandLineHasRule(`${APP_BINARY} ${RESOLVER.replace("10300", "10301")}`, PORT)).toBe(false);
  });
});

describe("chatgpt launch in PAC-fallback mode", () => {
  test("the app gets the PAC switch alone, whatever the system proxy is", () => {
    for (const scutil of [SCUTIL_NO_PROXY, SCUTIL_SYSTEM_PROXY, SCUTIL_SOCKS_ONLY, SCUTIL_PAC]) {
      const r = run("launch", { app: "none", scutil, pac: true, configDir: dir });
      expect(r.openArgs).toEqual([`--proxy-pac-url=file://${dir}/chatgpt-unblock.pac`]);
    }
  });

  test("watch corrects an app launched under the resolver-rule mode once the PAC is live", () => {
    // A mode change means the app's old switches no longer match the marker: it is corrected.
    const r = run("watch", { app: "flagged", pac: true });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs).toEqual([`--proxy-pac-url=file://${dir}/chatgpt-unblock.pac`]);
  });

  test("an app already carrying the PAC is left alone", () => {
    const r = run("launch", { app: "pac", pac: true });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toContain("already running with the launch switches");
  });

  test("launch refuses with guidance while the entry listener is down", () => {
    const r = run("launch", { app: "none", pac: true, entry: "down" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("entry listener is not answering");
    expect(r.calls).toEqual([]);
  });

  test("watch leaves everything alone when the entry is down (never force a dead route)", () => {
    const r = run("watch", { app: "plain", pac: true, entry: "down" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test("the entry probe accepts curl exit 56 (connected, empty answer) as up", () => {
    const r = run("launch", { app: "none", pac: true, entry: "up56" });
    expect(r.status).toBe(0);
    expect(r.openArgs).toEqual([`--proxy-pac-url=file://${dir}/chatgpt-unblock.pac`]);
  });

  test("the PAC switch on the command line counts as flagged via chatgptCommandLineHasPac", () => {
    expect(chatgptCommandLineHasPac(`${APP_BINARY} --proxy-pac-url=file://${dir}/chatgpt-unblock.pac`, dir)).toBe(true);
    expect(chatgptCommandLineHasPac(APP_BINARY, dir)).toBe(false);
    expect(chatgptCommandLineHasPac(`${APP_BINARY} --proxy-pac-url=file://other/chatgpt-unblock.pac`, dir)).toBe(false);
  });
});

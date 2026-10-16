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
  checkChatgptWatcherScriptSyntax,
} from "../../src/chatgpt/desktop-unblock/launch-watcher";
import { chatgptUnblockPacArgFor } from "../../src/chatgpt/desktop-unblock/runtime";

const PORT = 10300;
const RESOLVER = "--host-resolver-rules=MAP chatgpt.com 127.0.0.1:10300";
const PAC_TEXT = "function FindProxyForURL(url, host) { return \"PROXY 127.0.0.1:10301; DIRECT\"; }\n";
const PAC_SWITCH = chatgptUnblockPacArgFor(PAC_TEXT);

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

const SHIM_PATH = () => `${dir}/chatgpt-codex-shim.sh`;

type AppState = "none" | "plain" | "flagged" | "pac" | "flagged-shim" | "shim-only";

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
  // Like the real one, it skips the caller's ancestors (STUB_ANCESTORS) unless -a is given.
  stub("pgrep", `[ "$1" = -a ] && { ancestors=1; shift; } || ancestors=0
[ "$1" = -x ] && { exact=1; shift; } || exact=0
[ $# -eq 1 ] || { echo "stub pgrep needs exactly one name" >&2; exit 2; }
found=1
while IFS='|' read -r pid name command; do
  if [ "$name" = "$1" ]; then
    if [ $exact = 1 ] || [ "$command" = "$1" ] || [ "\${command##*/ }" = "$1" ]; then
      if [ $ancestors = 0 ]; then case " $STUB_ANCESTORS " in *" $pid "*) continue ;; esac; fi
      echo "$pid"; found=0
    fi
  fi
done < "$STUB_DIR/processes"
exit $found`);
  stub("ps", `pid="\${@: -1}"
case "$*" in *etime=*) [ -n "$STUB_APP_ETIME" ] && { echo "$STUB_APP_ETIME"; exit 0; }; exit 1 ;; esac
while IFS='|' read -r p name command; do
  [ "$p" = "$pid" ] && { echo "$command"; exit 0; }
done < "$STUB_DIR/processes"
exit 1`);
  // Only the loopback identity path is probed; no external service is contacted.
  // The PAC probe requires a successful authenticated CONNECT response, not just TCP presence.
  stub("curl", `[ "$STUB_AFTER_PREFLIGHT_DOWN" = 1 ] && [ -f "$STUB_DIR/preflight-args" ] && exit 7
case " $* " in *" --proxy "*)
  case "$STUB_ENTRY" in
    up) echo '{"service":"opencodex-chatgpt-unblock","preservedSendBlocks":[]}'; exit 0 ;;
    up56) exit 56 ;;
    *) exit 7 ;;
  esac ;;
esac
case "$STUB_LISTENER" in
  ours) echo '{"service":"opencodex-chatgpt-unblock","preservedSendBlocks":[]}' ;;
  foreign) echo '<html>another server</html>' ;;
  *) exit 7 ;;
esac`);
  stub("scutil", `[ "$STUB_SCUTIL_FAILS" = 1 ] && exit 1\ncat "$STUB_DIR/scutil.txt"`);
  stub("base64", `[ "$STUB_PAC_ENCODING_FAILS" = 1 ] && { printf 'partial'; exit 1; }
exec /usr/bin/base64 "$@"`);
  // Quitting removes the app's main process (helpers exit with it only in reality; irrelevant here).
  stub("osascript", `echo quit >> "$STUB_DIR/calls"
printf '%s\\n' "$@" > "$STUB_DIR/quit-all-args"
[ "$STUB_REMOVE_PAC_ON_QUIT" = 1 ] && rm -f "$STUB_PAC_FILE"
if [ "$STUB_QUIT_IGNORED" != 1 ]; then
  grep -v '|ChatGPT|' "$STUB_DIR/processes" > "$STUB_DIR/processes.tmp"
  mv -f "$STUB_DIR/processes.tmp" "$STUB_DIR/processes"
fi`);
  // Records what follows --args (what the app itself receives) and, apart, the --env pairs. The
  // pairs are appended to the process line: `ps eww` shows a process's environment after its command.
  stub("open", `echo open >> "$STUB_DIR/calls"
printf '%s\\n' "$@" > "$STUB_DIR/open-all-args"
[ "$STUB_OPEN_FAILS" = 1 ] && { echo "stub open: cannot launch" >&2; exit 1; }
# What open inherits, separate from the --env pairs it is asked to pass on.
echo "\${CODEX_CLI_PATH-<unset>}" > "$STUB_DIR/open-inherited"
args=(); envs=(); after=0; prev=""
for a in "$@"; do
  if [ $after = 1 ]; then args+=("$a")
  elif [ "$a" = --args ]; then after=1
  elif [ "$prev" = --env ]; then envs+=("$a"); fi
  prev="$a"
done
[ \${#args[@]} -gt 0 ] && printf '%s\\n' "\${args[@]}" > "$STUB_DIR/open-args"
[ \${#envs[@]} -gt 0 ] && printf '%s\\n' "\${envs[@]}" > "$STUB_DIR/open-env"
echo "500|ChatGPT|${APP_BINARY} \${args[*]} \${envs[*]}" >> "$STUB_DIR/processes"`);
  stub("bundle-preflight", `[ "$STUB_BUNDLE_TRUST" != rejected ] || exit 1
printf '%s\\n' "$@" > "$STUB_DIR/preflight-args"`);
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
  scutilFails?: boolean;
  listener?: "ours" | "foreign" | "down";
  quitIgnored?: boolean;
  /** `open` fails, as it does when the bundle is gone or LaunchServices refuses it. */
  openFails?: boolean;
  decoy?: boolean;
  configDir?: string;
  /** Start the app through the app-server shim; a launcher file is written when on. */
  shim?: boolean;
  /** With the shim on, whether its launcher exists (opencodex writes it once the bundle checks pass). */
  launcher?: boolean;
  /** What `ps -o etime=` reports for the app; unset makes the age unreadable. */
  appEtime?: string;
  /** The app is an ancestor of the caller, as for `ocx` run in a terminal inside the app. */
  appIsAncestor?: boolean;
  /** A `CODEX_CLI_PATH` the script inherits, as from a terminal inside a shimmed app. */
  inheritedCliPath?: string;
  /** PAC-fallback mode: the PAC file is written and the script launches through it. */
  pac?: boolean;
  /** PAC mode: what the CONNECT entry probe sees. */
  entry?: "up" | "up56" | "down";
  entryPort?: number;
  /** Synthetic PAC preflight failures; no live application or network is involved. */
  pacFile?: "missing" | "unreadable" | "directory" | "empty";
  pacEncodingFails?: boolean;
  removePacOnQuit?: boolean;
  appPath?: string;
  bundleTrust?: "trusted" | "rejected";
  listenerStopsDuringPreflight?: boolean;
}) {
  const pacFile = join(options.configDir ?? dir, "chatgpt-unblock.pac");
  if (options.pac === true && options.pacFile !== "missing") {
    if (options.pacFile === "directory") mkdirSync(pacFile);
    else {
      writeFileSync(pacFile, options.pacFile === "empty" ? "" : PAC_TEXT);
      if (options.pacFile === "unreadable") chmodSync(pacFile, 0o000);
    }
  }
  const appBinary = `${options.appPath ?? "/Applications/ChatGPT.app"}/Contents/MacOS/ChatGPT`;
  const processes = [
    options.app === "plain" ? `400|ChatGPT|${appBinary}` : null,
    options.app === "flagged" ? `400|ChatGPT|${appBinary} ${RESOLVER} --proxy-bypass-list=chatgpt.com` : null,
    options.app === "pac" ? `400|ChatGPT|${appBinary} ${PAC_SWITCH}` : null,
    options.app === "flagged-shim" ? `400|ChatGPT|${appBinary} ${RESOLVER} --proxy-bypass-list=chatgpt.com CODEX_CLI_PATH=${SHIM_PATH()}` : null,
    options.app === "shim-only" ? `400|ChatGPT|${appBinary} CODEX_CLI_PATH=${SHIM_PATH()}` : null,
    // Helpers share the bundle but not the process name; they must never count as the app.
    options.app !== "none" ? `401|ChatGPT Helper|/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper --type=utility ${RESOLVER}` : null,
    options.decoy ? `300|zsh|${DECOY}` : null,
  ].filter(Boolean);
  writeFileSync(join(dir, "processes"), processes.map(line => `${line}\n`).join(""));
  writeFileSync(join(dir, "scutil.txt"), options.scutil ?? SCUTIL_NO_PROXY);
  if (options.shim === true && options.launcher !== false) {
    writeFileSync(join(options.configDir ?? dir, "chatgpt-codex-shim.sh"), "#!/bin/bash\n", { mode: 0o755 });
  }
  const script = join(dir, "launch.sh");
  writeFileSync(script, buildChatgptUnblockWatcherScript(
    PORT,
    options.configDir ?? dir,
    options.shim === true,
    options.pac === true ? { entryPort: options.entryPort ?? 10301 } : undefined,
    { appPath: options.appPath ?? "/Applications/ChatGPT.app", preflightArgv: [join(stubs, "bundle-preflight")] },
  ));
  const result = spawnSync("/bin/bash", [script, mode], {
    encoding: "utf8",
    env: {
      PATH: `${stubs}:/usr/bin:/bin`,
      TMPDIR: join(dir, "tmp"),
      STUB_DIR: dir,
      STUB_SCUTIL_FAILS: options.scutilFails ? "1" : "0",
      STUB_BUNDLE_TRUST: options.bundleTrust ?? "trusted",
      STUB_AFTER_PREFLIGHT_DOWN: options.listenerStopsDuringPreflight ? "1" : "0",
      STUB_LISTENER: options.listener ?? "ours",
      STUB_QUIT_IGNORED: options.quitIgnored ? "1" : "0",
      STUB_OPEN_FAILS: options.openFails ? "1" : "0",
      STUB_APP_ETIME: options.appEtime ?? "",
      STUB_ANCESTORS: options.appIsAncestor ? "400" : "",
      STUB_ENTRY: options.entry ?? (options.pac === true ? "up" : "n/a"),
      STUB_PAC_ENCODING_FAILS: options.pacEncodingFails ? "1" : "0",
      STUB_REMOVE_PAC_ON_QUIT: options.removePacOnQuit ? "1" : "0",
      STUB_PAC_FILE: pacFile,
      ...(options.inheritedCliPath === undefined ? {} : { CODEX_CLI_PATH: options.inheritedCliPath }),
    },
  });
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: read("calls").split("\n").filter(Boolean),
    openArgs: read("open-args").split("\n").filter(Boolean),
    openAllArgs: read("open-all-args").split("\n").filter(Boolean),
    quitAllArgs: read("quit-all-args").split("\n").filter(Boolean),
    preflightArgs: read("preflight-args").split("\n").filter(Boolean),
    openEnv: read("open-env").split("\n").filter(Boolean),
    openInherited: read("open-inherited").trim(),
    log: read("chatgpt-unblock-watcher.log"),
    processes: read("processes"),
  };
}

describe.skipIf(process.platform === "win32")("chatgpt launch arguments per network mode", () => {
  test("no system proxy: the resolver switch alone", () => {
    const r = run("launch", { app: "none", scutil: SCUTIL_NO_PROXY });
    expect(r.status).toBe(0);
    expect(r.openArgs).toEqual([RESOLVER]);
  });

  test("system proxy: explicit proxy without synthetic direct fallback, apex host bypassed", () => {
    const r = run("launch", { app: "none", scutil: SCUTIL_SYSTEM_PROXY });
    expect(r.openArgs).toEqual([
      RESOLVER,
      "--proxy-server=http://127.0.0.1:7892",
      "--proxy-bypass-list=chatgpt.com",
    ]);
  });

  test("SOCKS-only system proxy is passed as socks5", () => {
    const r = run("launch", { app: "none", scutil: SCUTIL_SOCKS_ONLY });
    expect(r.openArgs).toEqual([
      RESOLVER,
      "--proxy-server=socks5://10.0.0.2:1080",
      "--proxy-bypass-list=chatgpt.com",
    ]);
  });

  for (const host of ["::1", "[::1]"]) {
    test(`IPv6 system proxy is bracketed once (${host})`, () => {
      const r = run("launch", { app: "none", scutil: SCUTIL_SYSTEM_PROXY.replace("HTTPSProxy : 127.0.0.1", `HTTPSProxy : ${host}`) });
      expect(r.status).toBe(0);
      expect(r.openArgs).toContain("--proxy-server=http://[::1]:7892");
    });
  }

  test("PAC proxy: the resolver switch alone, PAC left in charge", () => {
    const r = run("launch", { app: "none", scutil: SCUTIL_PAC });
    expect(r.openArgs).toEqual([RESOLVER]);
  });

  for (const mode of ["launch", "watch"] as const) {
    for (const scutil of ["", "unparseable proxy settings", SCUTIL_NO_PROXY.slice(0, -1), SCUTIL_NO_PROXY.replace("HTTPSEnable : 0", "HTTPSEnable : unknown"), SCUTIL_SYSTEM_PROXY.replace("HTTPSProxy : 127.0.0.1", "HTTPSProxy :"), SCUTIL_SYSTEM_PROXY.replace("HTTPSPort : 7892", "HTTPSPort : invalid"), SCUTIL_SYSTEM_PROXY.replace("HTTPSProxy : 127.0.0.1", "HTTPSProxy : proxy.test;DIRECT"), SCUTIL_SYSTEM_PROXY.replace("HTTPSProxy : 127.0.0.1", "HTTPSProxy : ::::1"), SCUTIL_SYSTEM_PROXY.replace("HTTPSProxy : 127.0.0.1", "HTTPSProxy : proxy wrong"), SCUTIL_SYSTEM_PROXY.replace("HTTPSPort : 7892", "HTTPSPort : 8080 garbage")]) {
      test(`${mode}: unreadable or incomplete proxy policy leaves the app untouched (${JSON.stringify(scutil.slice(0, 25))})`, () => {
        const r = run(mode, { app: "plain", scutil });
        expect(r.status).toBe(1);
        expect(r.calls).toEqual([]);
        expect(r.log).toContain("cannot read the system proxy policy");
      });
    }
    test(`${mode}: scutil failure leaves the app untouched despite partial output`, () => {
      const r = run(mode, { app: "plain", scutilFails: true });
      expect(r.status).toBe(1);
      expect(r.calls).toEqual([]);
    });
  }

  for (const host of [":1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:", "[::1", "::1]", "999.1.2.3", "proxy..invalid", "-proxy.invalid", "099.1.2.3"]) {
    test(`malformed system proxy leaves the app untouched (${host})`, () => {
      const r = run("launch", { app: "plain", scutil: SCUTIL_SYSTEM_PROXY.replace("HTTPSProxy : 127.0.0.1", `HTTPSProxy : ${host}`) });
      expect(r.status).toBe(1);
      expect(r.calls).toEqual([]);
    });
  }

  test("native restore does not depend on reading the system proxy policy", () => {
    const r = run("native", { app: "flagged", scutilFails: true });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs).toEqual([]);
  });

  test("PAC launch uses its preflighted snapshot without rereading scutil", () => {
    const r = run("launch", { app: "plain", pac: true, scutilFails: true });
    expect(r.status).toBe(0);
    expect(r.openArgs).toEqual([PAC_SWITCH]);
  });
});

describe.skipIf(process.platform === "win32")("chatgpt launch watcher", () => {
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

  test("an explicit launch that finds another run holding the lock says so and fails", () => {
    mkdirSync(join(dir, "tmp", "opencodex-chatgpt-launch.lock"));
    const r = run("launch", { app: "plain" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("another ChatGPT launch is in progress");
    expect(r.calls).toEqual([]);
  });

  test("a launch whose open fails after the quit reports the failure instead of success", () => {
    const r = run("launch", { app: "plain", openFails: true });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.stdout).toContain("could not launch ChatGPT");
    expect(r.stdout).not.toContain("launched ChatGPT with");
  });

  test("a restore whose open fails reports the failure instead of success", () => {
    const r = run("native", { app: "flagged", openFails: true });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.stdout).toContain("could not relaunch ChatGPT with native networking");
    expect(r.stdout).not.toContain("relaunched ChatGPT with native networking");
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

describe.skipIf(process.platform === "win32")("chatgpt restore (native networking)", () => {
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

describe.skipIf(process.platform === "win32")("chatgpt launch helpers", () => {
  test("the launchd agent runs the script in watch mode", () => {
    const plist = buildChatgptUnblockWatcherPlist("/x/launch.sh", "/x/SingletonLock", "/x/err");
    expect(plist).toContain("<string>/x/launch.sh</string>\n    <string>watch</string>");
  });

  test("the agent wakes on every watched path: the app's lock and the readiness marker", () => {
    const plist = buildChatgptUnblockWatcherPlist("/x/launch.sh", ["/x/SingletonLock", "/x/chatgpt-unblock.ready"], "/x/err");
    expect(plist).toContain("<string>/x/SingletonLock</string>");
    expect(plist).toContain("<string>/x/chatgpt-unblock.ready</string>");
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


describe.skipIf(process.platform === "win32")("chatgpt launch with the app-server shim", () => {
  test("launch starts the app with CODEX_CLI_PATH pointing at the launcher, next to the usual switch", () => {
    const r = run("launch", { app: "none", scutil: SCUTIL_NO_PROXY, shim: true });
    expect(r.status).toBe(0);
    expect(r.openArgs).toEqual([RESOLVER]);
    expect(r.openEnv).toEqual([`CODEX_CLI_PATH=${SHIM_PATH()}`]);
  });

  test("without the shim the app gets no extra environment", () => {
    const r = run("launch", { app: "none", scutil: SCUTIL_NO_PROXY });
    expect(r.openEnv).toEqual([]);
  });

  test("watch corrects an app that has the switch but was started without the shim", () => {
    const r = run("watch", { app: "flagged", shim: true });
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openEnv).toEqual([`CODEX_CLI_PATH=${SHIM_PATH()}`]);
  });

  test("an app that already carries the switch and the shim is left alone", () => {
    const r = run("watch", { app: "flagged-shim", shim: true });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test("with the shim off, an app that has the switch is not restarted for lacking it", () => {
    const r = run("watch", { app: "flagged" });
    expect(r.calls).toEqual([]);
  });

  test("restore hands back an app that only carries the shim, even after the shim was switched off", () => {
    const r = run("native", { app: "shim-only" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openEnv).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("the watcher's five-minute guard and readiness wake", () => {
  test("watch restarts an app that started within the last five minutes", () => {
    const r = run("watch", { app: "plain", appEtime: "04:59" });
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs).toEqual([RESOLVER]);
  });

  test("watch leaves an app the user has been working in, whatever the elapsed-time format", () => {
    for (const appEtime of ["05:01", "02:03:04", "1-02:03:04"]) {
      const r = run("watch", { app: "plain", appEtime });
      expect(r.status).toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.log).toContain("without the launch switches; leaving it");
    }
  });

  test("a missing age counts as a fresh launch", () => {
    expect(run("watch", { app: "plain" }).calls).toEqual(["quit", "open"]);
  });

  test("an unparseable age counts as a fresh launch", () => {
    expect(run("watch", { app: "plain", appEtime: "garbage" }).calls).toEqual(["quit", "open"]);
  });

  test("the explicit launch command restarts an old app too", () => {
    const r = run("launch", { app: "plain", appEtime: "1-00:00:00" });
    expect(r.calls).toEqual(["quit", "open"]);
  });

  test("launch sees the app that is its own ancestor and leaves a correctly launched one alone", () => {
    const r = run("launch", { app: "flagged", appIsAncestor: true });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toContain("already running with the launch switches");
  });

  test("restore finds the ancestor app and hands it back native", () => {
    const r = run("native", { app: "flagged", appIsAncestor: true });
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs).toEqual([]);
  });
});

test.skipIf(process.platform === "win32")("the shim's CODEX_CLI_PATH rides the explicit relaunch after a quit", () => {
  const result = run("launch", { app: "flagged", shim: true });
  expect(result.status).toBe(0);
  expect(result.calls).toEqual(["quit", "open"]);
  expect(result.openEnv).toEqual([`CODEX_CLI_PATH=${SHIM_PATH()}`]);
  expect(result.openArgs).toEqual([RESOLVER]);
});

describe("an inherited CODEX_CLI_PATH never reaches a relaunch", () => {
  const INHERITED = "/tmp/inherited-codex-cli";
  test("native restore drops it and passes no override", () => {
    const r = run("native", { app: "flagged", inheritedCliPath: INHERITED });
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openInherited).toBe("<unset>");
    expect(r.openEnv).toEqual([]);
  });
  test("a launch without the shim drops it and passes no override", () => {
    const r = run("launch", { app: "plain", inheritedCliPath: INHERITED });
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openInherited).toBe("<unset>");
    expect(r.openEnv).toEqual([]);
  });
  test("a shim launch drops it and passes only the shim launcher", () => {
    const r = run("launch", { app: "plain", shim: true, inheritedCliPath: INHERITED });
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openInherited).toBe("<unset>");
    expect(r.openEnv).toEqual([`CODEX_CLI_PATH=${SHIM_PATH()}`]);
  });
});

describe.skipIf(process.platform === "win32")("chatgpt launch in PAC-fallback mode", () => {
  for (const mode of ["launch", "watch"] as const) {
    for (const pacFile of ["missing", "directory", "empty"] as const) {
      test(`${mode} leaves the running app untouched when PAC preflight finds a ${pacFile} file`, () => {
        const r = run(mode, { app: "plain", pac: true, pacFile });
        expect(r.status).toBe(1);
        expect(r.calls).toEqual([]);
        expect(r.processes).toContain(`400|ChatGPT|${APP_BINARY}\n`);
        expect(r.openArgs).toEqual([]);
        expect(existsSync(join(dir, "tmp", "opencodex-chatgpt-launch.lock"))).toBe(false);
      });
    }
    test.skipIf(process.getuid?.() === 0)(`${mode} leaves the running app untouched when PAC preflight cannot read the file`, () => {
      const r = run(mode, { app: "plain", pac: true, pacFile: "unreadable" });
      expect(r.status).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.processes).toContain(`400|ChatGPT|${APP_BINARY}\n`);
    });
    test(`${mode} leaves the running app untouched when PAC preflight encoding fails after partial output`, () => {
      const r = run(mode, { app: "plain", pac: true, pacEncodingFails: true });
      expect(r.status).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.processes).toContain(`400|ChatGPT|${APP_BINARY}\n`);
    });
  }

  test("PAC preflight leaves an old watch-mode app alone when the PAC is missing", () => {
    const r = run("watch", { app: "plain", pac: true, pacFile: "missing", appEtime: "01:00:00" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.processes).toContain(`400|ChatGPT|${APP_BINARY}\n`);
  });

  test("PAC preflight refuses a new launch without opening an app when the PAC is missing", () => {
    const r = run("launch", { app: "none", pac: true, pacFile: "missing" });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.processes).toBe("");
  });

  test("the PAC snapshot is built before quit and is not re-read during open", () => {
    const r = run("launch", { app: "plain", pac: true, removePacOnQuit: true });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs).toEqual([PAC_SWITCH]);
    expect(existsSync(join(dir, "chatgpt-unblock.pac"))).toBe(false);
  });

  test("PAC preflight leaves no-op watch and native restore independent of a missing PAC file", () => {
    const idle = run("watch", { app: "none", pac: true, pacFile: "missing" });
    expect(idle.status).toBe(0);
    expect(idle.calls).toEqual([]);
    const native = run("native", { app: "pac", pac: true, pacFile: "missing" });
    expect(native.status).toBe(0);
    expect(native.calls).toEqual(["quit", "open"]);
    expect(native.openArgs).toEqual([]);
  });

  test("the app gets the PAC switch alone, whatever the system proxy is", () => {
    for (const scutil of [SCUTIL_NO_PROXY, SCUTIL_SYSTEM_PROXY, SCUTIL_SOCKS_ONLY, SCUTIL_PAC]) {
      const r = run("launch", { app: "none", scutil, pac: true, configDir: dir });
      expect(r.openArgs).toEqual([PAC_SWITCH]);
    }
  });

  test("watch corrects an app launched under the resolver-rule mode once the PAC is live", () => {
    // A mode change means the app's old switches no longer match the marker: it is corrected.
    const r = run("watch", { app: "flagged", pac: true });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["quit", "open"]);
    expect(r.openArgs).toEqual([PAC_SWITCH]);
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

  test("the entry probe rejects curl exit 56 (connected, empty answer)", () => {
    const r = run("launch", { app: "plain", pac: true, entry: "up56" });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });

  test("the shim composes with PAC-fallback mode", () => {
    const r = run("launch", { app: "none", pac: true, shim: true, configDir: dir });
    expect(r.openArgs).toEqual([PAC_SWITCH]);
    expect(r.openEnv).toEqual([`CODEX_CLI_PATH=${SHIM_PATH()}`]);
  });

  test("the PAC switch on the command line counts as flagged via chatgptCommandLineHasPac", () => {
    writeFileSync(join(dir, "chatgpt-unblock.pac"), PAC_TEXT);
    expect(chatgptCommandLineHasPac(`${APP_BINARY} ${PAC_SWITCH}`, dir)).toBe(true);
    // A PAC regenerated since the app launched is no longer the one it carries.
    writeFileSync(join(dir, "chatgpt-unblock.pac"), `${PAC_TEXT}// changed\n`);
    expect(chatgptCommandLineHasPac(`${APP_BINARY} ${PAC_SWITCH}`, dir)).toBe(false);
    // The pre-inline file:// switch still counts as ours, so it can be corrected.
    expect(chatgptCommandLineHasPac(`${APP_BINARY} --proxy-pac-url=file://${dir}/chatgpt-unblock.pac`, dir)).toBe(true);
    expect(chatgptCommandLineHasPac(APP_BINARY, dir)).toBe(false);
    expect(chatgptCommandLineHasPac(`${APP_BINARY} --proxy-pac-url=file://other/chatgpt-unblock.pac`, dir)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("generated watcher script syntax", () => {
  // The script is a template literal; a stray quote or backtick in it would still build and
  // install, then fail on every launch.
  test("every mode combination parses as bash", () => {
    const configDirs = [dir, join(dir, "it's \"quoted\" $dir")];
    for (const configDir of configDirs) {
      mkdirSync(configDir, { recursive: true });
      for (const pac of [false, true]) {
        for (const shim of [false, true]) {
          const script = join(dir, `syntax-${pac}-${shim}.sh`);
          writeFileSync(script, buildChatgptUnblockWatcherScript(PORT, configDir, shim, pac ? { entryPort: 10301 } : undefined));
          const check = checkChatgptWatcherScriptSyntax(script);
          expect({ pac, shim, configDir, ok: check.ok, output: check.output }).toEqual({ pac, shim, configDir, ok: true, output: "" });
        }
      }
    }
  });
});


describe.skipIf(process.platform === "win32")("verified watcher bundle", () => {
  for (const mode of ["watch", "launch", "native"] as const) {
    test(`${mode} leaves a running untrusted bundle untouched`, () => {
      const r = run(mode, { app: mode === "native" ? "flagged" : "plain", bundleTrust: "rejected" });
      expect(r.status).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.processes).toContain("400|ChatGPT|");
    });
    test(`${mode} quits and opens the same verified absolute bundle path`, () => {
      const appPath = "/Applications/Other installs/it's \"Codex\".app";
      const r = run(mode, { app: mode === "native" ? "flagged" : "plain", appPath });
      expect(r.status).toBe(0);
      expect(r.calls).toEqual(["quit", "open"]);
      expect(r.openAllArgs.slice(0, 2)).toEqual(["-a", appPath]);
      expect(r.quitAllArgs.at(-1)).toBe(appPath);
      expect(r.preflightArgs).toEqual([appPath]);
    });
  }
});


describe.skipIf(process.platform === "win32")("readiness after bundle preflight", () => {
  for (const pac of [false, true]) {
    test(`listener stopping during preflight leaves the running app untouched (PAC=${pac})`, () => {
      const r = run("launch", { app: "plain", pac, listenerStopsDuringPreflight: true });
      expect(r.status).toBe(1);
      expect(r.calls).toEqual([]);
      expect(r.processes).toContain("400|ChatGPT|");
      expect(r.log).toContain("readiness changed during preflight");
    });
  }
});

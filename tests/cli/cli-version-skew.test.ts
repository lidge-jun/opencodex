import { describe, expect, test } from "bun:test";
import { computeVersionSkew, isConfirmedVersionMatch } from "../../src/cli/version-skew";
import { packageVersion } from "../../src/cli/help";
import { shouldNoticeVersionSkew } from "../../src/cli/version-skew-notice";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

/**
 * #2701: an older `ocx` earlier on PATH than the running proxy described a different
 * build, and nothing surfaced it because the CLI never compared the two versions.
 */
describe("version skew detection", () => {
  test("directs an older CLI to upgrade or resolve PATH", () => {
    const skew = computeVersionSkew("2.35.0", "2.36.1");
    expect(skew.skewed).toBe(true);
    expect(skew.cliVersion).toBe("2.35.0");
    expect(skew.proxyVersion).toBe("2.36.1");
    expect(skew.relation).toBe("proxy-newer");
    expect(skew.warning).toContain("2.35.0");
    expect(skew.warning).toContain("2.36.1");
    expect(skew.warning).toContain("this ocx on PATH is older");
    expect(skew.warning).toContain("Upgrade the CLI or resolve PATH");
    expect(skew.warning).not.toContain("ocx service repair");
  });

  test("#3464 directs a newer CLI to restart the older proxy", () => {
    const skew = computeVersionSkew("2.42.0", "2.10.1-preview.20260805");
    expect(skew).toEqual({
      cliVersion: "2.42.0",
      proxyVersion: "2.10.1-preview.20260805",
      skewed: true,
      relation: "cli-newer",
      warning: "CLI 2.42.0 does not match the running proxy 2.10.1-preview.20260805 — "
        + "the running proxy is older than this CLI. Restart the proxy using the intended current installation. "
        + "For a background service, run ocx service restart (repair reloads only a changed definition).",
    });
    expect(skew.warning).not.toContain("this ocx on PATH is older");
  });

  test.each([
    ["2.43.0", "2.43.0-preview.1"],
    ["2.43.0-preview.10", "2.43.0-preview.2"],
    ["2.43.0-preview.beta", "2.43.0-preview.10"],
    ["2.43.0-preview.1", "2.43.0-preview"],
    ["2.43.0-beta", "2.43.0-alpha"],
    ["2.44.0-preview.1", "2.43.0"],
    ["10.0.0", "9.99.99"],
    ["2.43.1", "2.43.0"],
    ["2.43.0-preview.9007199254740993", "2.43.0-preview.9007199254740992"],
  ])("orders %s above %s in both directions", (newer, older) => {
    expect(computeVersionSkew(newer, older).warning).toContain("the running proxy is older");
    expect(computeVersionSkew(older, newer).warning).toContain("this ocx on PATH is older");
    expect(computeVersionSkew(newer, older).relation).toBe("cli-newer");
    expect(computeVersionSkew(older, newer).relation).toBe("proxy-newer");
  });

  test.each([
    ["2.43.0+build.1", "2.43.0+build.2"],
    ["2.43.0", "2.43.0+build.1"],
    ["2.43.0-preview.1+a", "2.43.0-preview.1+b"],
    ["invalid", "2.43.0"],
    ["2.43", "2.43.0"],
    ["v2.43.0", "2.43.0"],
    [" 2.43.0", "2.43.0"],
    ["2.43.0 ", "2.43.0"],
    ["2.43.0-preview.01", "2.43.0-preview.1"],
    ["", "2.43.0"],
  ])("keeps raw unequal %s / %s neutral in both directions", (left, right) => {
    for (const [cli, proxy] of [[left, right], [right, left]]) {
      const skew = computeVersionSkew(cli!, proxy!);
      expect(skew.cliVersion).toBe(cli);
      expect(skew.proxyVersion).toBe(proxy);
      expect(skew.skewed).toBe(true);
      expect(skew.relation).toBe("incomparable");
      expect(skew.warning).toContain("neither can be identified as older");
      expect(skew.warning).not.toContain("ocx service repair");
      expect(isConfirmedVersionMatch(skew)).toBe(false);
    }
  });

  test.each(["unknown", "0.0.0"])("suppresses %s on either side without confirming a match", placeholder => {
    for (const [cli, proxy] of [[placeholder, "2.43.0"], ["2.43.0", placeholder], [placeholder, placeholder]]) {
      const skew = computeVersionSkew(cli!, proxy!);
      expect(skew.skewed).toBe(false);
      expect(skew.relation).toBe("unknown");
      expect(skew.warning).toBeNull();
      expect(isConfirmedVersionMatch(skew)).toBe(false);
    }
  });

  test("stays quiet when the versions match", () => {
    const skew = computeVersionSkew("2.35.0", "2.35.0");
    expect(skew.skewed).toBe(false);
    expect(skew.relation).toBe("match");
    expect(skew.warning).toBeNull();
    expect(isConfirmedVersionMatch(skew)).toBe(true);
  });

  test("stays quiet when nothing is live", () => {
    const skew = computeVersionSkew("2.35.0", undefined);
    expect(skew.skewed).toBe(false);
    expect(skew.relation).toBe("unknown");
    expect(skew.proxyVersion).toBeNull();
    expect(skew.warning).toBeNull();
    expect(isConfirmedVersionMatch(skew)).toBe(false);
  });

  test("suppresses the warning when the proxy reports the 0.0.0 placeholder", () => {
    // The server's VERSION falls back to "0.0.0" when it cannot resolve its own package.
    // Comparing against it would send an operator to reinstall a healthy install.
    expect(computeVersionSkew("2.35.0", "0.0.0").skewed).toBe(false);
    expect(computeVersionSkew("2.35.0", "0.0.0").warning).toBeNull();
  });

  test("suppresses the warning when the CLI cannot resolve its own version", () => {
    // packageVersion() answers "unknown" for a non-string version; that means "cannot
    // compare", not "different".
    expect(computeVersionSkew("unknown", "2.36.1").skewed).toBe(false);
    expect(computeVersionSkew("unknown", "2.36.1").warning).toBeNull();
  });

  test("a legacy proxy version still compares, since it is a real version", () => {
    // A pre-identity healthz body carries a version even without a pid, and an older proxy
    // is precisely the skew worth reporting.
    expect(computeVersionSkew("2.35.0", "2.6.16").skewed).toBe(true);
  });

  test("packageVersion is exported and resolves a real version", () => {
    const version = packageVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
    expect(version).not.toBe("unknown");
  });
});

type NoticeScenario = {
  command?: string; args?: string[]; cliVersion?: string; proxyVersion?: string | null;
  runtime?: boolean; configError?: boolean; configDefault?: boolean;
  foreign?: boolean; wrongPid?: boolean;
  outcome?: "reject" | "hang" | "late" | "expired-read" | "network-abort";
  repeat?: boolean; root?: boolean; exitCode?: number;
  endpointMs?: number; versionMs?: number; quietFirst?: boolean;
};
function freshNotice(scenario: NoticeScenario = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocx-notice-test-"));
  try {
    const ocxHome = join(root, "ocx"), codexHome = join(root, "codex");
    mkdirSync(ocxHome); mkdirSync(codexHome);
    const script = `
      const scenario = ${JSON.stringify(scenario)};
      const notice = await import(${JSON.stringify(repoPath("src", "cli", "version-skew-notice.ts"))});
      const { proxyIdentityAt } = await import(${JSON.stringify(repoPath("src", "server", "proxy-liveness.ts"))});
      const warnings = [], calls = [], probes = [], events = [];
      let clock = 0, aborted = false;
      const started = performance.now();
      let acknowledgeAbort;
      const abortObserved = new Promise(resolve => { acknowledgeAbort = resolve; });
      const io = {
        now: () => scenario.outcome === "hang" || scenario.outcome === "network-abort" ? Date.now() : clock,
        cliVersion: () => { clock += scenario.versionMs ?? 0; return scenario.cliVersion ?? "2.80.0"; },
        warn: line => { warnings.push(line); events.push("warn"); console.error(line); },
        readRuntime: () => {
          calls.push("runtime");
          clock += scenario.endpointMs ?? 0;
          if (scenario.outcome === "expired-read") clock = 201;
          return scenario.runtime === false ? null : { pid:123, port:23456, hostname:"127.0.0.1" };
        },
        readConfig: () => {
          calls.push("config");
          return { config: scenario.configDefault ? {} : {port:34567,hostname:"127.0.0.1"},
            source: scenario.configDefault ? "default" : "file", error:scenario.configError ? "invalid" : null };
        },
        probe: async (port, opts, budget) => {
          probes.push({port,opts,budget:{attempts:budget.attempts,timeoutMs:budget.timeoutMs,deadlineAt:budget.deadlineAt}});
          if (scenario.outcome === "reject") throw new Error("transport");
          if (scenario.outcome === "hang") return new Promise(() => {});
          if (scenario.outcome === "late") clock = 201;
          return proxyIdentityAt(port, opts, { ...budget, fetchFn: async (_url, init) => {
            if (scenario.outcome === "network-abort") return new Promise((_resolve,reject) => {
              const abort = () => { aborted = true; acknowledgeAbort(); reject(new Error("aborted")); };
              init.signal.addEventListener("abort",abort,{once:true});
              if (init.signal.aborted) abort();
            });
            return Response.json({service:scenario.foreign ? "foreign" : "opencodex",status:"ok",
              pid:scenario.wrongPid ? 124 : 123,
              ...(scenario.proxyVersion === null ? {} : {version:scenario.quietFirst && probes.length === 1 ? "2.80.0" : scenario.proxyVersion ?? "2.81.0"})});
          } });
        },
      };
      const command = scenario.command ?? "start", args = scenario.args ?? [command];
      if (scenario.root) {
        const { mock } = await import("bun:test");
        const actual = notice.maybeNoticeVersionSkew;
        mock.module(${JSON.stringify(repoPath("src", "cli", "version-skew-notice.ts"))}, () => ({
          shouldNoticeVersionSkew: notice.shouldNoticeVersionSkew,
          maybeNoticeVersionSkew: (cmd,argv) => { events.push("hook"); return actual(cmd,argv,io); },
        }));
        mock.module(${JSON.stringify(repoPath("src", "cli", "codex-shim-autorestore.ts"))}, () => ({
          maybeAutoRestoreCodexShim: () => events.push("shim"),
        }));
        const { runCli } = await import(${JSON.stringify(repoPath("src", "cli", "root.ts"))});
        await runCli(args); events.push("dispatch");
      } else {
        await notice.maybeNoticeVersionSkew(command,args,io);
        if (scenario.repeat || scenario.quietFirst) await notice.maybeNoticeVersionSkew("restart",["restart"],io);
      }
      if (scenario.outcome === "network-abort") await abortObserved;
      console.log(JSON.stringify({warnings,calls,probes,events,aborted,elapsedMs:performance.now()-started}));
      process.exitCode = scenario.exitCode ?? 0;
    `;
    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true,
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: ocxHome,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", CODEX_HOME: codexHome, GROK_HOME: join(root,"grok"), OCX_OWNER_REGISTRY_DIR: join(root,"owners") },
    });
    const report = result.stdout.trim().startsWith("{") ? JSON.parse(result.stdout) as {
      warnings: string[]; calls: string[];
      probes: Array<{port:number;opts:{expectedPid?:number};budget:{attempts:number;timeoutMs:number;deadlineAt:number}}>;
      events: string[]; aborted: boolean; elapsedMs: number;
    } : null;
    return { status:result.status, stdout:result.stdout, stderr:result.stderr, report };
  } finally { rmSync(root,{recursive:true,force:true}); }
}

describe("lifecycle version notice activation", () => {
  test("lifecycle hook reports an older CLI once before dispatch", () => {
    const result = freshNotice({root:true});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("ocx 2.80.0 does not match the running proxy 2.81.0. Check which opencodex installation you meant to use (`ocx status` shows both).\n");
    expect(result.report?.events).toEqual(["hook","warn","shim","dispatch"]);
    expect(result.report?.probes).toHaveLength(1);
    const repeat = freshNotice({repeat:true});
    expect(repeat.report?.warnings).toHaveLength(1);
    expect(repeat.report?.probes).toHaveLength(1);
  });
  test("lifecycle hook reports a newer CLI without changing dispatch exit", () => {
    const result = freshNotice({root:true,cliVersion:"2.82.0",exitCode:7});
    expect(result.status).toBe(7);
    expect(result.stderr).toBe("ocx 2.82.0 does not match the running proxy 2.81.0. Check which opencodex installation you meant to use (`ocx status` shows both).\n");
    expect(result.report?.events.at(-1)).toBe("dispatch");
  });
  test.each(["start","stop","restart","update","service"])("lifecycle %s JSON and help perform no notice reads", command => {
    for (const option of ["--json","--help","-h","help"]) {
      const result = freshNotice({command,args:[command,option]});
      expect(result.status).toBe(0); expect(result.stderr).toBe("");
      expect(result.report?.calls).toEqual([]); expect(result.report?.probes).toEqual([]);
    }
  });
  test.each(["status","doctor","resolve","ready","internal","ensure","version","setup"])("non-lifecycle %s performs no notice reads", command => {
    const result = freshNotice({command});
    expect(result.report?.calls).toEqual([]); expect(result.report?.probes).toEqual([]);
    expect(result.stderr).toBe("");
  });
  test("runtime target wins over configured port for the notice", () => {
    const result = freshNotice();
    expect(result.report?.calls).toEqual(["runtime"]);
    expect(result.report?.probes[0]?.port).toBe(23456);
    expect(result.report?.probes[0]?.opts.expectedPid).toBe(123);
    expect(result.report?.probes[0]?.budget).toEqual({attempts:1,timeoutMs:200,deadlineAt:200});
  });
  test("missing runtime record selects valid configured endpoint once", () => {
    const result = freshNotice({runtime:false});
    expect(result.report?.calls).toEqual(["runtime","config"]);
    expect(result.report?.probes).toHaveLength(1);
    expect(result.report?.probes[0]?.port).toBe(34567);
    expect(result.report?.probes[0]?.opts.expectedPid).toBeUndefined();
    expect(result.report?.warnings).toHaveLength(1);
  });
  test("missing config uses default port and malformed config stays quiet", () => {
    expect(freshNotice({runtime:false,configDefault:true}).report?.probes[0]?.port).toBe(10100);
    const invalid = freshNotice({runtime:false,configError:true});
    expect(invalid.report?.probes).toEqual([]); expect(invalid.stderr).toBe("");
  });
  test("stale runtime record does not probe a second endpoint", () => {
    const result = freshNotice({outcome:"reject"});
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.report?.calls).toEqual(["runtime"]); expect(result.report?.probes).toHaveLength(1);
  });
  test.each([{foreign:true},{wrongPid:true}])("foreign or mismatched health identity never emits skew %j", scenario => {
    const result = freshNotice(scenario);
    expect(result.stderr).toBe(""); expect(result.report?.probes).toHaveLength(1);
  });
  test.each(["2.81.0\u001b[31m",null,"unknown","0.0.0","2.80.0"])("unsafe absent placeholder or matching version %j stays quiet", proxyVersion => {
    const result = freshNotice({proxyVersion}); expect(result.stderr).toBe("");
    expect(result.report?.warnings).toEqual([]); expect(result.report?.probes).toHaveLength(1);
  });
  test("expired endpoint reads never start a probe", () => {
    const result = freshNotice({outcome:"expired-read"});
    expect(result.report?.probes).toEqual([]); expect(result.stderr).toBe("");
  });
  test.each(["reject","hang"] as const)("notice %s preserves the command", outcome => {
    const result = freshNotice({outcome});
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.report?.probes).toHaveLength(1);
    if (outcome === "hang") {
      expect(result.report!.elapsedMs).toBeGreaterThanOrEqual(150);
      expect(result.report!.elapsedMs).toBeLessThan(1500);
    }
  });
  test("late identity never prints after the diagnostic deadline", () => {
    expect(freshNotice({outcome:"late"}).stderr).toBe("");
  });
  test("production identity request receives cancellation at the notice deadline", () => {
    const result = freshNotice({outcome:"network-abort"});
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.report?.aborted).toBe(true); expect(result.report?.probes).toHaveLength(1);
  });
  test.each([
    [["stop","--expect-pid","broken"],64], [["unknown-root"],1],
    [["--help"],0], [["ready","--timeout","bad"],64], [["resolve","--invalid"],64],
  ] as const)("root early-exit %j retains exit %s before notice", (args,status) => {
    const result = freshNotice({root:true,args:[...args]});
    expect(result.status).toBe(status); expect(result.report).toBeNull();
    expect(result.stderr).not.toContain("does not match the running proxy");
  });
});

describe("lifecycle version notice gate", () => {
  test.each(["start", "stop", "restart", "update", "service"])("activates for %s", command => {
    expect(shouldNoticeVersionSkew(command, [command])).toBe(true);
  });
  test.each(["status", "doctor", "resolve", "ready", "internal", "ensure", "version", "setup"])("skips %s", command => {
    expect(shouldNoticeVersionSkew(command, [command])).toBe(false);
  });
  test.each(["--json", "--help", "-h", "help"])("skips option %s", option => {
    expect(shouldNoticeVersionSkew("service", ["service", option])).toBe(false);
  });
  test("operand options after double dash do not change global diagnostic mode", () => {
    expect(shouldNoticeVersionSkew("start", ["start", "--", "--json"])).toBe(true);
    const result = freshNotice({ args: ["start", "--", "--json"] });
    expect(result.status).toBe(0);
    expect(result.report?.warnings).toHaveLength(1);
  });
  test.each(["unknown", "0.0.0"])("unknown CLI %s stays quiet", cliVersion => {
    const result = freshNotice({ cliVersion });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.report?.warnings).toEqual([]);
  });
});

describe("version notice total deadline and quiet-call recovery", () => {
  test("endpoint and version reads share the 200 ms probe budget", () => {
    const result = freshNotice({ endpointMs: 75, versionMs: 25 });
    expect(result.status).toBe(0);
    expect(result.report?.probes).toHaveLength(1);
    expect(result.report?.probes[0]?.budget).toEqual({ attempts: 1, timeoutMs: 100, deadlineAt: 200 });
    expect(result.report?.warnings).toHaveLength(1);
  });
  test("an expired version lookup never starts a probe", () => {
    const result = freshNotice({ versionMs: 200 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.report?.probes).toEqual([]);
  });
  test("a matching quiet call permits a later mismatch notice", () => {
    const result = freshNotice({ quietFirst: true });
    expect(result.status).toBe(0);
    expect(result.report?.probes).toHaveLength(2);
    expect(result.report?.warnings).toHaveLength(1);
    expect(result.stderr).toBe("ocx 2.80.0 does not match the running proxy 2.81.0. Check which opencodex installation you meant to use (`ocx status` shows both).\n");
  });
  test.each(["reject", "hang"] as const)("root dispatch retains exit 7 on notice %s", outcome => {
    const result = freshNotice({ root: true, outcome, exitCode: 7 });
    expect(result.status).toBe(7);
    expect(result.stderr).toBe("");
    expect(result.report?.events).toEqual(["hook", "shim", "dispatch"]);
  });
  test.each(["start", "stop", "restart", "update", "service"])("root %s JSON skips notice reads", command => {
    const result = freshNotice({ root: true, command, args: [command, "--json"] });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.report?.calls).toEqual([]);
    expect(result.report?.probes).toEqual([]);
    expect(result.report?.events).toEqual(["hook", "shim", "dispatch"]);
  });
});

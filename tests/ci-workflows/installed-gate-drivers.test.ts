import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  compareSemver,
  describeGatePhases,
  evaluateOwnership,
  npmPackageSpec,
  observeOwnership,
  parseGateArguments,
  parsePidList,
  readOwnPackageName,
  runGate,
  summarizeReport,
  type GateDeps,
  type GateOptions,
  type GateReport,
} from "../../desktop/scripts/installed-gate";
import {
  linuxAdapter,
  macosAdapter,
  windowsAdapter,
  type ProcessEvidence,
} from "../../desktop/scripts/installed-gate-platforms";
import { repoPath } from "../helpers/repo-root";

const okRunner = {
  run: async (): Promise<ProcessEvidence> => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
  mkdir: () => {},
  fileExists: () => false,
  homeDir: () => "/fake-home",
};

function baseArgv(): string[] {
  return [
    "--platform", "macos",
    "--format", "dmg",
    "--artifact", "gate/OpenCodex-2.62.0-macos.dmg",
    "--work-dir", "gate/work",
    "--to-version", "2.62.0",
    "--report", "gate/report.json",
  ];
}

describe("installed-gate argument parsing", () => {
  test("accepts a complete macOS invocation", () => {
    const parsed = parseGateArguments(baseArgv());
    expect(parsed.error).toBeUndefined();
    expect(parsed.options?.platform).toBe("macos");
    expect(parsed.options?.takeoverTimeoutMs).toBe(180_000);
  });

  test("lists every missing required argument", () => {
    const parsed = parseGateArguments([]);
    expect(parsed.error).toContain("--platform");
    expect(parsed.error).toContain("--report");
  });

  test("rejects a format that does not belong to the platform", () => {
    const parsed = parseGateArguments(baseArgv().map(a => a === "dmg" ? "deb" : a));
    expect(parsed.error).toContain("not a macos artifact format");
  });

  test("rejects an unknown platform", () => {
    const parsed = parseGateArguments(baseArgv().map(a => a === "macos" ? "freebsd" : a));
    expect(parsed.error).toContain("--platform must be");
  });

  test("R3: linux runs without an older artifact are rejected, update verification is not optional", () => {
    const linux = baseArgv().map(a => (a === "macos" ? "linux" : a === "dmg" ? "deb" : a));
    expect(parseGateArguments(linux).error).toContain("--older-artifact");
    const linuxWithArtifact = [...linux, "--older-artifact", "gate/older.deb"];
    expect(parseGateArguments(linuxWithArtifact).error).toContain("--from-version");
    expect(parseGateArguments([...linuxWithArtifact, "--from-version", "2.61.0"]).options).toBeDefined();
  });

  test("the older artifact must actually be older", () => {
    const linux = [
      ...baseArgv().map(a => (a === "macos" ? "linux" : a === "dmg" ? "deb" : a)),
      "--older-artifact", "gate/older.deb",
    ];
    expect(parseGateArguments([...linux, "--from-version", "2.62.0"]).error).toContain("differ");
    expect(parseGateArguments([...linux, "--from-version", "2.63.0"]).error).toContain("strictly older");
    expect(parseGateArguments([...linux, "--from-version", "2.62.0-rc.1"]).options).toBeDefined();
  });

  test("compareSemver orders numeric triples and prerelease suffixes", () => {
    expect(compareSemver("2.61.0", "2.62.0")).toBeLessThan(0);
    expect(compareSemver("2.62.0", "2.61.0")).toBeGreaterThan(0);
    expect(compareSemver("2.62.0-rc.1", "2.62.0")).toBeLessThan(0);
    expect(compareSemver("2.62.0", "2.62.0")).toBe(0);
  });

  test("rejects a non-positive takeover timeout", () => {
    expect(parseGateArguments([...baseArgv(), "--takeover-timeout", "0"]).error).toContain("--takeover-timeout");
    expect(parseGateArguments([...baseArgv(), "--takeover-timeout", "45"]).options?.takeoverTimeoutMs).toBe(45_000);
  });

  test("hooks are file names inside --hooks-dir, never command text or paths", () => {
    expect(parseGateArguments([...baseArgv(), "--consent-hook", "answer-consent"]).error)
      .toContain("--hooks-dir");
    const withDir = [...baseArgv(), "--hooks-dir", "gate/hooks"];
    expect(parseGateArguments([...withDir, "--consent-hook", "answer-consent"]).options?.consentHook).toBe("answer-consent");
    expect(parseGateArguments([...withDir, "--consent-hook", "../escape"]).error).toContain("plain file name");
    expect(parseGateArguments([...withDir, "--tray-quit-hook", "a/b"]).error).toContain("plain file name");
    expect(parseGateArguments([...withDir, "--tray-quit-hook", "rm -rf /"]).error).toContain("plain file name");
  });

  test("the npm package spec is derived from the repository, never taken as an argument", () => {
    expect(npmPackageSpec("@example/opencodex", "2.61.0")).toBe("@example/opencodex@2.61.0");
    expect(readOwnPackageName('{"name":"@bitkyc08/opencodex"}')).toBe("@bitkyc08/opencodex");
    expect(readOwnPackageName("not json")).toBeUndefined();
  });

  test("version inputs are strict semver, never npm package grammar", () => {
    // `opencodex@${input}` with an alias payload would install an arbitrary package.
    expect(parseGateArguments(baseArgv().map(a => a === "2.62.0" ? "npm:evil@latest" : a)).error).toContain("strict semver");
    const linux = baseArgv().map(a => (a === "macos" ? "linux" : a === "dmg" ? "deb" : a));
    const linuxBase = [...linux, "--older-artifact", "gate/older.deb"];
    expect(parseGateArguments(linuxBase).error).toContain("--from-version");
    expect(parseGateArguments([...linuxBase, "--from-version", "2.62.0"]).error).toContain("differ");
    expect(parseGateArguments([...linuxBase, "--from-version", "2.61.0"]).options?.fromVersion).toBe("2.61.0");
  });
});

describe("installed-gate pid parsing", () => {
  test("empty probe output is no pids, never pid 0", () => {
    expect(parsePidList("")).toEqual([]);
    expect(parsePidList("\n\n")).toEqual([]);
  });

  test("only positive safe integers survive", () => {
    expect(parsePidList("123\n456\n")).toEqual([123, 456]);
    expect(parsePidList(" 42 \n0\n-7\nabc\n")).toEqual([42]);
  });
});

describe("installed-gate ownership contract", () => {
  test("reads the lane C schema: record root carries an ownership object", () => {
    const observed = observeOwnership({ ownership: { installId: "install-1", consentGeneration: 3 } });
    expect(observed.ownerInstallId).toBe("install-1");
    expect(observed.consentGeneration).toBe(3);
  });

  test("does not guess at other shapes — an unknown schema is no observation", () => {
    expect(observeOwnership({ owner: { installId: "x" } }).ownerInstallId).toBeUndefined();
    expect(observeOwnership({ installId: "x", consentGeneration: 1 }).consentGeneration).toBeUndefined();
    expect(observeOwnership("not-an-object").ownerInstallId).toBeUndefined();
  });

  test("accepts exactly one consent-generation increment with a recorded owner", () => {
    // The takeover precondition is an UNOWNED staged runtime: a pre-existing owner
    // means the observation is not the takeover this gate exists to prove.
    const before = observeOwnership({});
    const after = observeOwnership({ ownership: { installId: "install-1", consentGeneration: 1 } });
    expect(evaluateOwnership(before, after).ok).toBe(true);
  });

  test("rejects a takeover from an already-owned runtime", () => {
    const before = observeOwnership({ ownership: { installId: "other", consentGeneration: 0 } });
    const after = observeOwnership({ ownership: { installId: "install-1", consentGeneration: 1 } });
    const verdict = evaluateOwnership(before, after);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("unowned");
  });

  test("rejects a takeover that recorded no owner", () => {
    const before = observeOwnership({});
    const after = observeOwnership({ ownership: { consentGeneration: 1 } });
    const verdict = evaluateOwnership(before, after);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("install id");
  });

  test("rejects more than one consent-generation increment", () => {
    const before = observeOwnership({ ownership: { consentGeneration: 0 } });
    const after = observeOwnership({ ownership: { installId: "i", consentGeneration: 2 } });
    expect(evaluateOwnership(before, after).ok).toBe(false);
  });

  test("treats a missing generation after consent as a failure, never as zero", () => {
    const before = observeOwnership({ ownership: { consentGeneration: 0 } });
    const after = observeOwnership({ ownership: { installId: "i" } });
    expect(evaluateOwnership(before, after).ok).toBe(false);
  });
});

describe("installed-gate phase plan and report", () => {
  const optionsFor = (platform: GateOptions["platform"]): GateOptions => ({
    platform,
    format: platform === "linux" ? "deb" : platform === "windows" ? "msi" : "dmg",
    artifact: "a",
    olderArtifact: "b",
    workDir: "w",
    toVersion: "2.62.0",
    fromVersion: "2.61.0",
    reportPath: "r.json",
    takeoverTimeoutMs: 1000,
  });

  test("linux gates carry the update phase before cleanup", () => {
    const phases = describeGatePhases(optionsFor("linux"));
    expect(phases).toContain("update-verify");
    expect(phases.indexOf("update-verify")).toBe(phases.length - 2);
    expect(phases.at(-1)).toBe("cleanup");
  });

  test("macOS and Windows gates stop after the drain contract", () => {
    expect(describeGatePhases(optionsFor("macos"))).not.toContain("update-verify");
    expect(describeGatePhases(optionsFor("windows"))).not.toContain("update-verify");
  });

  test("every gate opens with the isolation preflight", () => {
    for (const platform of ["macos", "windows", "linux"] as const) {
      expect(describeGatePhases(optionsFor(platform))[0]).toBe("preflight-isolation");
      expect(describeGatePhases(optionsFor(platform))[1]).toBe("runner-readiness");
    }
  });

  test("a full quit and cold relaunch replaces the single-instance observation", () => {
    for (const platform of ["macos", "windows", "linux"] as const) {
      const phases = describeGatePhases(optionsFor(platform));
      expect(phases).toContain("relaunch-consent");
      expect(phases).not.toContain("second-launch-consent");
    }
  });

  test("the report is red when any phase fails, and summarizes in report order", () => {
    const report: GateReport = {
      platform: "macos",
      format: "dmg",
      toVersion: "2.62.0",
      startedAt: "2026-09-21T00:00:00.000Z",
      phases: [
        { phase: "stage-npm-runtime", status: "pass", detail: "ok", evidence: {} },
        { phase: "install-artifact", status: "fail", detail: "broken", evidence: {} },
      ],
    };
    const summary = summarizeReport(report);
    expect(summary).toContain("FAIL  install-artifact — broken");
    expect(summary.startsWith("installed-artifact gate:")).toBe(true);
  });
});

describe("the refusal path is mutation-free (P0)", () => {
  const optionsFor = (platform: GateOptions["platform"]): GateOptions => ({
    platform,
    format: platform === "linux" ? "deb" : platform === "windows" ? "msi" : "dmg",
    artifact: "a",
    olderArtifact: "b",
    workDir: "w",
    toVersion: "2.62.0",
    fromVersion: "2.61.0",
    reportPath: "r.json",
    takeoverTimeoutMs: 1000,
  });

  test("a run refused for existing state makes zero mutating calls, cleanup included", async () => {
    const calls: string[] = [];
    const killed: number[] = [];
    const written: string[] = [];
    const directories: string[] = [];
    const deps: GateDeps = {
      // Every command answers "absent" except the default-home state file, which
      // fileExists reports as present — the refusal trigger.
      run: async spec => {
        calls.push([spec.file, ...spec.args].join(" "));
        return { ok: false, exitCode: 1, stdout: "", stderr: "" };
      },
      pidAlive: () => false,
      killProcess: pid => killed.push(pid),
      fileExists: path => path.endsWith(".opencodex/service-state.json"),
      readJsonFile: () => undefined,
      writeTextFile: path => { written.push(path); },
      makeDir: path => { directories.push(path); },
      fetchJson: async () => ({ ok: false, status: 0, body: undefined }),
      spawnLogged: () => { throw new Error("refusal must never spawn"); },
      serveMockProvider: () => { throw new Error("refusal must never serve the mock"); },
      digestFile: () => null,
      homeDir: () => "/fake-home",
      sleep: () => Promise.resolve(),
      readTextFile: () => "{}",
    };

    const report = await runGate(optionsFor("macos"), deps);

    expect(report.ok).toBe(false);
    expect(report.phases[0]?.phase).toBe("preflight-isolation");
    expect(report.phases[0]?.status).toBe("fail");
    // Only read-only probes may have run: the registration probes, the default-state
    // file check and the app process probe. Nothing that installs, uninstalls, kills,
    // writes outside the report, or registers a service.
    const allowedProbeBinaries = new Set(["launchctl", "pgrep"]);
    for (const call of calls) {
      const binary = call.split(" ")[0]!;
      expect(allowedProbeBinaries.has(binary), `mutating call reached on refusal: ${call}`).toBe(true);
    }
    expect(killed).toEqual([]);
    expect(written).toEqual(["r.json"]);
    // Even the gate's own scratch dirs are created only after the preflight passes.
    expect(directories).toEqual([]);
    // And the refusal was the reason: no other phase ran.
    expect(report.phases.map(phase => phase.phase)).toEqual(["preflight-isolation", "cleanup"]);
  });
});

describe("installed-gate platform adapters", () => {
  test("every adapter declares its external commands", () => {
    for (const adapter of [macosAdapter(okRunner), windowsAdapter(okRunner), linuxAdapter(okRunner)]) {
      expect(adapter.dependencies().length).toBeGreaterThan(0);
      for (const dependency of adapter.dependencies()) {
        // Command names resolve through PATH; a few system tools are invoked by their
        // absolute path (PlistBuddy) and are declared that way.
        expect(dependency).toMatch(/^([a-z0-9.-]+|\/[a-zA-Z0-9._/-]+)$/);
      }
    }
  });

  test("dependency lists enumerate exactly what the adapters shell out to", () => {
    expect(new Set(macosAdapter(okRunner).dependencies())).toEqual(
      new Set(["hdiutil", "osascript", "pgrep", "launchctl", "cp", "rm", "/usr/libexec/PlistBuddy"]),
    );
    expect(new Set(windowsAdapter(okRunner).dependencies())).toEqual(
      new Set(["msiexec", "powershell", "schtasks", "sc"]),
    );
    expect(new Set(linuxAdapter(okRunner).dependencies())).toEqual(
      new Set(["dpkg", "dpkg-deb", "dpkg-query", "xdotool", "pgrep", "systemctl", "sudo", "cp", "chmod", "kill", "rm"]),
    );
  });

  test("registration evidence covers the manager AND the on-disk artifact", () => {
    expect(macosAdapter(okRunner).registrationFiles()).toEqual(["Library/LaunchAgents/com.opencodex.proxy.plist"]);
    expect(linuxAdapter(okRunner).registrationFiles()).toEqual([".config/systemd/user/opencodex-proxy.service"]);
  });

  test("the npm launcher is resolved inside the staged prefix, never PATH", () => {
    expect(macosAdapter(okRunner).npmLauncher("/prefix")).toBe("/prefix/node_modules/.bin/ocx");
    expect(linuxAdapter(okRunner).npmLauncher("/prefix")).toBe("/prefix/node_modules/.bin/ocx");
    expect(windowsAdapter(okRunner).npmLauncher("C:\\prefix")).toBe("C:\\prefix\\node_modules\\.bin\\ocx.cmd");
  });

  test("registration state is tri-state: present, absent, and unknown refuse differently", async () => {
    const scriptRunner = (responses: Array<{ ok: boolean; stdout?: string; stderr?: string }>) => {
      const queue = [...responses];
      return {
        run: async (): Promise<ProcessEvidence> => {
          const next = queue.shift() ?? { ok: false };
          return { ok: next.ok, exitCode: next.ok ? 0 : 1, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
        },
        mkdir: () => {},
        fileExists: () => false,
        homeDir: () => "/fake-home",
      };
    };
    // A clean "could not find" is absence...
    expect(await macosAdapter(scriptRunner([{ ok: false, stderr: "Could not find service \"com.opencodex.proxy\"" }])).registrationState()).toBe("absent");
    // ...a manager error is unknown, and unknown must never authorize mutation.
    expect(await macosAdapter(scriptRunner([{ ok: false, stderr: "Bootstrap failed: 5: Input/output error" }])).registrationState()).toBe("unknown");
    // A disabled systemd unit EXISTS — is-enabled exits 1 with "disabled".
    expect(await linuxAdapter(scriptRunner([{ ok: false, stdout: "disabled" }])).registrationState()).toBe("present");
    expect(await linuxAdapter(scriptRunner([{ ok: false, stderr: "Failed to get unit file state: No such file or directory" }, { ok: false, stderr: "could not be found" }])).registrationState()).toBe("absent");
    // Windows probes both the task and the native WinSW service.
    const windowsCalls: string[] = [];
    const windowsRunner = {
      run: async (spec: { file: string; args: string[] }): Promise<ProcessEvidence> => {
        windowsCalls.push([spec.file, ...spec.args].join(" "));
        // Each manager reports absence in its own words.
        const stderr = spec.file === "sc.exe"
          ? "[SC] OpenService FAILED 1060: The specified service does not exist as an installed service."
          : "ERROR: The system cannot find the file specified.";
        return { ok: false, exitCode: 1, stdout: "", stderr };
      },
      mkdir: () => {},
      fileExists: () => false,
      homeDir: () => "/fake-home",
    };
    expect(await windowsAdapter(windowsRunner).registrationState()).toBe("absent");
    expect(windowsCalls.some(call => call.includes("opencodex-proxy-native"))).toBe(true);
    expect(windowsCalls.some(call => call.includes("opencodex-proxy"))).toBe(true);
  });

  test("Windows and Linux tray automation is operator-supplied, never guessed", () => {
    expect(windowsAdapter(okRunner).trayQuit()).toBeNull();
    expect(linuxAdapter(okRunner).trayQuit()).toBeNull();
    expect(macosAdapter(okRunner).trayQuit()).not.toBeNull();
  });

  test("macOS tray actions are scoped to the OpenCodex process, not a global index", () => {
    const quit = macosAdapter(okRunner).trayQuit();
    expect(quit?.args.join(" ")).toContain('process "OpenCodex"');
  });

  test("every adapter can probe window visibility after a gesture", () => {
    expect(macosAdapter(okRunner).windowVisible().file).toBe("osascript");
    expect(windowsAdapter(okRunner).windowVisible().file).toBe("powershell");
    expect(linuxAdapter(okRunner).windowVisible().file).toBe("xdotool");
  });

  test("elevation cancellation is scoped to sighted pids", () => {
    expect(linuxAdapter(okRunner).cancelElevation([])).toBeNull();
    const cancel = linuxAdapter(okRunner).cancelElevation([111, 222]);
    expect(cancel?.file).toBe("kill");
    expect(cancel?.args).toEqual(["111", "222"]);
  });

  test("elevation monitoring watches pkexec AND the plugin's zenity/kdialog fallbacks", () => {
    // The pinned updater falls back pkexec -> zenity/kdialog -> sudo after a cancel;
    // a gate that watches only pkexec would call a retry "cancelled".
    const probe = linuxAdapter(okRunner).elevationProbe();
    expect(probe?.args.join(" ")).toContain("pkexec");
    expect(probe?.args.join(" ")).toContain("zenity");
    expect(probe?.args.join(" ")).toContain("kdialog");
    expect(macosAdapter(okRunner).elevationProbe()).toBeNull();
  });

  test("the deb version probe exists; AppImage updates are proven by digest instead", () => {
    expect(linuxAdapter(okRunner).installedVersion("deb", "opencodex-desktop")?.file).toBe("dpkg-query");
    expect(linuxAdapter(okRunner).installedVersion("appimage")).toBeNull();
  });

  test("process probes come from the adapter, so the engine stays platform-neutral", () => {
    expect(macosAdapter(okRunner).appNameProbe().file).toBe("pgrep");
    expect(windowsAdapter(okRunner).appNameProbe().file).toBe("powershell");
    // Scoped probes bind to THIS install's path, so cleanup can never match a process
    // from a different installation.
    expect(linuxAdapter(okRunner).appProcessProbe("/gate/work/apps").args).toContain("/gate/work/apps");
    expect(linuxAdapter(okRunner).childPids(42).args).toContain("42");
  });
});

describe("installed-gate sources carry no operator detail", () => {
  const sources = [
    readFileSync(repoPath("desktop", "scripts", "installed-gate.ts"), "utf8"),
    readFileSync(repoPath("desktop", "scripts", "installed-gate-platforms.ts"), "utf8"),
  ];

  test("no absolute user paths, host names or addresses appear in the drivers", () => {
    for (const source of sources) {
      expect(source).not.toMatch(/\/Users\/\w/);
      expect(source).not.toMatch(/C:\\Users/);
      // Loopback is the proxy's own listener, not operator detail; everything else is.
      expect(source).not.toMatch(/\b(?!127\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(source).not.toMatch(/\b\w+\.local\b/);
    }
  });
});

describe("installed-artifact gate workflow", () => {
  const text = readFileSync(repoPath(".github", "workflows", "desktop-installed-gate.yml"), "utf8");
  const workflow = Bun.YAML.parse(text) as {
    on?: Record<string, unknown> | string[];
    permissions?: Record<string, string>;
    jobs?: Record<string, {
      "runs-on"?: string | string[];
      "timeout-minutes"?: number;
      steps?: Array<{ name?: string; uses?: string; run?: string; if?: string }>;
    }>;
  };
  const jobs = workflow.jobs ?? {};
  type Job = NonNullable<typeof jobs>[string] & {
    environment?: string;
    steps?: Array<{ name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown> }>;
  };

  test("it is dispatch-only: a stateful GUI machine must never run because a push happened", () => {
    const triggers = Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {});
    expect(triggers).toEqual(["workflow_dispatch"]);
  });

  test("least privilege: read-only contents and nothing else", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("every platform job targets a self-hosted gate runner with a bounded timeout", () => {
    const gateJobs = Object.entries(jobs).filter(([name]) => name !== "report");
    expect(gateJobs.map(([name]) => name)).toEqual(["macos", "windows", "linux"]);
    for (const [, job] of gateJobs) {
      const runsOn = Array.isArray(job["runs-on"]) ? job["runs-on"] : [job["runs-on"]];
      expect(runsOn).toContain("self-hosted");
      expect(runsOn?.some(label => typeof label === "string" && label.startsWith("opencodex-gate-"))).toBe(true);
      expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(30);
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(120);
    }
  });

  test("the gate report is uploaded even when the gate failed", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const uploads = (job.steps ?? []).filter(step => step.uses?.startsWith("actions/upload-artifact@"));
      expect(uploads.length, `${name} must upload its report`).toBe(1);
      expect(uploads[0]?.if).toContain("always()");
    }
  });

  test("all actions are pinned to full commit SHAs", () => {
    // Parse every uses: value rather than pattern-matching a few known-bad refs:
    // a short SHA or an arbitrary branch name is not an immutable pin either.
    const usesValues: string[] = [];
    for (const job of Object.values(jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses) usesValues.push(step.uses);
      }
    }
    expect(usesValues.length).toBeGreaterThan(0);
    for (const uses of usesValues) {
      const isLocal = uses.startsWith("./");
      const pinnedSha = /^[^@]+@([0-9a-f]{40})$/.exec(uses);
      expect(isLocal || pinnedSha !== null, `${uses} must be a local action or a full-SHA pin`).toBe(true);
    }
  });

  test("GUI automation inputs are hook names, never command text", () => {
    const dispatch = (workflow.on as Record<string, { inputs?: Record<string, unknown> }>).workflow_dispatch;
    const inputNames = Object.keys(dispatch?.inputs ?? {});
    expect(inputNames).toContain("consent-hook");
    expect(inputNames).toContain("tray-quit-hook");
    expect(inputNames).toContain("elevate-accept-hook");
    for (const name of inputNames) {
      expect(name).not.toMatch(/command$/);
    }
  });

  test("the npm package is never constructed from raw input", () => {
    // The driver derives the spec from the repository's own package.json; a workflow
    // that interpolates a package name would reopen npm alias injection.
    expect(text).not.toContain("--npm-package");
  });

  test("every gate job sits behind a required-review environment and checks out protected dev", () => {
    // The runners install software and hold sudo; the workflow must never execute a
    // dispatcher-selected ref on them.
    for (const [name, job] of Object.entries(jobs) as Array<[string, Job]>) {
      expect(job.environment, `${name} must declare the gated environment`).toBe("opencodex-desktop-gate");
      const checkout = (job.steps ?? []).find(step => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.ref, `${name} must check out the protected integration branch`).toBe("dev");
    }
  });

  test("dispatch inputs reach shell code through env, never by interpolation", () => {
    for (const job of Object.values(jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.run === "string") {
          expect(step.run).not.toContain("${{ inputs.");
          expect(step.run).not.toContain("${{ github.event.inputs.");
        }
      }
    }
  });

  test("linux runs both update formats through the gate", () => {
    const linux = jobs.linux as { strategy?: { matrix?: { format?: string[] } } } | undefined;
    expect(linux?.strategy?.matrix?.format).toEqual(["deb", "appimage"]);
  });
});

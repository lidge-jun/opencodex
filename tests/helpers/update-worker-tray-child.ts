// Isolated module mocks exercise the default Windows worker handoff, not trayHandoffFn.
import { mock } from "bun:test";
import { repoPath } from "./repo-root";

const [home, scenario] = process.argv.slice(2);
if (!home || !scenario || process.env.OPENCODEX_HOME !== home) throw new Error("isolated fixture home required");
const calls: string[] = [];
const commands: string[][] = [];
let replacements = 0;
let running = scenario.startsWith("running-");
let statusReads = 0;
const failedHandoff = scenario === "running-status-start-fail" || scenario === "running-cleanup-fail";
const tray = await import("../../src/tray/windows");
function status() {
  calls.push("status"); statusReads++;
  if (scenario === "initial-status-fail" || failedHandoff && statusReads > 1) throw new Error("fixture tray status unavailable");
  return { installed: scenario !== "absent", running };
}
mock.module(repoPath("src/tray/windows.ts"), () => ({ ...tray,
  getWindowsTrayStatus: status,
  stopWindowsTray: () => { calls.push("stop"); running = false; return status(); },
  startWindowsTray: () => { calls.push("native-start"); throw new Error("fixture first tray restore failed"); },
}));
const { readUpdateJob, runGuiUpdateWorker } = await import("../../src/update/job");
const io = {
  platform: "win32" as const,
  checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest" as const,
    installer: "npm" as const, updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
  integrityFn: () => ({ ok: true as const, integrity: "sha512-testfixturevalue000000000" }),
  cachePreflightFn: () => ({ ok: true, reason: "ok" }),
  serviceHomeAuthorityFn: () => ({ kind: "same" as const }),
  launcherSupportsUpdateHomeFn: () => true,
  runCommandFn: () => { replacements++; return { status: 0, signal: null }; },
  trayCommandFn: (_job: unknown, _bin: string, args: string[]) => {
    commands.push(args.slice(1));
    if (scenario === "running-cleanup-fail") throw new Error("fixture launcher restore failed");
    return { status: 0, signal: null };
  },
};
await runGuiUpdateWorker("default-tray", "latest", false, io);
const job = readUpdateJob("default-tray");
console.log(`TRAY_WORKER_PROBE:${JSON.stringify({ calls, commands, replacements, status: job?.status, restarted: job?.restarted, error: job?.error })}`);

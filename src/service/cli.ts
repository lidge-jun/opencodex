import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { restoreNativeCodexAsync } from "../codex/inject";
import { stripGrokConfig } from "../grok/inject";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import { statusWinswRaw, type WinswStatus } from "../lib/winsw";
import { withWindowsServiceMutationLock } from "../lib/windows-service-mutation-lock";
import { maybeShowStarPrompt } from "../cli/star-prompt";
import { serviceStatusReport } from "./diagnostics";
import { assertServiceEnvironmentMatchesInstall, assertServiceAuthEnvironment } from "./guards";
import { resolveServiceListenPort, reportServiceServing } from "./health";
import { platformOps, proxyStillLiveAfterStop, stopTrackedProxyForServiceCommand, installServiceSafely, installFreshWindowsSchedulerSafely, removeServiceInstallState, isServiceInstalled } from "./orchestration";
import { repairService } from "./repair";
import type { ServiceRepairVerb } from "./repair";
import { TASK, plistPath, readServiceBackend } from "./state";
import type { ServiceBackend } from "./state";
import { unitPath } from "./systemd";
import { inspectWindowsSchedulerServiceStatus, schtasksErrorDetail, probeWindowsSchedulerTask } from "./windows-scheduler";
import type { WindowsSchedulerTaskProbe } from "./windows-scheduler";
import { win32 } from "node:path";
import { serviceDiagnosticsSummary } from "./diagnostics";

/**
 * `restart` is NO LONGER folded into `repair`.
 *
 * It used to be, and on macOS that made it a lie: `repair` now returns early when the plist
 * is already current and the job is loaded from it (#4236), so `ocx service restart` of a
 * healthy service restarted nothing and the operator had to run `launchctl kickstart -k` by
 * hand. The two verbs share the whole repair path and diverge only in `repairService`, which
 * kicks the launchd job the no-op left running. A BARE `ocx service` still maps to `repair`
 * (see {@link selectServiceSubcommand}): it is an idempotent "make it current", not a
 * request to bounce a healthy hub.
 */
export function normalizeServiceSubcommand(sub?: string): string {
  return sub ?? "install";
}

export interface ParsedServiceArgs {
  sub: string;
  backend: ServiceBackend | null;
  invalid: string[];
}

export type ServiceInstallationState = "installed" | "absent" | "unknown";

export interface ServiceInstallationProbe {
  state: ServiceInstallationState;
  detail?: string;
}

export interface ServiceInstallationProbeHooks {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  probeWindowsTask?: () => WindowsSchedulerTaskProbe;
  nativeStatus?: () => WinswStatus;
}

/**
 * Read only enough registration state to choose between install and repair.
 * Windows must keep query failure distinct from proven absence: treating an
 * unreadable scheduler/SCM as absent would send a bare command into the
 * elevated registration path and recreate the original #2287 failure.
 */
export function probeServiceInstallation(
  hooks: ServiceInstallationProbeHooks = {},
): ServiceInstallationProbe {
  const platform = hooks.platform ?? process.platform;
  const exists = hooks.exists ?? existsSync;
  if (platform === "darwin") {
    return { state: exists(plistPath()) ? "installed" : "absent" };
  }
  if (platform === "linux") {
    return { state: exists(unitPath()) ? "installed" : "absent" };
  }
  if (platform !== "win32") return { state: "absent" };

  let scheduler: WindowsSchedulerTaskProbe;
  try {
    scheduler = (hooks.probeWindowsTask ?? probeWindowsSchedulerTask)();
  } catch (cause) {
    scheduler = { status: "unknown", detail: schtasksErrorDetail(cause) };
  }
  let native: WinswStatus;
  try {
    native = (hooks.nativeStatus ?? statusWinswRaw)();
  } catch {
    native = "unknown";
  }

  if (scheduler.status === "present" || native === "started" || native === "stopped") {
    return { state: "installed" };
  }
  if (scheduler.status === "unknown" || native === "unknown") {
    const parts = [
      scheduler.status === "unknown" ? `Task Scheduler: ${scheduler.detail}` : null,
      native === "unknown" ? "WinSW status could not be determined" : null,
    ].filter((part): part is string => Boolean(part));
    return { state: "unknown", detail: parts.join("; ") };
  }
  return { state: "absent" };
}

/**
 * A bare invocation is an idempotent "make the installed service current"
 * operation. First-time setup still installs, but an existing registration must
 * use the repair path so Windows avoids unconditional elevated registration; repair may
 * still refresh a stale scheduler definition.
 * Backend flags remain an explicit install request because they select which
 * registration mechanism to create.
 */
export function selectServiceSubcommand(
  parsed: ParsedServiceArgs,
  options: { hasExplicitSubcommand: boolean; installed: boolean },
): string {
  if (!options.hasExplicitSubcommand && parsed.backend === null && options.installed) return "repair";
  return parsed.sub;
}

export type ServiceCommandPlan =
  | { ok: true; parsed: ParsedServiceArgs; command: string }
  | { ok: false; message: string };

export function planServiceCommand(
  args: string[],
  options: { platform?: NodeJS.Platform; probeInstallation?: () => ServiceInstallationProbe } = {},
): ServiceCommandPlan {
  const parsed = parseServiceArgs(args);
  if (parsed.invalid.length > 0) {
    return { ok: false, message: `Unknown service option: ${parsed.invalid.join(" ")}` };
  }
  if (parsed.backend && parsed.sub !== "install") {
    return { ok: false, message: "--native/--scheduler apply to `ocx service install` only; other subcommands use the installed backend." };
  }
  if (parsed.backend === "native" && (options.platform ?? process.platform) !== "win32") {
    return { ok: false, message: "--native (WinSW) is Windows-only." };
  }

  const hasExplicitSubcommand = args.some(arg => !arg.startsWith("--"));
  let installed = false;
  if (!hasExplicitSubcommand && parsed.backend === null) {
    const probe = (options.probeInstallation ?? probeServiceInstallation)();
    if (probe.state === "unknown") {
      const suffix = probe.detail ? ` (${probe.detail})` : "";
      return {
        ok: false,
        message: `Could not safely determine whether the service is installed${suffix}. Run 'ocx service status' and retry; use explicit 'ocx service install' only after confirming it is absent.`,
      };
    }
    installed = probe.state === "installed";
  }
  return {
    ok: true,
    parsed,
    command: selectServiceSubcommand(parsed, { hasExplicitSubcommand, installed }),
  };
}

/**
 * `ocx service [sub] [--native|--scheduler]`. The first non-flag token is the
 * subcommand; backend flags are only meaningful for `install` (validated by the caller).
 */
export function parseServiceArgs(args: string[]): ParsedServiceArgs {
  let sub: string | undefined;
  let backend: ServiceBackend | null = null;
  const invalid: string[] = [];
  for (const arg of args) {
    if (arg === "--native") {
      if (backend === "scheduler") { invalid.push("--native (conflicts with --scheduler)"); continue; }
      backend = "native";
    }
    else if (arg === "--scheduler") {
      if (backend === "native") { invalid.push("--scheduler (conflicts with --native)"); continue; }
      backend = "scheduler";
    }
    else if (arg.startsWith("--")) invalid.push(arg);
    else if (sub === undefined) sub = arg;
    else invalid.push(arg);
  }
  return { sub: normalizeServiceSubcommand(sub), backend, invalid };
}

export async function serviceCommand(...args: (string | undefined)[]): Promise<void> {
  const filteredArgs = args.filter((a): a is string => Boolean(a));
  const execute = async (): Promise<void> => {
    // Planning reads manager state. Repeat it only after the writer lock is held, otherwise a
    // bare command can choose install from a snapshot another service command already changed.
    const plan = planServiceCommand(filteredArgs);
    if (!plan.ok) {
      console.error(plan.message);
      process.exit(1);
    }
    const { parsed, command } = plan;
  if (command === "repair" || command === "restart") {
    const verb: ServiceRepairVerb = command === "restart" ? "restart" : "repair";
    assertServiceEnvironmentMatchesInstall();
    assertServiceAuthEnvironment();
    // A throw used to escape straight to the top level, so the one command that can
    // leave a macOS hub evicted never reached its own serving check (#4236, defect 1f).
    // Report the failure, then still ask whether anything is listening: on darwin the
    // rollback inside installLaunchd may have brought the previous job back, and on
    // Windows the preserve/restart protocol may have done the same. The operator needs
    // both halves of that answer, and the exit code stays non-zero either way.
    let repairError: unknown;
    try {
      await repairService({ verb });
    } catch (error) {
      repairError = error;
      console.error(`❌ Service ${verb} failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    // All three platforms: a repair that reports success while nothing serves is the
    // defect class this unit exists to close. Windows bakes its port into the
    // scheduler wrapper or the WinSW XML, both of which installedServiceListenPort()
    // now reads.
    await reportServiceServing(verb === "restart" ? "restarted" : "repaired");
    if (repairError !== undefined) process.exitCode = 1;
    return;
  }
  // Non-install subcommands follow the backend recorded at install time (state v2).
  const backend: ServiceBackend = parsed.backend ?? (process.platform === "win32" ? readServiceBackend() : "scheduler");
  const ops = platformOps(backend);
  if (!ops) {
    console.error("ocx service supports macOS (launchd), Windows (Task Scheduler), and Linux (systemd).");
    process.exit(1);
  }
  switch (command) {
    case "install":
      assertServiceEnvironmentMatchesInstall();
      assertServiceAuthEnvironment();
      // A manually started proxy can still own the configured port while the service
      // registration is absent or unloaded. Stop both the registered manager and any
      // tracked standalone listener before loading the freshly written service assets.
      // Otherwise launchd/Task Scheduler can register successfully while its child
      // restart-loops on EADDRINUSE, and the old standalone process makes the install
      // verification report a false success.
      try {
        if (process.platform === "win32" && backend === "scheduler") {
          const scheduler = probeWindowsSchedulerTask(TASK);
          if (scheduler.status === "unknown") {
            throw new Error(`Task Scheduler state could not be verified before install: ${scheduler.detail}`);
          }
          if (scheduler.status === "absent") {
            await installFreshWindowsSchedulerSafely();
          } else {
            await installServiceSafely(backend, ops.install);
          }
        } else {
          await installServiceSafely(backend, ops.install);
        }
      } catch (error) {
        console.error(`❌ Service install cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        break;
      }
      // The wrapper was written moments ago in this process, so the configured port
      // and the baked one cannot have diverged yet — unlike `start`, which reads the
      // installed artifact instead.
      await reportServiceServing("installed", { port: resolveServiceListenPort() });
      if (process.platform === "linux") console.log("   For auto-start on boot: loginctl enable-linger $USER");
      // Service users never reach the `ocx start` prompt: the proxy they run is the
      // supervised child, which always carries OCX_SERVICE=1. This command, though, is
      // hand-typed in a real terminal, so it is the one interactive moment they get.
      // Same one-time marker and same guards (TTY, gh auth, agent deferral) apply.
      await maybeShowStarPrompt();
      break;
    case "start":
      ops.start();
      await reportServiceServing("started");
      break;
    case "stop": {
      assertServiceEnvironmentMatchesInstall();
      // Only stop what is actually installed. The unguarded call ran a real `launchctl unload`
      // (and its Windows/Linux twins) even with nothing installed.
      if (ops.status() !== null || isServiceInstalled()) {
        ops.stop();
      }
      await stopTrackedProxyForServiceCommand();
      {
        // Verify rather than trust the stop command: a surviving wrapper respawns its child
        // seconds later, and restoring native Codex on top of a live proxy is the failure #764
        // reports as "stop reports success without stopping the proxy".
        const survivor = await proxyStillLiveAfterStop();
        if (survivor) {
          console.error(
            `❌ service stop did not take effect: a proxy is still listening on port ${survivor.port}.`
            + "\nNative Codex was NOT restored, because doing so while the proxy is running leaves"
            + " both pointing at each other. Check for a second service backend (`ocx service status`)"
            + " or a manually started proxy, then re-run `ocx service stop`.",
          );
          process.exitCode = 1;
          break;
        }
        const restore = await restoreNativeCodexAsync();
        if (restore.success) console.log("✅ service stopped + native Codex restored.");
        else console.error(`⚠️ service stopped, but native Codex restore FAILED: ${restore.message}\nRun \`ocx restore\` (or check $CODEX_HOME/config.toml) before using native Codex.`);
        if (!restore.success) process.exitCode = 1;
        // The Grok fence is the other managed config this command owns. Leaving it behind
        // pointed grok at a dead endpoint while native Codex was already restored.
        const grok = stripGrokConfig();
        if (grok.changed) console.log(`↩️  ${grok.message}`);
        else if (!grok.ok) {
          // A failed strip leaves Grok aimed at a proxy this command just stopped. Exiting
          // 0 tells a script the teardown finished when half of it did not.
          console.error(`⚠️  ${grok.message}`);
          process.exitCode = 1;
        }
      }
      break;
    }
    case "status": {
      if (process.platform === "win32" && backend === "scheduler") {
        console.log(await inspectWindowsSchedulerServiceStatus());
      } else {
        // Replaces raw `ops.status()` output, which on darwin is a `launchctl list`
        // line: registration reported as if it were service. serviceStatusReport
        // subsumes the not-installed case and adds the serving / stale-plist split.
        console.log(await serviceStatusReport());
      }
      console.log(`Diagnostics: ${serviceDiagnosticsSummary()}`);
      break;
    }
    case "uninstall":
    case "remove":
      assertServiceEnvironmentMatchesInstall();
      try { ops.stop(); } catch (err) {
        console.warn(`⚠️  Service stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await stopTrackedProxyForServiceCommand();
      try {
        ops.uninstall();
      } catch (err) {
        console.error(`❌ Service uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error("The service may still be installed. Check with 'ocx service status' or remove manually.");
        process.exit(1);
      }
      {
        const restore = await restoreNativeCodexAsync();
        if (!restore.success) {
          console.error(`⚠️ native Codex restore FAILED: ${restore.message}\nRun \`ocx restore\` before using native Codex.`);
          process.exitCode = 1;
        }
        const grok = stripGrokConfig();
        if (grok.changed) console.log(`↩️  ${grok.message}`);
        else if (!grok.ok) {
          console.error(`⚠️  ${grok.message}`);
          process.exitCode = 1;
        }
      }
      removeServiceInstallState();
      try { if (existsSync(serviceApiTokenFilePath())) unlinkSync(serviceApiTokenFilePath()); } catch { /* best-effort */ }
      console.log("✅ service uninstalled.");
      break;
    default:
      console.error("Usage: ocx service [install|repair|restart|start|stop|status|uninstall|remove] [--native|--scheduler]");
      console.error("       With no subcommand, installs when absent or repairs/restarts an existing service.");
      console.error("       repair: refresh the installed backend, reloading it only when the definition changed; stale Windows tasks may request admin approval.");
      console.error("       restart: the same refresh, but always restarts the service — on macOS a healthy job is kickstarted in place.");
      console.error("       --native (Windows only): register a real SCM service via WinSW instead of Task Scheduler.");
      process.exit(1);
  }
  };

  const preliminary = parseServiceArgs(filteredArgs);
  const windowsMutation = process.platform === "win32"
    && preliminary.invalid.length === 0
    && preliminary.sub !== "status";
  if (windowsMutation) {
    await withWindowsServiceMutationLock(execute);
    return;
  }
  await execute();
}

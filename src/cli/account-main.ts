import { isAbsolute } from "node:path";
import { codexExecInvocation } from "../codex/exec-invocation";
import { resolveAndPersistCodexRuntime, type ResolveCodexRuntimeDeps } from "../codex/runtime";
import type { ResolveDeps, SpawnInvocation } from "../lib/win-exec";
import {
  apiError,
  apiJson,
  proxyUnreachable,
  resolveBaseUrl,
  type AccountDeps,
  type NativeMainLoginChild,
  type StageLeaseClock,
} from "./account-api";

const USAGE = `Usage:
  ocx account main doctor [--json]
  ocx account main list [--json]
  ocx account main register <label> [--json]
  ocx account main add <label>
  ocx account main reauth --device [--no-wait] [--json]
  ocx account main reauth status --flow <id> [--json]
  ocx account main reauth cancel --flow <id> [--json]
  ocx account main switch <profile-id-or-label> --yes [--json]
  ocx account main recover [--rollback --yes] [--json]

Native main login profiles change the physical Codex App/CLI login in the effective CODEX_HOME.
They are independent from the OpenCodex Pool selected by 'ocx account use openai'.`;

const STAGE_LEASE_SAFETY_MARGIN_MS = 30_000;

const systemStageLeaseClock: StageLeaseClock = {
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer),
};

interface PublicProfile {
  id: string;
  label: string;
  identityHint: string;
  state: "active" | "inactive";
}

export type NativeMainCodexLoginInvocationDeps =
  & ResolveDeps
  & Pick<ResolveCodexRuntimeDeps, "existsSync" | "execFileSync" | "configDir" | "readFileSync">;

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function reject(args: string[]): number {
  if (args.length > 0) console.error(`Unexpected argument(s): ${args.join(", ")}`);
  console.error(USAGE);
  return 1;
}

function effectiveCodexHome(result: Record<string, unknown>): string {
  return typeof result.effectiveCodexHome === "string" && result.effectiveCodexHome.length > 0
    ? result.effectiveCodexHome
    : "the effective CODEX_HOME";
}

function printProfiles(profiles: PublicProfile[]): void {
  if (profiles.length === 0) { console.log("No native main login profiles registered."); return; }
  const rows = profiles.map(profile => [profile.state === "active" ? "*" : " ", profile.label, profile.id, profile.identityHint]);
  const header = ["", "LABEL", "PROFILE ID", "IDENTITY"];
  const widths = header.map((value, index) => Math.max(value.length, ...rows.map(row => row[index]!.length)));
  const line = (columns: string[]) => columns.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  console.log([line(header), ...rows.map(line)].join("\n"));
}

export function nativeMainCodexLoginInvocation(
  platform: NodeJS.Platform = process.platform,
  deps: NativeMainCodexLoginInvocationDeps = {},
): SpawnInvocation {
  const command = resolveAndPersistCodexRuntime({
    env: deps.env ?? process.env,
    platform,
    existsSync: deps.existsSync,
    execFileSync: deps.execFileSync,
    configDir: deps.configDir,
    readFileSync: deps.readFileSync,
    discoverAlternatives: false,
  }).runtime.command || "codex";
  return codexExecInvocation(command, ["login"], platform, deps);
}

function spawnOfficialCodexLogin(codexHome: string): NativeMainLoginChild {
  const invocation = nativeMainCodexLoginInvocation();
  const child = Bun.spawn([invocation.file, ...invocation.args], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  return child;
}

function abortableDelay(ms: number, signal: AbortSignal, clock: StageLeaseClock): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = clock.setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clock.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function maintainStageLease(
  deps: AccountDeps,
  baseUrl: string,
  stageId: string,
  writerToken: string,
  initialLeaseExpiresAt: number,
  heartbeatIntervalMs: number,
  child: NativeMainLoginChild,
  signal: AbortSignal,
  clock: StageLeaseClock,
): Promise<{ lost: boolean }> {
  let leaseExpiresAt = initialLeaseExpiresAt;
  for (;;) {
    if (signal.aborted) return { lost: false };
    const deadlineAt = leaseExpiresAt - STAGE_LEASE_SAFETY_MARGIN_MS;
    if (clock.now() >= deadlineAt) {
      try { child.kill(); } catch { /* child exit below is authoritative */ }
      return { lost: true };
    }

    const heartbeatAbort = new AbortController();
    const deadlineReached = Symbol("heartbeat-deadline");
    const parentCancelled = Symbol("heartbeat-parent-cancelled");
    let resolveInterruption!: (result: typeof deadlineReached | typeof parentCancelled) => void;
    const interruption = new Promise<typeof deadlineReached | typeof parentCancelled>(resolve => {
      resolveInterruption = resolve;
    });
    const cancelHeartbeat = () => {
      heartbeatAbort.abort();
      resolveInterruption(parentCancelled);
    };
    signal.addEventListener("abort", cancelHeartbeat, { once: true });
    const deadlineTimer = clock.setTimeout(() => {
      heartbeatAbort.abort();
      resolveInterruption(deadlineReached);
    }, Math.max(0, deadlineAt - clock.now()));
    const heartbeatRequest = apiJson(
      deps,
      baseUrl,
      "POST",
      "/api/native-main-profiles/stage/heartbeat",
      { stageId, writerToken },
      { signal: heartbeatAbort.signal },
    );
    const heartbeat = await Promise.race([heartbeatRequest, interruption]);
    clock.clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", cancelHeartbeat);
    if (signal.aborted) return { lost: false };
    if (heartbeat === parentCancelled) return { lost: false };
    if (heartbeat === deadlineReached) {
      try { child.kill(); } catch { /* child exit below is authoritative */ }
      return { lost: true };
    }
    if (heartbeat.status === 200 && typeof heartbeat.json.leaseExpiresAt === "number") {
      leaseExpiresAt = heartbeat.json.leaseExpiresAt;
      await abortableDelay(Math.min(heartbeatIntervalMs, Math.max(0, leaseExpiresAt - STAGE_LEASE_SAFETY_MARGIN_MS - clock.now())), signal, clock);
      continue;
    }
    if (heartbeat.status === 0 && clock.now() < leaseExpiresAt - STAGE_LEASE_SAFETY_MARGIN_MS) {
      await abortableDelay(Math.min(5_000, heartbeatIntervalMs, leaseExpiresAt - STAGE_LEASE_SAFETY_MARGIN_MS - clock.now()), signal, clock);
      continue;
    }
    try { child.kill(); } catch { /* child exit below is authoritative */ }
    return { lost: true };
  }
}

export async function cmdNativeMainAccount(args: string[], deps: AccountDeps): Promise<number> {
  const sub = args.shift();
  const wantsJson = flag(args, "--json");
  const confirmed = flag(args, "--yes");
  const rollback = flag(args, "--rollback");
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  if (sub === "reauth") {
    // #3898: same-identity device reauth of the native __main__ slot via the
    // dedicated management namespace; /api/codex-auth/login stays pool-only.
    if (confirmed || rollback) return reject(args);
    const noWait = flag(args, "--no-wait");
    const device = flag(args, "--device");
    const flowIndex = args.indexOf("--flow");
    const flowId = flowIndex >= 0 ? args.splice(flowIndex, 2)[1] : undefined;
    const action = args.shift();
    if (args.length > 0) return reject(args);

    const printStatus = (status: Record<string, unknown>): void => {
      if (wantsJson) { console.log(JSON.stringify(status, null, 2)); return; }
      console.log("status: " + String(status.status ?? "unknown"));
      if (typeof status.verificationUrl === "string" && status.verificationUrl) {
        console.log("url: " + status.verificationUrl);
      }
      if (typeof status.deviceCode === "string" && status.deviceCode) {
        console.log("deviceCode: " + status.deviceCode);
      }
      if (typeof status.code === "string" && status.code) {
        console.log("failure: " + status.code);
      }
    };

    if (action === "status" || action === "cancel") {
      if (!flowId || device || noWait) return reject(args);
      const query = "/api/codex-auth/main/reauth-device?flowId=" + encodeURIComponent(flowId);
      const result = action === "status"
        ? await apiJson(deps, baseUrl, "GET", query)
        : await apiJson(deps, baseUrl, "DELETE", query);
      if (result.status === 0) return proxyUnreachable(result.transportError);
      if (result.status !== 200) return apiError(result.json, "failed to " + action + " the native main reauth", result.status);
      printStatus(result.json);
      return 0;
    }

    if (action !== undefined || !device) return reject(args);
    const started = await apiJson(deps, baseUrl, "POST", "/api/codex-auth/main/reauth-device");
    if (started.status === 0) return proxyUnreachable(started.transportError);
    if (started.status !== 200) return apiError(started.json, "failed to start the native main device reauth", started.status);
    const startFlowId = typeof started.json.flowId === "string" ? started.json.flowId : "";
    if (!startFlowId) {
      console.error("The proxy returned an invalid reauth flow.");
      return 1;
    }
    // The URL and human code arrive with the usercode response, a beat after start.
    let pending = started.json;
    const statusQuery = "/api/codex-auth/main/reauth-device?flowId=" + encodeURIComponent(startFlowId);
    for (let attempt = 0; attempt < 50 && !pending.deviceCode; attempt += 1) {
      await Bun.sleep(200);
      const polled = await apiJson(deps, baseUrl, "GET", statusQuery);
      if (polled.status === 200) pending = polled.json;
    }
    if (noWait) {
      printStatus({ flowId: startFlowId, ...pending });
      if (!wantsJson) console.log("follow up: ocx account main reauth status --flow " + startFlowId);
      return 0;
    }
    // Blocking wait bounded by the service flow expiry (15-minute grant + margin).
    const deadline = Date.now() + 16 * 60_000;
    for (;;) {
      if (pending.status !== "pending" && pending.status !== "committing") break;
      if (Date.now() >= deadline) {
        console.error("The reauth flow did not finish within the device grant window; check status with --flow " + startFlowId + ".");
        return 1;
      }
      await Bun.sleep(2_000);
      const polled = await apiJson(deps, baseUrl, "GET", statusQuery);
      if (polled.status === 0) return proxyUnreachable(polled.transportError);
      if (polled.status !== 200) return apiError(polled.json, "failed to poll the native main reauth", polled.status);
      pending = polled.json;
    }
    printStatus({ flowId: startFlowId, ...pending });
    return pending.status === "succeeded" ? 0 : 1;
  }

  if (sub === "doctor" || sub === "list") {
    if (args.length > 0 || confirmed || rollback) return reject(args);
    const path = sub === "doctor" ? "/api/native-main-profiles/doctor" : "/api/native-main-profiles";
    const result = await apiJson(deps, baseUrl, "GET", path);
    if (result.status === 0) return proxyUnreachable(result.transportError);
    if (result.status !== 200) return apiError(result.json, `failed to ${sub} native profiles`, result.status);
    if (wantsJson || sub === "doctor") console.log(JSON.stringify(result.json, null, 2));
    else printProfiles(Array.isArray(result.json.profiles) ? result.json.profiles as PublicProfile[] : []);
    return 0;
  }

  if (sub === "register") {
    const label = args.shift();
    if (!label || args.length > 0 || confirmed || rollback) return reject(args);
    const result = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/register", { label });
    if (result.status === 0) return proxyUnreachable(result.transportError);
    if (result.status !== 200) return apiError(result.json, "failed to register the current native login", result.status);
    if (wantsJson) console.log(JSON.stringify(result.json, null, 2));
    else console.log(`Registered '${label}' for ${effectiveCodexHome(result.json)}.`);
    return 0;
  }

  if (sub === "add") {
    const label = args.shift();
    if (!label || args.length > 0 || wantsJson || confirmed || rollback) return reject(args);
    const stage = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/stage", {});
    if (stage.status === 0) return proxyUnreachable(stage.transportError);
    if (stage.status !== 200) return apiError(stage.json, "failed to prepare native login staging", stage.status);
    const stageId = typeof stage.json.stageId === "string" ? stage.json.stageId : "";
    const writerToken = typeof stage.json.writerToken === "string" ? stage.json.writerToken : "";
    const stagingHome = typeof stage.json.stagingCodexHome === "string" ? stage.json.stagingCodexHome : "";
    const leaseExpiresAt = typeof stage.json.leaseExpiresAt === "number" ? stage.json.leaseExpiresAt : 0;
    const heartbeatIntervalMs = typeof stage.json.heartbeatIntervalMs === "number"
      ? Math.min(5 * 60_000, Math.max(deps.stageHeartbeatIntervalMinMs ?? 5_000, stage.json.heartbeatIntervalMs))
      : 60_000;
    const stageLeaseClock = deps.stageLeaseClock ?? systemStageLeaseClock;
    const stagedEffectiveHome = effectiveCodexHome(stage.json);
    let exitCode = 1;
    let finished = false;
    let leaseLost = false;
    try {
      if (!stageId || !writerToken || !isAbsolute(stagingHome) || leaseExpiresAt <= stageLeaseClock.now()) {
        throw new Error("The proxy returned an invalid staging session.");
      }
      console.error(`Effective CODEX_HOME: ${stagedEffectiveHome}`);
      console.error(`Starting official Codex login in restricted staging home: ${stagingHome}`);
      const child = deps.spawnCodexLoginImpl
        ? deps.spawnCodexLoginImpl(stagingHome)
        : deps.runCodexLoginImpl
          ? { exited: deps.runCodexLoginImpl(stagingHome), kill: () => {} }
          : spawnOfficialCodexLogin(stagingHome);
      const heartbeatAbort = new AbortController();
      const heartbeat = maintainStageLease(
        deps,
        baseUrl,
        stageId,
        writerToken,
        leaseExpiresAt,
        heartbeatIntervalMs,
        child,
        heartbeatAbort.signal,
        stageLeaseClock,
      );
      try {
        exitCode = await child.exited;
      } finally {
        heartbeatAbort.abort();
        leaseLost = (await heartbeat).lost;
      }
      if (leaseLost) throw new Error("The native-login staging lease was lost before login completed.");
      if (exitCode !== 0) throw new Error("Official Codex login did not complete successfully.");
      const finish = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/stage/finish", { stageId, writerToken, label });
      if (finish.status === 0) return proxyUnreachable(finish.transportError);
      if (finish.status !== 200) return apiError(finish.json, "failed to encrypt the staged native login", finish.status);
      finished = true;
      console.log(`Added encrypted native profile '${label}' for ${effectiveCodexHome(finish.json)}.`);
      return 0;
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : "Official Codex login failed."}`);
      return exitCode === 0 ? 1 : exitCode;
    } finally {
      if (stageId && !finished) {
        const cleanup = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/stage/cancel", { stageId, writerToken });
        if (cleanup.status !== 200 || cleanup.json.plaintextMayRemain === true) {
          console.error("Error: the proxy could not confirm native-login staging cleanup; run account main doctor.");
        }
      }
    }
  }

  if (sub === "switch") {
    const target = args.shift();
    if (!target || args.length > 0 || rollback || !confirmed) {
      if (!confirmed) console.error("Close Codex App/CLI, then pass --yes to confirm it is stopped.");
      return reject(args);
    }
    const result = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/switch", { target, confirmedStopped: true });
    if (result.status === 0) return proxyUnreachable(result.transportError);
    if (result.status !== 200) return apiError(result.json, "failed to switch the native login", result.status);
    if (wantsJson) console.log(JSON.stringify(result.json, null, 2));
    else {
      const profile = result.json.activeProfile as PublicProfile | undefined;
      console.log(`Native Codex login for ${effectiveCodexHome(result.json)} is now '${profile?.label ?? target}'. Restart Codex App/CLI before continuing.`);
    }
    return 0;
  }

  if (sub === "recover") {
    if (args.length > 0 || (rollback && !confirmed)) {
      if (rollback && !confirmed) console.error("--rollback changes the native login and requires --yes.");
      return reject(args);
    }
    const result = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/recover", rollback
      ? { rollback: true, confirmedStopped: true }
      : { rollback: false });
    if (result.status === 0) return proxyUnreachable(result.transportError);
    if (result.status !== 200) return apiError(result.json, "failed to recover the native-profile transaction", result.status);
    if (wantsJson) console.log(JSON.stringify(result.json, null, 2));
    else {
      const home = effectiveCodexHome(result.json);
      console.log(result.json.recovered === true
        ? `Recovery completed for ${home}: ${String(result.json.action ?? "converged")}.`
        : `No recovery journal is pending for ${home}.`);
    }
    return 0;
  }

  return reject(args);
}

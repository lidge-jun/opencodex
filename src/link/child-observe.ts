import { classifyUpdatePlanProbe, remoteUpdatePlanArgv, type SshResult } from "./child-gated-ocx";
import type { PlanClassification } from "./child-update-contract";
import type { ChildObservation } from "./child-observations";
import type { LinkPeerEntry } from "./peer-report";
import type { inspectRemoteChildRuntime } from "./remote-plant";
import { buildExecArgv, LinkSshArgumentError } from "./ssh-argv";
import { SshRunnerError, type SshRunner } from "./ssh-runner";
import type { LinkRecord } from "./store";
import { parseOcxVersion } from "./sync-fanout-classify";
import { parseStrictSemver } from "../lib/strict-semver";

export const OBSERVE_TIMEOUT_MS = 60_000;
export const OBSERVE_MAX_OUTPUT_BYTES = 65_536;

export interface ObserveDeps {
  runner: Pick<SshRunner, "run">; knownHostsFile: string; homeVersion: string;
  peer: (linkId: string) => LinkPeerEntry; platformOf: (record: LinkRecord) => Promise<"posix" | "windows">;
  inspect: typeof inspectRemoteChildRuntime; now: () => Date;
}

/**
 * Set only for a parsed plan. childNowMs is the Child's clock from the gate; startedAt is the Home's clock when the probe
 * was sent; platform is the one observe resolved, so the wp3 update runner never probes it again.
 */
export interface ObserveProbe { classification: PlanClassification; childNowMs: number | null; startedAt: number; platform: "posix" | "windows" }

/** observation is a whole ChildObservation with every carried field null; writers strip them with withoutCarriedFields. */
export interface ObserveOutcome {
  state: "succeeded" | "owner-action" | "unsupported" | "offline" | "failed"; reason: string | null;
  observation: ChildObservation | null; probe: ObserveProbe | null;
}

type ObservedFields = Pick<ChildObservation, "source" | "installedVersion" | "installKind" | "runtimeOwner" | "updateRoute" | "updateReason"
  | "targetVersion" | "updateInFlight">;

function observation(fields: ObservedFields, now: Date): ChildObservation {
  return {
    observedAt: now.toISOString(), ...fields,
    catalogPulledAt: null, catalogPulledEtag: null, catalogSyncedEtag: null, lastOperation: null, suppressedTarget: null,
    autoUpdateAttempts: null, pendingUpdateRecovery: null,
  };
}

const strictVersion = (value: string | null | undefined): string | null => typeof value === "string" && parseStrictSemver(value) ? value : null;
const peerVersion = (deps: ObserveDeps, record: LinkRecord): string | null => strictVersion(deps.peer(record.id).observed?.version);
const outcome = (state: ObserveOutcome["state"], reason: string | null, value: ChildObservation | null = null): ObserveOutcome =>
  ({ state, reason, observation: value, probe: null });

function ephemeral(now: Date): ObserveOutcome {
  // An ocx-child's version is a protocol constant (D10), so no version is stored.
  return outcome("succeeded", null, observation({ source: "peer", installedVersion: null, installKind: "ocx-child", runtimeOwner: null,
    updateRoute: "replant", updateReason: "ocx-child", targetVersion: null, updateInFlight: null }, now));
}

function runnerFailure(error: unknown): ObserveOutcome {
  if (error instanceof SshRunnerError && error.code === "output_limit") return outcome("failed", "ssh-output-limit");
  if (error instanceof SshRunnerError && error.code === "decode") return outcome("failed", "ssh-output-decode");
  return outcome("offline", "ssh-error");
}

/**
 * The observe operation (D3): one gated `ocx update --plan` over the link's pinned SSH channel, reduced to closed
 * tokens. It never changes an install. Client-initiated and ocx-child links never reach SSH; a pre-2.97 POSIX Child
 * costs one more read-only SSH call to read its version. No remote text is returned.
 */
export async function observeChild(record: LinkRecord, deps: ObserveDeps): Promise<ObserveOutcome> {
  if (record.direction === "client-initiated") {
    return { state: "unsupported", reason: "child-initiated", probe: null, observation: observation({ source: "peer",
      installedVersion: peerVersion(deps, record), installKind: "unknown", runtimeOwner: null, updateRoute: "none",
      updateReason: "child-initiated", targetVersion: null, updateInFlight: null }, deps.now()) };
  }
  if (record.childKind === "ephemeral") return ephemeral(deps.now());
  let platform: "posix" | "windows";
  try { platform = record.remotePlatform ?? await deps.platformOf(record); } catch { return outcome("offline", "platform-unknown"); }
  let argv: string[];
  try {
    argv = buildExecArgv({ alias: record.alias, knownHostsFile: deps.knownHostsFile, argv: remoteUpdatePlanArgv(deps.homeVersion, platform) });
  } catch (error) {
    if (error instanceof LinkSshArgumentError && error.message === "windows-command-too-long") return outcome("failed", "windows-command-too-long");
    if (error instanceof LinkSshArgumentError && error.message === "invalid Home version") return outcome("failed", "home-version-invalid");
    return outcome("failed", "ssh-argument-invalid");
  }
  const startedAt = deps.now().getTime();
  let result: SshResult;
  try {
    result = await deps.runner.run(argv, { timeoutMs: OBSERVE_TIMEOUT_MS, maxOutputBytes: OBSERVE_MAX_OUTPUT_BYTES });
  } catch (error) { return runnerFailure(error); }
  const peerFeatures = deps.peer(record.id).observed?.features ?? [];
  // Always pass the platform: the Windows script prints no entry marker and only this lets the classifier infer binary.
  const verdict = classifyUpdatePlanProbe(result, { homeVersion: deps.homeVersion, desktopUpdateRequest: peerFeatures.includes("desktop-update-request/1"), platform });
  switch (verdict.kind) {
    case "plan": {
      const { classification } = verdict;
      return { state: "succeeded", reason: null, probe: { classification, childNowMs: verdict.childNowMs, startedAt, platform },
        observation: observation({ source: "plan", installedVersion: strictVersion(classification.installedVersion),
          installKind: classification.installKind, runtimeOwner: classification.runtimeOwner, updateRoute: classification.updateRoute,
          updateReason: classification.updateReason, targetVersion: strictVersion(classification.targetVersion),
          updateInFlight: classification.updateInFlight }, deps.now()) };
    }
    case "ephemeral": return ephemeral(deps.now());
    case "legacy": {
      let installedVersion: string | null;
      let source: ChildObservation["source"];
      if (platform === "posix") {
        source = "inspect";
        try {
          const inspected = await deps.inspect(deps.runner, record.alias, deps.knownHostsFile, "posix");
          installedVersion = parseOcxVersion(inspected?.ocxVersionLine ?? "");
        } catch { installedVersion = null; }
      } else {
        // Windows inspection does not read the served census, so the peer report is the better source.
        source = "peer";
        installedVersion = peerVersion(deps, record);
      }
      return outcome("owner-action", "legacy-ocx", observation({ source, installedVersion, installKind: "unknown", runtimeOwner: null,
        updateRoute: "owner-action", updateReason: "legacy-ocx", targetVersion: null, updateInFlight: null }, deps.now()));
    }
    case "offline": return outcome("offline", "ssh-failed");
    case "failed": return outcome("failed", verdict.reason);
  }
}

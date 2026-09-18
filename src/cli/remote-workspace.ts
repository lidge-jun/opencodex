import type { RemoteWorkspaceDeviceState } from "../remote-control/workspace-device";
import {
  RemoteWorkspaceDeviceFileStore,
  pairRemoteWorkspaceDevice,
  remoteWorkspaceCapabilitiesForCommandRunner,
  runRemoteWorkspaceAgent,
  type PairRemoteWorkspaceDeviceOptions,
  type RemoteWorkspaceAgentRunStatus,
  type RemoteWorkspaceDeviceStateStore,
} from "../remote-control/workspace-device";
import { createPlatformRemoteWorkspaceCommandRunner } from "../remote-control/workspace-command-runner";
import {
  CliUsageError,
  readSecretLine,
  rejectArgs,
  takeFlag,
  takeJsonFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

export const REMOTE_WORKSPACE_USAGE = `Usage:
  ocx remote-workspace pair <hub-url> --pairing-code-stdin --root <absolute-path> [--root <absolute-path> ...] [--toolchain-root <absolute-directory> ...] [--executor-helper <absolute-file>] [--name <device-name>] [--json]
  ocx remote-workspace agent
  ocx remote-workspace status [--json]`;

export interface RemoteWorkspaceCliDeps extends RuntimeApiDeps {
  store?: RemoteWorkspaceDeviceStateStore;
  pair?: (options: PairRemoteWorkspaceDeviceOptions) => Promise<RemoteWorkspaceDeviceState>;
  runAgent?: typeof runRemoteWorkspaceAgent;
  signal?: AbortSignal;
  onStatus?: (status: RemoteWorkspaceAgentRunStatus) => void;
}

function takeRepeatedPathFlag(args: string[], flag: "--root" | "--toolchain-root"): string[] {
  const roots: string[] = [];
  for (;;) {
    const index = args.indexOf(flag);
    if (index < 0) break;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new CliUsageError(`${flag} requires an absolute path`, REMOTE_WORKSPACE_USAGE);
    roots.push(value);
    args.splice(index, 2);
  }
  return roots;
}

function publicStatus(state: RemoteWorkspaceDeviceState | null): Record<string, unknown> {
  if (!state) return { paired: false };
  const capabilities = remoteWorkspaceCapabilitiesForCommandRunner(
    createPlatformRemoteWorkspaceCommandRunner({
      linux: {
        toolchainRoots: state.toolchainRoots,
        writableRoots: state.roots.map(root => root.path),
      },
      ...(state.nativeHelper ? { native: {
        helper: state.nativeHelper,
        toolchainRoots: state.toolchainRoots,
        writableRoots: state.roots.map(root => root.path),
      } } : {}),
    }),
    state.capabilities,
  );
  return {
    paired: true,
    hubUrl: state.hubUrl,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
    devicePlatform: state.devicePlatform,
    capabilities,
    roots: state.roots.map(root => ({ id: root.id, label: root.label, path: root.path })),
    toolchainRoots: state.toolchainRoots,
  };
}

export async function runRemoteWorkspaceCommand(rawArgs: string[], deps: RemoteWorkspaceCliDeps = {}): Promise<number> {
  const args = [...rawArgs];
  const command = args.shift();
  const store = deps.store ?? new RemoteWorkspaceDeviceFileStore();
  if (command === "status") {
    const wantsJson = takeJsonFlag(args);
    rejectArgs(args, REMOTE_WORKSPACE_USAGE);
    const status = publicStatus(store.load());
    if (wantsJson) console.log(JSON.stringify(status, null, 2));
    else if (!status.paired) console.log("Remote Workspace executor is not paired.");
    else {
      console.log(`Remote Workspace executor: ${status.deviceName}`);
      console.log(`Hub: ${status.hubUrl}`);
      console.log(`Capabilities: ${(status.capabilities as string[]).join(", ")}`);
      console.log(`Workspace roots: ${(status.roots as unknown[]).length}`);
    }
    return 0;
  }
  if (command === "pair") {
    const wantsJson = takeJsonFlag(args);
    const readCode = takeFlag(args, "--pairing-code-stdin");
    const name = takeOption(args, "--name");
    const nativeHelperPath = takeOption(args, "--executor-helper");
    const roots = takeRepeatedPathFlag(args, "--root");
    const toolchainRoots = takeRepeatedPathFlag(args, "--toolchain-root");
    const hubUrl = args.shift();
    if (!hubUrl || !readCode || roots.length === 0) throw new CliUsageError(
      "pair requires <hub-url>, --pairing-code-stdin, and at least one --root",
      REMOTE_WORKSPACE_USAGE,
    );
    rejectArgs(args, REMOTE_WORKSPACE_USAGE, { redactValues: true });
    const pairingCode = await readSecretLine(deps, "Remote Workspace pairing code");
    const state = await (deps.pair ?? pairRemoteWorkspaceDevice)({
      hubUrl,
      pairingCode,
      ...(name ? { name } : {}),
      roots: roots.map(path => ({ path })),
      toolchainRoots,
      ...(nativeHelperPath ? { nativeHelperPath } : {}),
      store,
    });
    const status = publicStatus(state);
    if (wantsJson) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`Paired ${state.deviceName} with ${state.hubUrl}.`);
      console.log("Run `ocx remote-workspace agent` to keep this executor online.");
    }
    return 0;
  }
  if (command === "agent") {
    rejectArgs(args, REMOTE_WORKSPACE_USAGE);
    const state = store.load();
    if (!state) throw new CliUsageError("Remote Workspace executor is not paired. Run the pair command first.", REMOTE_WORKSPACE_USAGE);
    const controller = deps.signal ? null : new AbortController();
    const signal = deps.signal ?? controller!.signal;
    const stop = () => controller?.abort();
    if (controller) {
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
    try {
      await (deps.runAgent ?? runRemoteWorkspaceAgent)({
        state,
        signal,
        onStatus: deps.onStatus ?? (status => {
          if (status.state === "online") console.log(`Remote Workspace executor online: ${state.deviceName}`);
          if (status.state === "reconnecting" && status.message) console.error(`Remote Workspace reconnecting: ${status.message}`);
        }),
      });
    } finally {
      if (controller) {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    }
    return 0;
  }
  throw new CliUsageError("choose pair, agent, or status", REMOTE_WORKSPACE_USAGE);
}

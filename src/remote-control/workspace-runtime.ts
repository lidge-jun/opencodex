import type { OcxConfig } from "../types";
import {
  RemoteWorkspaceHub,
  RemoteWorkspaceHubFileStore,
  type RemoteWorkspaceHubStateStore,
} from "./workspace-hub";
import { CodexRemoteWorkspaceRuntimeFactory } from "./workspace-codex-runtime";
import { ClaudeRemoteWorkspaceRuntimeFactory } from "./workspace-claude-runtime";
import { PiRemoteWorkspaceRuntimeFactory } from "./workspace-pi-runtime";
import {
  RemoteWorkspaceSessionFileStore,
  RemoteWorkspaceSessionService,
} from "./workspace-sessions";

const hubs = new WeakMap<object, RemoteWorkspaceHub>();
const sessionServices = new WeakMap<object, RemoteWorkspaceSessionService>();

export function remoteWorkspaceHubForConfig(
  config: Readonly<OcxConfig>,
  store?: RemoteWorkspaceHubStateStore,
): RemoteWorkspaceHub {
  if (config.runtimeRole !== "hub") throw new Error("remote workspace requires runtimeRole=hub");
  const existing = hubs.get(config);
  if (existing) return existing;
  const hub = new RemoteWorkspaceHub(store ?? new RemoteWorkspaceHubFileStore());
  hubs.set(config, hub);
  return hub;
}

export function remoteWorkspaceSessionsForConfig(
  config: Readonly<OcxConfig>,
): RemoteWorkspaceSessionService {
  if (config.runtimeRole !== "hub") throw new Error("remote workspace requires runtimeRole=hub");
  const existing = sessionServices.get(config);
  if (existing) return existing;
  const service = new RemoteWorkspaceSessionService(
    remoteWorkspaceHubForConfig(config),
    [
      new CodexRemoteWorkspaceRuntimeFactory(),
      new ClaudeRemoteWorkspaceRuntimeFactory(),
      new PiRemoteWorkspaceRuntimeFactory(),
    ],
    Date.now,
    new RemoteWorkspaceSessionFileStore(),
  );
  sessionServices.set(config, service);
  return service;
}

export function initializedRemoteWorkspaceHubForConfig(
  config: Readonly<OcxConfig>,
): RemoteWorkspaceHub | null {
  return hubs.get(config) ?? null;
}

export function initializedRemoteWorkspaceSessionsForConfig(
  config: Readonly<OcxConfig>,
): RemoteWorkspaceSessionService | null {
  return sessionServices.get(config) ?? null;
}

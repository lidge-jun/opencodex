import type { LiveRunConfig } from "./types";

const PROXY_ENV_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
const ALLOWED_ENV = { TZ: "UTC", NO_COLOR: "1" } as const;

export class LabSandboxError extends Error {
  override readonly name = "LabSandboxError";
  constructor(message: string, readonly code: string) { super(message); }
}

export function rejectProxyEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of PROXY_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value !== "") throw new LabSandboxError(`proxy environment variable ${name} is forbidden`, "harness_failure");
  }
}

export function labSandboxEnvironment(): Readonly<Record<string, string>> { return Object.freeze({ ...ALLOWED_ENV }); }

export interface SandboxResourceState {
  requests: number;
  inputBytes: number;
  outputBytes: number;
  outputTokens: number;
  toolCalls: number;
  artifacts: number;
  artifactBytes: number;
  childProcesses: number;
}

export function createSandboxResourceState(): SandboxResourceState {
  return { requests: 0, inputBytes: 0, outputBytes: 0, outputTokens: 0, toolCalls: 0, artifacts: 0, artifactBytes: 0, childProcesses: 0 };
}

/**
 * Counter-based ceilings enforce the resources observable in this process. The hard resident-memory
 * boundary is NOT inferred from the hosting Bun test/server process RSS; a trusted exact-route
 * executor must attest/enforce that isolated boundary before its result is evidence-eligible.
 */
export function enforceSandboxLimits(state: SandboxResourceState, limits: LiveRunConfig, delta: Partial<SandboxResourceState> = {}): void {
  const next: SandboxResourceState = {
    requests: state.requests + (delta.requests ?? 0), inputBytes: state.inputBytes + (delta.inputBytes ?? 0),
    outputBytes: state.outputBytes + (delta.outputBytes ?? 0), outputTokens: state.outputTokens + (delta.outputTokens ?? 0),
    toolCalls: state.toolCalls + (delta.toolCalls ?? 0), artifacts: state.artifacts + (delta.artifacts ?? 0),
    artifactBytes: state.artifactBytes + (delta.artifactBytes ?? 0), childProcesses: state.childProcesses + (delta.childProcesses ?? 0),
  };
  if (next.childProcesses > limits.maxChildProcesses) throw new LabSandboxError("child process limit exceeded", "child_process_limit");
  if (next.requests > limits.maxRequests) throw new LabSandboxError("request limit exceeded", "request_limit");
  if (next.inputBytes > limits.maxInputBytes) throw new LabSandboxError("input byte limit exceeded", "input_byte_limit");
  if (next.outputBytes > limits.maxOutputBytes) throw new LabSandboxError("output byte limit exceeded", "output_byte_limit");
  if (next.outputTokens > limits.maxOutputTokens) throw new LabSandboxError("output token limit exceeded", "output_token_limit");
  if (next.toolCalls > limits.maxToolCalls) throw new LabSandboxError("tool call limit exceeded", "tool_call_limit");
  if (next.artifacts > limits.maxArtifacts) throw new LabSandboxError("artifact limit exceeded", "artifact_byte_limit");
  if (next.artifactBytes > limits.aggregateArtifactBytes) throw new LabSandboxError("aggregate artifact limit exceeded", "artifact_byte_limit");
  Object.assign(state, next);
}

export function prepareLiveSandbox(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  rejectProxyEnvironment(env);
  return labSandboxEnvironment();
}

import { resolveCodexHomeDir } from "../codex/home";
import { resolveCodexRuntime } from "../codex/runtime";
import { codexExecInvocation } from "../codex/exec-invocation";
import type { NativeMessageRuntime } from "../messaging/native";

/** Resolve the effective existing Codex home using the shared policy, without creating it. */
export function messageCodexHome(env: NodeJS.ProcessEnv): string {
  return resolveCodexHomeDir({ env });
}

/** Existing selection, but no persistence, synchronous version probe, install or repair. */
export function messageCodexRuntime(env: NodeJS.ProcessEnv): NativeMessageRuntime {
  const { runtime } = resolveCodexRuntime({ env, probeVersion: false, discoverAlternatives: false });
  return { path: env.PATH, argv(args) {
    const invocation = codexExecInvocation(runtime.command, args);
    return [invocation.file, ...invocation.args];
  } };
}

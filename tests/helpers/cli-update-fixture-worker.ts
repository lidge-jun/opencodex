/**
 * Test fixture only. No provider, installer, or production worker entry runs.
 * Configure before the host's RunMsg via postMessage; Worker FIFO preserves this order.
 * Every blocking fixture must be released through its SAB in the test's finally block.
 */
export const FIXTURE_ENTERED = 0;
export const FIXTURE_RELEASE = 1;
export const FIXTURE_RUNS = 2;
export const FIXTURE_REPLIES = 3;
export const FIXTURE_FINISHED = 4;
export const FIXTURE_COMMIT_RESULT = 5;
export const FIXTURE_CONTROL_WORDS = 6;

export interface FixtureConfiguration {
  type: "fixture-config";
  control: SharedArrayBuffer;
  block?: "before-reply" | "after-reply";
  reply?: "refused" | "ambiguous" | "none" | "malformed" | "error" | "throw" | "die";
  correlation?: "matching" | "stale-first" | "stale-only" | "duplicate";
  staleField?: "requestId" | "jobId" | "both";
  /** Uses only the frozen 0/1/2 CAS protocol, not an invented production export. */
  commitFenceBeforeReply?: boolean;
  /** Real Bun child waits for a test-owned release file, not a simulated SAB child. */
  childDrain?: { releasePath: string };
}
interface RunMessage {
  type: "run";
  requestId: string;
  jobId: string;
  operation: "plan" | "apply";
  planId?: string;
  channel?: unknown;
  snapshot: unknown;
  fence: SharedArrayBuffer;
  gate: SharedArrayBuffer;
  env?: { CODEX_HOME?: string; OPENCODEX_HOME?: string };
}
type ControlMessage = FixtureConfiguration | { type: "fixture-close" };
type WorkerScope = {
  onmessage: ((event: MessageEvent<RunMessage | ControlMessage>) => void) | null;
  postMessage(value: unknown): void;
};
const scope = globalThis as unknown as WorkerScope;

if (typeof Bun !== "undefined" && Bun.isMainThread === false
    && typeof self !== "undefined" && typeof scope.postMessage === "function") {
  let configuration: FixtureConfiguration | undefined;
  let running = false;
  const send = (view: Int32Array, value: unknown) => {
    Atomics.add(view, FIXTURE_REPLIES, 1);
    scope.postMessage(value);
  };
  const barrier = (view: Int32Array) => {
    Atomics.store(view, FIXTURE_ENTERED, 1);
    Atomics.notify(view, FIXTURE_ENTERED);
    while (Atomics.load(view, FIXTURE_RELEASE) === 0) {
      Atomics.wait(view, FIXTURE_RELEASE, 0);
    }
  };
  scope.onmessage = async event => {
    const message = event.data;
    if (message.type === "fixture-config") {
      if (configuration || running) throw new Error("fixture configured twice");
      configuration = message;
      return;
    }
    if (message.type === "fixture-close") {
      scope.onmessage = null;
      return;
    }
    if (message.type !== "run") return;
    if (!configuration) throw new Error("fixture must be configured before run");
    const config = configuration, view = new Int32Array(config.control);
    Atomics.add(view, FIXTURE_RUNS, 1);
    if (running) return; // Match production run-once: never execute a late second run.
    running = true;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      if (config.childDrain) {
        child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e",
          'const {existsSync}=await import("node:fs");console.log("ready");const timer=setInterval(()=>{if(existsSync(process.argv[1]))clearInterval(timer)},5);',
          config.childDrain.releasePath], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
        const ready = await reader.read(); reader.releaseLock();
        if (new TextDecoder().decode(ready.value).trim() !== "ready") throw new Error("fixture child not ready");
        scope.postMessage({ type: "fixture-child-started", pid: child.pid });
      }
      if (config.block === "before-reply") barrier(view);
      if (config.commitFenceBeforeReply) {
        // Commit cannot overwrite a parent cancellation that has already won.
        const observed = Atomics.compareExchange(new Int32Array(message.fence), 0, 0, 2);
        Atomics.store(view, FIXTURE_COMMIT_RESULT, observed);
      }
      if (config.reply === "throw") throw new Error("fixture-worker-error");
      if (config.reply === "die") return;
      if (config.reply === "none") return;
      const envelope = {
        requestId: message.requestId, jobId: message.jobId, operation: message.operation,
      };
      if (config.reply === "error") {
        send(view, { type: "error", ...envelope, message: "fixture-error" });
        return;
      }
      if (config.reply === "malformed") {
        send(view, { type: "done", ...envelope, result: { outcome: "invented" } });
        return;
      }
      // A plan test must supply a confirmed frozen plan payload after API handoff.
      if (message.operation !== "apply") throw new Error("fixture plan payload not configured");
      const ambiguous = config.reply === "ambiguous";
      const result = {
        outcome: ambiguous ? "ambiguous" : "refused",
        reason: ambiguous ? "installer_state_unknown" : "preparation_failed",
        planId: message.planId!,
        installedVersion: null, targetVersion: null, installerExitCode: null,
        leaseRetained: ambiguous, verificationPid: ambiguous ? 424242 : null,
        cleanupErrors: [],
      };
      if (config.correlation === "stale-first" || config.correlation === "stale-only") {
        send(view, { type: "done", ...envelope,
          requestId: config.staleField === "jobId" ? message.requestId : "stale-" + message.requestId,
          jobId: config.staleField === "requestId" ? message.jobId : "stale-" + message.jobId,
          result: { ...result, outcome: "applied", reason: "verified_target" } });
      }
      if (config.correlation === "stale-only") return;
      send(view, { type: "done", ...envelope, result });
      if (config.correlation === "duplicate") {
        // Conflicting late duplicate must not replace the first correlated result.
        send(view, { type: "done", ...envelope,
          result: { ...result, outcome: "applied", reason: "verified_target" } });
        send(view, { type: "error", ...envelope, message: "late-duplicate-error" });
      }
      if (config.block === "after-reply") barrier(view);
    } finally {
      Atomics.store(view, FIXTURE_FINISHED, 1);
      Atomics.notify(view, FIXTURE_FINISHED);
      // "none"/"die" deliberately close without replying; after-reply blocks until released.
      scope.onmessage = null;
      if (child) {
        const exitCode = await child.exited;
        scope.postMessage({ type: "fixture-child-exited", pid: child.pid, exitCode });
      }
    }
  };
}


/** Explicit data credentials never use management headers or the enrolled secret. */
import { readClientConnectionState, assertClientConnectionUnchanged } from "../client/state";
import { normalizeHubOrigin } from "../client/hub-client";
import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { CliUsageError, readSecretBytes, type RuntimeApiDeps } from "./runtime-api";

export interface SelectedDataTarget {
  origin: string;
  assertCurrent(): Promise<void>;
}
export interface DataClientDeps extends RuntimeApiDeps {
  signal?: AbortSignal;
  readClientConnectionState?: typeof readClientConnectionState;
  assertClientConnectionUnchanged?: typeof assertClientConnectionUnchanged;
}

async function selectTarget(deps: DataClientDeps, signal: AbortSignal): Promise<SelectedDataTarget> {
  signal.throwIfAborted();
  const readState = deps.readClientConnectionState ?? readClientConnectionState;
  const state = readState();
  if (state.kind === "connected") {
    const expected = structuredClone(state.value);
    const origin = normalizeHubOrigin(expected.serverUrl);
    const check = deps.assertClientConnectionUnchanged ?? assertClientConnectionUnchanged;
    const assertCurrent = async () => { signal.throwIfAborted(); check(expected); };
    await assertCurrent();
    return { origin, assertCurrent };
  }
  if (state.kind !== "disconnected") throw new Error("Selected target is unavailable.");
  const discover = deps.findLiveProxy ?? findLiveProxy;
  const live = await discover();
  signal.throwIfAborted();
  if (!live || live.role === "client") throw new Error("Selected target is unavailable.");
  const originOf = (value: LiveProxy) => normalizeHubOrigin(`http://${probeHostname(value.hostname)}:${value.port}`);
  const origin = originOf(live);
  const assertCurrent = async () => {
    signal.throwIfAborted();
    if (readState().kind !== "disconnected") throw new Error("Selected target changed.");
    const current = await discover();
    signal.throwIfAborted();
    if (!current || current.pid !== live.pid || current.port !== live.port || current.role !== live.role
      || originOf(current) !== origin || readState().kind !== "disconnected") {
      throw new Error("Selected target changed.");
    }
  };
  await assertCurrent();
  return { origin, assertCurrent };
}

export async function withSelectedDataKey<T>(
  deps: DataClientDeps,
  signal: AbortSignal,
  operation: (context: { target: SelectedDataTarget; key: string }) => Promise<T>,
): Promise<T> {
  let bytes: Uint8Array | undefined;
  const input = deps.stdinImpl ?? process.stdin;
  try {
    const target = await selectTarget(deps, signal);
    if (input.isTTY) throw new CliUsageError("Pipe the selected API key through stdin.");
    const timeout = deps.stdinTimeoutMs ?? 30_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30_000) throw new Error("Invalid input deadline.");
    try {
      bytes = await readSecretBytes({ ...deps, stdinTimeoutMs: timeout, stdinSignal: signal }, "API key", 4096);
    } catch (error) {
      if (error instanceof CliUsageError && error.message.startsWith("timed out")) {
        throw new Error("API key input timed out.");
      }
      throw error;
    }
    let key: string;
    try { key = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new CliUsageError("API key input must be valid UTF-8."); }
    key = key.replace(/\r?\n$/, "");
    if (!key || key.trim() !== key || !/^[\x20-\x7e]+$/.test(key)) {
      throw new CliUsageError("API key must contain printable ASCII without outer whitespace or extra lines.");
    }
    await target.assertCurrent();
    signal.throwIfAborted();
    return await operation({ target, key });
  } finally {
    bytes?.fill(0);
    input.pause();
  }
}

export async function readBoundedDataJson(
  response: Response,
  options: { maxBytes: number; signal: AbortSignal },
): Promise<unknown> {
  const result = await readBoundedResponseBytes(response, options);
  try {
    if (result.oversized) throw new Error("Response exceeded its limit.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes));
  } finally { result.bytes.fill(0); }
}

export function redactSelectedKey(text: string, key: string): string {
  return key ? text.split(key).join("[redacted]") : text;
}

/** One command owns signals; consumers check abortion before every output/effect. */
export async function withDataCommandSignals(
  deps: DataClientDeps,
  run: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  let exit = 130;
  const interrupt = () => { if (!controller.signal.aborted) { exit = 130; controller.abort(); } };
  const terminate = () => { if (!controller.signal.aborted) { exit = 143; controller.abort(); } };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  deps.signal?.addEventListener("abort", interrupt, { once: true });
  if (deps.signal?.aborted) interrupt();
  try {
    controller.signal.throwIfAborted();
    const result = await run(controller.signal);
    return controller.signal.aborted ? exit : result;
  } catch (error) {
    if (controller.signal.aborted) return exit;
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    deps.signal?.removeEventListener("abort", interrupt);
  }
}

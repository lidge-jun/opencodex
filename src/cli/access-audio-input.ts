/** Bounded local audio input; never reads stdin, devices, or a caller's whole file unchecked. */
import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { CliUsageError, readSecretBytes } from "./runtime-api";

export const AUDIO_FILE_MAX_BYTES = 25_000_000;
export const AUDIO_BODY_MAX_BYTES = 32 * 1024 * 1024;
const FILE_TIMEOUT_MS = 30_000;

export interface AudioInputDeps {
  audioFileTimeoutMs?: number;
  audioOpen?: typeof open;
  audioStat?: typeof stat;
}

export function audioTimeout(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new CliUsageError("Invalid audio deadline");
  return value;
}

async function withinInputDeadline<T>(operation: Promise<T>, signal: AbortSignal, late?: (value: T) => Promise<void>): Promise<T> {
  let stopped = signal.aborted;
  let abort = () => {};
  const cancellation = new Promise<never>((_, reject) => {
    abort = () => { stopped = true; reject(new Error("Audio input canceled")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation.then(async value => {
      if (stopped) {
        await late?.(value);
        throw new Error("Audio input canceled");
      }
      return value;
    }), cancellation]);
  } finally { signal.removeEventListener("abort", abort); }
}

export async function readAudioFile(path: string, signal: AbortSignal, deps: AudioInputDeps = {}): Promise<File> {
  const timeoutMs = audioTimeout(deps.audioFileTimeoutMs, FILE_TIMEOUT_MS);
  signal.throwIfAborted();
  const deadline = new AbortController();
  const abort = () => deadline.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let handle: FileHandle | undefined;
  let stream: ReturnType<FileHandle["createReadStream"]> | undefined;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  const validate = (value: Awaited<ReturnType<FileHandle["stat"]>>) => {
    if (!value.isFile() || value.size === 0 || value.size > AUDIO_FILE_MAX_BYTES) {
      throw new CliUsageError("Audio input must be a nonempty regular file no larger than 25,000,000 bytes");
    }
  };
  try {
    validate(await withinInputDeadline((deps.audioStat ?? stat)(path), deadline.signal));
    handle = await withinInputDeadline(
      (deps.audioOpen ?? open)(path, constants.O_RDONLY | constants.O_NONBLOCK), deadline.signal, file => file.close(),
    );
    validate(await withinInputDeadline(handle.stat(), deadline.signal));
    deadline.signal.throwIfAborted();
    stream = handle.createReadStream({ autoClose: false });
    // Teardown can emit a pending I/O error after the bounded reader detaches.
    const ignoreTeardownError = () => {};
    stream.on("error", ignoreTeardownError);
    stream.once("close", () => stream?.removeListener("error", ignoreTeardownError));
    bytes = await readSecretBytes({ stdinImpl: stream, stdinTimeoutMs: timeoutMs, stdinSignal: deadline.signal }, "Audio file", AUDIO_FILE_MAX_BYTES);
    deadline.signal.throwIfAborted();
    // Never disclose the user's basename in the multipart body; retain only a bounded format suffix.
    const suffix = /\.[a-z0-9]{1,8}$/i.exec(path)?.[0] ?? ".webm";
    return new File([bytes], `audio${suffix}`, { type: "application/octet-stream" });
  } catch (error) {
    if (deadline.signal.aborted) throw new Error("Audio input deadline or cancellation");
    if (error instanceof CliUsageError) throw new CliUsageError("Audio input must be a nonempty regular file no larger than 25,000,000 bytes");
    throw new Error("Unable to read audio input");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    stream?.destroy();
    bytes?.fill(0);
    await handle?.close();
  }
}

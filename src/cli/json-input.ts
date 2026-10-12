/** Bounded JSON ingress for management commands; domain validation stays with the caller. */
import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../server/management/body";
import { CliUsageError, readSecretBytes, type CliStdin, type RuntimeApiDeps } from "./runtime-api";

const INPUT_TIMEOUT_MS = 30_000;
const INPUT_LABEL = "JSON input";
const TOO_LARGE = "JSON input exceeds the 4 MiB management body limit";
const TIMED_OUT = "Timed out reading JSON input";

// Only errors created here may cross the boundary. Files, streams and parsers can
// throw arbitrary objects, including CliUsageError instances containing secrets.
class JsonInputFailure extends CliUsageError {}

function inputTimeout(deps: RuntimeApiDeps): number {
  const value = deps.stdinTimeoutMs ?? INPUT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0 || value > INPUT_TIMEOUT_MS) {
    throw new JsonInputFailure("JSON input deadline must be within 30 seconds");
  }
  return value;
}

async function boundedStdin(input: CliStdin, timeoutMs: number): Promise<Uint8Array> {
  if (input.isTTY) throw new JsonInputFailure("JSON input requires a file or piped stdin");
  if ("readableEncoding" in input && input.readableEncoding != null) {
    throw new JsonInputFailure("JSON input requires byte-oriented stdin");
  }
  try {
    return await readSecretBytes({ stdinImpl: input, stdinTimeoutMs: timeoutMs }, INPUT_LABEL, MANAGEMENT_JSON_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof CliUsageError) {
      if (error.message === `${INPUT_LABEL} exceeds ${MANAGEMENT_JSON_BODY_MAX_BYTES} bytes`) throw new JsonInputFailure(TOO_LARGE);
      if (error.message === `timed out waiting for ${INPUT_LABEL} on stdin`) throw new JsonInputFailure(TIMED_OUT);
      if (error.message === `${INPUT_LABEL} input was empty`) throw new JsonInputFailure("JSON input was empty");
    }
    throw new JsonInputFailure("Unable to read JSON input");
  } finally {
    // readSecretBytes owns its listeners/timer; it does not stop a still-flowing
    // stream after size, error or timeout refusal. We never close caller stdin.
    input.pause();
  }
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number, late?: (value: T) => Promise<void>): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new JsonInputFailure(TIMED_OUT)); }, Math.max(0, deadline - performance.now()));
  });
  try {
    return await Promise.race([operation.then(async value => {
      // An open can finish after the deadline: its descriptor is still ours.
      if (expired) {
        await late?.(value);
        throw new JsonInputFailure(TIMED_OUT);
      }
      return value;
    }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function fileBytes(path: string, timeoutMs: number): Promise<Uint8Array> {
  const deadline = performance.now() + timeoutMs;
  let handle: FileHandle | undefined;
  let stream: ReturnType<FileHandle["createReadStream"]> | undefined;
  let bytes: Uint8Array | undefined;
  try {
    // Preflight avoids opening known devices/FIFOs. O_NONBLOCK plus fstat also
    // refuses a FIFO substituted between the path check and the actual open.
    const pathStat = await beforeDeadline(stat(path), deadline);
    if (!pathStat.isFile()) throw new JsonInputFailure("JSON input must be a regular file");
    if (pathStat.size > MANAGEMENT_JSON_BODY_MAX_BYTES) throw new JsonInputFailure(TOO_LARGE);
    handle = await beforeDeadline(open(path, constants.O_RDONLY | constants.O_NONBLOCK), deadline, file => file.close());
    const openedStat = await beforeDeadline(handle.stat(), deadline);
    if (!openedStat.isFile()) throw new JsonInputFailure("JSON input must be a regular file");
    if (openedStat.size > MANAGEMENT_JSON_BODY_MAX_BYTES) throw new JsonInputFailure(TOO_LARGE);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new JsonInputFailure(TIMED_OUT);
    stream = handle.createReadStream({ autoClose: false });
    // The stream can report a pending I/O error while teardown destroys it.
    // readSecretBytes removes only its own error listener; retain this one
    // through close to avoid an unhandled error after timeout/limit refusal.
    const ignoreTeardownError = () => {};
    stream.on("error", ignoreTeardownError);
    stream.once("close", () => stream?.removeListener("error", ignoreTeardownError));
    bytes = await boundedStdin(stream, remaining);
    return bytes;
  } finally {
    stream?.destroy();
    try { await handle?.close(); }
    catch {
      bytes?.fill(0);
      throw new JsonInputFailure("Unable to close JSON input file");
    }
  }
}

/** Explicit '-' is the only stdin selector. The label is never treated as safe output. */
export async function readJsonInput(pathOrDash: string, deps: RuntimeApiDeps = {}, _label = INPUT_LABEL): Promise<unknown> {
  let bytes: Uint8Array | undefined;
  try {
    if (!pathOrDash) throw new JsonInputFailure("JSON input requires an explicit file or '-'");
    const timeoutMs = inputTimeout(deps);
    bytes = pathOrDash === "-"
      ? await boundedStdin(deps.stdinImpl ?? process.stdin, timeoutMs)
      : await fileBytes(pathOrDash, timeoutMs);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new JsonInputFailure("JSON input must be valid UTF-8"); }
    if (!text.trim()) throw new JsonInputFailure("JSON input was empty");
    try { return JSON.parse(text) as unknown; }
    catch { throw new JsonInputFailure("JSON input must contain valid JSON"); }
  } catch (error) {
    if (error instanceof JsonInputFailure) throw error;
    throw new JsonInputFailure("Unable to read JSON input");
  } finally {
    // Decoded strings and parsed values are immutable/consumer-owned; only
    // mutable byte buffers can be erased, without promising string erasure.
    bytes?.fill(0);
  }
}

/** Serialize once, bounding the complete UTF-8 wire body, including envelope keys. */
export function serializeManagementJson(value: unknown): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new JsonInputFailure("Management body must be JSON serializable"); }
  if (serialized === undefined) throw new JsonInputFailure("Management body must be JSON serializable");
  if (Buffer.byteLength(serialized, "utf8") > MANAGEMENT_JSON_BODY_MAX_BYTES) throw new JsonInputFailure(TOO_LARGE);
  return serialized;
}

/** Explicit-key audio consumers. No management headers, model controls, or credential fallback. */
import { signalWithTimeout } from "../lib/abort";
import { CliUsageError, printData, takeFlag, takeOptionWithSyntax } from "./runtime-api";
import {
  readBoundedDataJson, redactSelectedKey, withDataCommandSignals, withSelectedDataKey,
  type DataClientDeps, type SelectedDataTarget,
} from "./access-data-client";
import { AUDIO_BODY_MAX_BYTES, readAudioFile, audioTimeout, type AudioInputDeps } from "./access-audio-input";
import { checkAudioLive, type AudioLiveDeps, type AudioLiveReport } from "./access-audio-live";

const HTTP_TIMEOUT_MS = 130_000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_MAX_BYTES = 16 * 1024;
const TRANSCRIPTION_MODELS = new Set(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]);
const USAGE = "Usage: ocx access audio transcribe FILE --model ID --api-key-stdin [--json]\n       ocx access audio live-check --model ID --api-key-stdin [--json]";
export interface AccessAudioDeps extends DataClientDeps, AudioInputDeps, AudioLiveDeps {
  audioHttpTimeoutMs?: number;
}
interface AudioArgs { action: "transcribe" | "live-check"; model: string; json: boolean; file?: string }

function parseArgs(argv: string[]): AudioArgs {
  const args = [...argv];
  const action = args.shift();
  const json = takeFlag(args, "--json");
  const stdin = takeFlag(args, "--api-key-stdin");
  const model = takeOptionWithSyntax(args, "--model")?.value;
  if (!stdin || !model || model.trim() !== model || !model.trim() || Buffer.byteLength(model) > MODEL_MAX_BYTES
    || /[\x00-\x1f\x7f-\x9f]/.test(model)) throw new CliUsageError("Invalid audio arguments");
  if (action === "transcribe" && TRANSCRIPTION_MODELS.has(model) && args.length === 1 && args[0] && !args[0].startsWith("-")) {
    return { action, model, json, file: args[0] };
  }
  if (action === "live-check" && args.length === 0) return { action, model, json };
  throw new CliUsageError("Invalid audio arguments");
}

async function transcribe(file: File, model: string, context: { target: SelectedDataTarget; key: string }, signal: AbortSignal, deps: AccessAudioDeps): Promise<{ text: string }> {
  // Each bounded ASCII multipart header/boundary plus the fixed field names fits
  // in 4 KiB. File/model/filename are independently bounded before serialization.
  if (file.size + Buffer.byteLength(model) + Buffer.byteLength(file.name) + 4096 > AUDIO_BODY_MAX_BYTES) throw new Error("Audio multipart limit");
  const form = new FormData();
  form.set("file", file);
  form.set("model", model);
  form.set("response_format", "json");
  await context.target.assertCurrent();
  signal.throwIfAborted();
  const deadline = signalWithTimeout(audioTimeout(deps.audioHttpTimeoutMs, HTTP_TIMEOUT_MS), signal);
  let response: Response | undefined;
  try {
    response = await (deps.fetchImpl ?? fetch)(new URL("/v1/audio/transcriptions", context.target.origin), {
      method: "POST", body: form, headers: { "x-opencodex-api-key": context.key },
      credentials: "omit", redirect: "error", signal: deadline.signal,
    });
    deadline.signal.throwIfAborted();
    if (!response.ok) throw new Error("Audio request refused");
    const result = await readBoundedDataJson(response, { maxBytes: RESPONSE_MAX_BYTES, signal: deadline.signal });
    deadline.signal.throwIfAborted();
    if (!result || typeof result !== "object" || Array.isArray(result) || !("text" in result) || typeof result.text !== "string") throw new Error("Unsupported audio response");
    await context.target.assertCurrent();
    deadline.signal.throwIfAborted();
    return { text: redactSelectedKey(result.text, context.key) };
  } finally {
    // Cancellation itself may never settle; it must not retain the key or deadline.
    try {
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    } catch { /* best-effort body teardown must preserve the original outcome */ }
    finally { deadline.cleanup(); }
  }
}

function showLive(report: AudioLiveReport, json: boolean): void {
  printData(report, json, [
    report.ready ? "Session readiness observed." : "Session readiness was not observed.",
    report.close === "confirmed" ? "Normal socket closure confirmed." : "Socket closure is unverified.",
    "This checks session readiness only; it does not test a voice roundtrip.",
  ]);
}

export async function handleAccessAudioCommand(argv: string[], deps: AccessAudioDeps = {}): Promise<number> {
  let options: AudioArgs;
  try {
    options = parseArgs(argv);
    audioTimeout(deps.audioFileTimeoutMs, 30_000);
    audioTimeout(deps.audioHttpTimeoutMs, HTTP_TIMEOUT_MS);
    audioTimeout(deps.audioReadyTimeoutMs, 15_000);
    audioTimeout(deps.audioCloseTimeoutMs, 2_000);
  } catch {
    console.error("Invalid audio arguments. Use a supported model and pipe the selected key on stdin.");
    console.error(USAGE);
    return 2;
  }
  return await withDataCommandSignals(deps, async signal => {
    let liveReport: AudioLiveReport = { schemaVersion: 1, ready: false, close: "unverified", check: "session-readiness" };
    try {
      const file = options.action === "transcribe" ? await readAudioFile(options.file!, signal, deps) : undefined;
      return await withSelectedDataKey(deps, signal, async context => {
        if (file) {
          const result = await transcribe(file, options.model, context, signal, deps);
          signal.throwIfAborted();
          printData(result, options.json, [result.text]);
          return 0;
        }
        await context.target.assertCurrent();
        signal.throwIfAborted();
        const result = await checkAudioLive(context.target.origin, options.model, context.key, signal, deps);
        liveReport = result.report;
        await context.target.assertCurrent();
        signal.throwIfAborted();
        showLive(liveReport, options.json);
        if (!result.ok) console.error("Audio readiness or normal closure could not be confirmed. Check the selected target and audio model before retrying.");
        return result.ok ? 0 : 1;
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof CliUsageError) {
        console.error("Invalid audio file or key input. Use a nonempty regular audio file and pipe a printable ASCII key without extra lines.");
        return 2;
      }
      if (options.action === "live-check") showLive(liveReport, options.json);
      console.error("Audio operation failed. Check the selected target, key, model, file limits and connection before retrying.");
      return 1;
    }
  });
}

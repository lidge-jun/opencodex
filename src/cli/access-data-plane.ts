import { signalWithTimeout } from "../lib/abort";
import { CliUsageError, printData, takeFlag, takeOptionWithSyntax } from "./runtime-api";
import { withSelectedDataKey, withDataCommandSignals, readBoundedDataJson, type DataClientDeps, type SelectedDataTarget } from "./access-data-client";
import { projectModelResponse, type DataProtocol, type SafeModelResponse } from "./access-data-response";

export interface SelectedKeyTestDeps extends DataClientDeps {
  controlTimeoutMs?: number;
  requestTimeoutMs?: number;
}
interface ProbeReport {
  schemaVersion: 1;
  control: { outcome: "not_run" | "credential_required" | "unavailable"; status?: number };
  request: { outcome: "not_run" | "succeeded" | "failed" | "unsupported_response"; status?: number };
  response?: SafeModelResponse;
}
const USAGE = "Usage: ocx access test <model> [--protocol chat|responses|messages] --api-key-stdin [--json]";
function parse(argv: string[]) {
  const args = [...argv];
  try {
    const json = takeFlag(args, "--json");
    const stdin = takeFlag(args, "--api-key-stdin");
    const protocol = takeOptionWithSyntax(args, "--protocol")?.value ?? "chat";
    const model = args.shift();
    if (!stdin || args.length || !model || model.startsWith("-") || model.trim() !== model
      || model.length > 16_384 || /[\x00-\x1f\x7f]/.test(model)
      || (protocol !== "chat" && protocol !== "responses" && protocol !== "messages")) throw new Error();
    return { json, model, protocol } as { json: boolean; model: string; protocol: DataProtocol };
  } catch { throw new CliUsageError("Invalid selected-key test arguments.", USAGE); }
}
function nativeRefusal(raw: unknown, protocol: DataProtocol): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const top = raw as Record<string, unknown>;
  if (!top.error || typeof top.error !== "object" || Array.isArray(top.error)) return false;
  const error = top.error as Record<string, unknown>;
  if (error.message !== "opencodex API key required" || error.type !== "authentication_error") return false;
  return (top.type === undefined && error.code === "invalid_api_key")
    || (protocol === "messages" && top.type === "error" && error.code === undefined);
}
function timeout(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isFinite(value) || value <= 0 || value > ceiling) throw new Error("Invalid request deadline.");
  return value;
}
async function requestJson(
  target: SelectedDataTarget, path: string, body: string, key: string | undefined,
  deps: SelectedKeyTestDeps, signal: AbortSignal, report: { status?: number },
): Promise<unknown> {
  await target.assertCurrent();
  signal.throwIfAborted();
  const deadline = signalWithTimeout(timeout(key === undefined ? deps.controlTimeoutMs : deps.requestTimeoutMs, key === undefined ? 5000 : 60_000), signal);
  try {
    const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
    if (key !== undefined) headers.set("x-opencodex-api-key", key);
    const response = await (deps.fetchImpl ?? fetch)(`${target.origin}${path}`, {
      method: "POST", body, headers, credentials: "omit", redirect: "error", signal: deadline.signal,
    });
    report.status = response.status;
    const result = await readBoundedDataJson(response, { maxBytes: key === undefined ? 4096 : 2 * 1024 * 1024, signal: deadline.signal });
    deadline.signal.throwIfAborted();
    await target.assertCurrent();
    signal.throwIfAborted();
    return result;
  } finally { deadline.cleanup(); }
}
export async function handleSelectedKeyTest(argv: string[], deps: SelectedKeyTestDeps = {}): Promise<number> {
  let options: ReturnType<typeof parse>;
  try { options = parse(argv); }
  catch { console.error(`Error: Invalid selected-key test arguments.\n${USAGE}`); return 2; }
  const report: ProbeReport = { schemaVersion: 1, control: { outcome: "not_run" }, request: { outcome: "not_run" } };
  return withDataCommandSignals(deps, async signal => {
    try {
      await withSelectedDataKey(deps, signal, async ({ target, key }) => {
        const path = options.protocol === "responses" ? "/v1/responses" : options.protocol === "chat" ? "/v1/chat/completions" : "/v1/messages";
        report.control.outcome = "unavailable";
        const control = await requestJson(target, path, "{", undefined, deps, signal, report.control);
        if (report.control.status !== 401 || !nativeRefusal(control, options.protocol)) throw new Error();
        report.control.outcome = "credential_required";
        const body = options.protocol === "responses"
          ? { model: options.model, input: "Reply with OK.", max_output_tokens: 16 }
          : { model: options.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16,
            ...(options.protocol === "chat" ? { stream: false } : {}) };
        report.request.outcome = "failed";
        const raw = await requestJson(target, path, JSON.stringify(body), key, deps, signal, report.request);
        if (!report.request.status || report.request.status < 200 || report.request.status >= 300) throw new Error();
        report.request.outcome = "unsupported_response";
        report.response = projectModelResponse(raw, options.protocol, key);
        report.request.outcome = "succeeded";
      });
      signal.throwIfAborted();
      printData(report, options.json, [
        "Credentialless request was refused; the model request using the supplied key succeeded.",
        ...(report.response?.completion === "limited" ? ["Completion was limited by the model response."] : []),
        ...report.response!.text,
      ]);
      return 0;
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof CliUsageError) { console.error("Error: Invalid API key input. Pipe one printable ASCII key through stdin."); return 2; }
      if (options.json) printData(report, true);
      console.error("Error: Selected-key test did not complete. Check the target, key and supported protocol before retrying.");
      return 1;
    }
  });
}

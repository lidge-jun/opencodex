import { isValidProviderName } from "../config/provider-name";
import { requestPacingConfigError } from "../config/schema/leaf-validators";
import { readJsonInput, serializeManagementJson } from "./json-input";
import { printProviderReceipt, runProviderAction } from "./provider-result";
import {
  CliUsageError, RuntimeApiError, printData, runtimeBaseUrl, runtimeRequest,
  takeFlag, takeOptionWithSyntax, type RuntimeApiDeps,
} from "./runtime-api";

const PACING_USAGE = "Usage: ocx provider pacing <name> [--file <FILE|-> | --enabled <on|off> --rpm <number> --min-interval-ms <integer> --max-concurrent <integer>] [--json]";

function onOff(value: string, flag: string): boolean {
  if (value !== "on" && value !== "off") throw new CliUsageError(`${flag} must be on or off`);
  return value === "on";
}

function positiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    throw new CliUsageError(`${flag} must be a positive safe integer`);
  }
  return number;
}

/** Consume only the additional edit options; the existing edit parser owns all others. */
export function takeProviderEditSettings(args: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const version = takeOptionWithSyntax(args, "--upstream-http-version")?.value;
  const fast = takeOptionWithSyntax(args, "--fast")?.value;
  const context = takeOptionWithSyntax(args, "--context-window")?.value;
  if (version !== undefined) {
    if (version !== "http1.1" && version !== "-") {
      throw new CliUsageError("--upstream-http-version must be http1.1 or -");
    }
    patch.upstreamHttpVersion = version === "-" ? null : version;
  }
  if (fast !== undefined) patch.fastEnabled = onOff(fast, "--fast");
  if (context !== undefined) patch.contextWindow = context === "-" ? null : positiveInteger(context, "--context-window");
  return patch;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRules(value: unknown): value is Record<string, unknown> {
  return record(value) && requestPacingConfigError(value) === null;
}

function takePacingScalars(args: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const enabled = takeOptionWithSyntax(args, "--enabled")?.value;
  const rpm = takeOptionWithSyntax(args, "--rpm")?.value;
  const interval = takeOptionWithSyntax(args, "--min-interval-ms")?.value;
  const concurrent = takeOptionWithSyntax(args, "--max-concurrent")?.value;
  if (enabled !== undefined) patch.enabled = onOff(enabled, "--enabled");
  if (rpm !== undefined) {
    const number = Number(rpm);
    if (!rpm.trim() || !Number.isFinite(number)) throw new CliUsageError("--rpm must be a finite number");
    patch.requestsPerMinute = number;
  }
  if (interval !== undefined) patch.minIntervalMs = positiveInteger(interval, "--min-interval-ms");
  if (concurrent !== undefined) patch.maxConcurrentRequests = positiveInteger(concurrent, "--max-concurrent");
  // Validate numeric bounds before target resolution; enabling alone may use stored rules.
  if (!validRules({ ...patch, enabled: false })) throw new CliUsageError("Invalid pacing limits", PACING_USAGE);
  return patch;
}

async function configuredRules(name: string, deps: RuntimeApiDeps): Promise<Record<string, unknown> | null> {
  const config = await runtimeRequest("/api/config", { redirect: "error" }, deps);
  if (!record(config) || !record(config.providers)) throw new Error("Invalid provider configuration response");
  if (!Object.hasOwn(config.providers, name)) throw new RuntimeApiError("Provider not found", 404, null);
  const provider = config.providers[name];
  if (!record(provider)) throw new Error("Invalid provider configuration response");
  if (!Object.hasOwn(provider, "requestPacing")) return null;
  if (!validRules(provider.requestPacing)) throw new Error("Invalid stored pacing rules");
  return provider.requestPacing;
}

function pacingStatus(value: unknown, name: string): Record<string, unknown> {
  const keys = ["provider", "enabled", "queued", "nextSlotInMs", "inFlight", "lastStartedAt", "lastModelId"];
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key))
    || value.provider !== name || typeof value.enabled !== "boolean") {
    throw new Error("Invalid pacing status response");
  }
  for (const key of ["queued", "nextSlotInMs", "inFlight", "lastStartedAt"]) {
    if ((key === "inFlight" || key === "lastStartedAt") && !Object.hasOwn(value, key)) continue;
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0
      || (key !== "lastStartedAt" && !Number.isSafeInteger(number))) {
      throw new Error("Invalid pacing status response");
    }
  }
  if (Object.hasOwn(value, "lastModelId") && typeof value.lastModelId !== "string") {
    throw new Error("Invalid pacing status response");
  }
  return value;
}

export async function handleProviderPacingCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runProviderAction(async () => {
    const args = [...argv];
    const name = args.shift()?.trim();
    if (!name || !isValidProviderName(name)) throw new CliUsageError("A valid provider name is required", PACING_USAGE);
    const wantsJson = takeFlag(args, "--json");
    const file = takeOptionWithSyntax(args, "--file")?.value;
    const scalars = takePacingScalars(args);
    if (args.length) throw new CliUsageError("Unexpected pacing argument(s)", PACING_USAGE);
    const editing = Object.keys(scalars).length > 0;
    if (file !== undefined && editing) throw new CliUsageError("--file cannot be combined with pacing scalar options", PACING_USAGE);
    let fileBody: string | undefined;
    if (file !== undefined) {
      const rules = await readJsonInput(file, deps, "Pacing JSON input");
      if (!validRules(rules)) throw new CliUsageError("Invalid pacing rules", PACING_USAGE);
      fileBody = serializeManagementJson({ requestPacing: rules });
    }
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    if (fileBody !== undefined || editing) {
      let body = fileBody;
      if (body === undefined) {
        const observed = await configuredRules(name, pinned);
        const rules = { ...(observed ?? { enabled: false }), ...scalars };
        if (!validRules(rules)) throw new CliUsageError("Invalid resulting pacing rules", PACING_USAGE);
        // PATCH replaces the observed block, including its model rules. This is not CAS.
        body = serializeManagementJson({ requestPacing: rules });
      }
      const result = await runtimeRequest(`/api/providers?name=${encodeURIComponent(name)}`, {
        method: "PATCH", redirect: "error", body,
      }, pinned);
      return printProviderReceipt(result, wantsJson, "Updated provider pacing");
    }
    const rules = await configuredRules(name, pinned);
    const status = pacingStatus(await runtimeRequest(`/api/provider-request-pacing?name=${encodeURIComponent(name)}`, {
      redirect: "error",
    }, pinned), name);
    printData({ provider: name, rules, status }, wantsJson, [
      `${name}: ${rules === null ? "no pacing rules configured" : rules.enabled ? "pacing rules enabled" : "pacing rules disabled"}`,
      ...(rules === null ? [] : [JSON.stringify(rules)]),
      `Runtime: ${status.enabled ? "enabled" : "disabled"}; queued: ${status.queued}; next slot: ${status.nextSlotInMs} ms`,
    ]);
    return 0;
  });
}

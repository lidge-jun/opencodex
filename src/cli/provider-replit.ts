import {
  CliUsageError,
  rejectArgs,
  runtimeRequest,
  RuntimeApiError,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";
import {
  INSTALL_REPLIT_USAGE,
  readBoundedGatewayKeyFile,
  readBoundedGatewayKeyStdin,
  REPLIT_GATEWAY_KEY_ENV,
  validateBoundedGatewayKeyValue,
} from "./replit-gateway-key-input";
import {
  REPLIT_OPENAI_PROVIDER_ID,
} from "../providers/replit/constants";
import {
  parseReplitPairInstallSuccess,
  type ReplitPairInstallSuccessResponse,
} from "../providers/replit/pair-install-response";

export { INSTALL_REPLIT_USAGE, REPLIT_GATEWAY_KEY_ENV } from "./replit-gateway-key-input";

const GATEWAY_KEY_ARG_FLAGS = ["--gateway-key", "--gateway-key="];

export interface InstallReplitCliDeps extends RuntimeApiDeps {
  env?: NodeJS.ProcessEnv;
  runtimeRequest?: typeof runtimeRequest;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

export interface ReplitPairInstallBody {
  origin: string;
  gatewayKey: string;
  allowCustomDomain: boolean;
  replace: boolean;
  setDefault: boolean;
}

export type ReplitPairInstallResult =
  | { ok: true; data: ReplitPairInstallSuccessResponse }
  | {
      ok: false;
      status: number;
      code?: string;
      error: string;
      collisions?: string[];
      probe?: unknown;
    };

function depsEnv(deps: InstallReplitCliDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

function assertNoArgvGatewayKey(args: string[]): void {
  for (const arg of args) {
    if (GATEWAY_KEY_ARG_FLAGS.some(flag => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new CliUsageError(
        "gateway key must not be passed on the command line; use "
        + `${REPLIT_GATEWAY_KEY_ENV}, --stdin, or --gateway-key-file`,
        INSTALL_REPLIT_USAGE,
      );
    }
  }
}

export async function resolveReplitGatewayKey(
  sourceArgs: string[],
  deps: InstallReplitCliDeps = {},
): Promise<string> {
  assertNoArgvGatewayKey(sourceArgs);
  const args = [...sourceArgs];
  const fromStdin = takeFlag(args, "--stdin");
  const keyFile = takeOption(args, "--gateway-key-file");
  rejectArgs(args, INSTALL_REPLIT_USAGE);

  if (fromStdin && keyFile) {
    throw new CliUsageError("choose exactly one gateway key source", INSTALL_REPLIT_USAGE);
  }
  if (fromStdin) return readBoundedGatewayKeyStdin(deps);
  if (keyFile) return readBoundedGatewayKeyFile(keyFile);
  const envKey = depsEnv(deps)[REPLIT_GATEWAY_KEY_ENV]?.trim();
  if (envKey) return validateBoundedGatewayKeyValue(envKey);
  throw new CliUsageError(
    `gateway key is required via ${REPLIT_GATEWAY_KEY_ENV}, --stdin, or --gateway-key-file`,
    INSTALL_REPLIT_USAGE,
  );
}

function formatInstallError(code: string | undefined, message: string): string {
  if (code === "provider_collision") {
    return `${message}. Re-run with --replace to overwrite the existing pair.`;
  }
  if (code === "config_busy") {
    return `${message} Retry shortly.`;
  }
  return message;
}

type ReplitPairApiFailure = {
  error: string;
  code?: string;
  collisions?: string[];
  probe?: unknown;
};

function parseFailureBody(body: unknown): ReplitPairApiFailure {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    return {
      error: typeof record.error === "string" ? record.error : "Management request failed",
      code: typeof record.code === "string" ? record.code : undefined,
      collisions: Array.isArray(record.collisions)
        ? record.collisions.filter((row): row is string => typeof row === "string")
        : undefined,
      probe: record.probe,
    };
  }
  return { error: "Management request failed" };
}

export async function postReplitPairInstall(
  body: ReplitPairInstallBody,
  deps: InstallReplitCliDeps = {},
): Promise<ReplitPairInstallResult> {
  const request = deps.runtimeRequest ?? runtimeRequest;
  try {
    const raw = await request<unknown>(
      "/api/providers/replit-pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      deps,
    );
    const data = parseReplitPairInstallSuccess(raw);
    if (data) return { ok: true, data };
    return { ok: false, status: 502, error: "unexpected management response" };
  } catch (error) {
    if (error instanceof RuntimeApiError) {
      const failure = parseFailureBody(error.body);
      return {
        ok: false,
        status: error.status,
        code: failure.code,
        error: failure.error,
        collisions: failure.collisions,
        probe: failure.probe,
      };
    }
    throw error;
  }
}

export async function runInstallReplit(argv: string[], deps: InstallReplitCliDeps = {}): Promise<number> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const allowCustomDomain = takeFlag(args, "--allow-custom-domain");
  const replace = takeFlag(args, "--replace");
  const setDefault = takeFlag(args, "--set-default");
  const origin = takeOption(args, "--origin");
  if (!origin) throw new CliUsageError("--origin is required", INSTALL_REPLIT_USAGE);

  const gatewayKey = await resolveReplitGatewayKey(args, deps);
  rejectArgs(args, INSTALL_REPLIT_USAGE);

  const result = await postReplitPairInstall({
    origin,
    gatewayKey,
    allowCustomDomain,
    replace,
    setDefault,
  }, deps);

  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));

  if (!result.ok) {
    const message = formatInstallError(result.code, result.error);
    if (wantsJson) {
      log(JSON.stringify({
        success: false,
        code: result.code,
        error: message,
        ...(result.collisions ? { collisions: result.collisions } : {}),
        ...(result.probe ? { probe: result.probe } : {}),
      }, null, 2));
    } else {
      error(`Error: ${message}`);
      if (result.code === "probe_failed" && result.probe && typeof result.probe === "object") {
        const probe = result.probe as { stage?: string };
        if (typeof probe.stage === "string") error(`Probe stage: ${probe.stage}`);
      }
    }
    return 1;
  }

  if (wantsJson) {
    log(JSON.stringify({
      success: true,
      providers: result.data.providers,
      probe: result.data.probe,
      ...(setDefault ? { defaultProvider: REPLIT_OPENAI_PROVIDER_ID } : {}),
    }, null, 2));
    return 0;
  }

  log(`Installed Replit gateway pair: ${result.data.providers.join(", ")}.`);
  log(`Probe healthz: ${result.data.probe.healthz.status} (${result.data.probe.healthz.latencyMs} ms)`);
  log(`Probe models: ${result.data.probe.models.modelCount} model(s) (${result.data.probe.models.latencyMs} ms)`);
  if (setDefault) log(`Set default provider to ${REPLIT_OPENAI_PROVIDER_ID}.`);
  return 0;
}

export async function handleInstallReplit(args: string[]): Promise<void> {
  try {
    const code = await runInstallReplit(args);
    process.exit(code);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      if (error.usage) console.error(error.usage);
      process.exit(1);
    }
    throw error;
  }
}

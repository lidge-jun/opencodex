import {
  CliUsageError,
  printData,
  readSecretLine,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx remote [status] [--json]
  ocx remote link [--json]
  printf '%s\\n' '<password>' | ocx remote password [--json]
  ocx remote activate --name <computer-name> --slug <hostname> [--json]
  ocx remote pairing-code [--json]
  ocx remote disconnect --yes [--json]`;

async function readStatus(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest("/api/remote/status", {}, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function link(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/api/remote/link", { method: "POST" }, deps);
  printData(result, wantsJson, [
    `Device code: ${String(result.userCode ?? "-")}`,
    `Approve in browser: ${String(result.authorizeUrl ?? "-")}`,
  ]);
}

async function password(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE, { redactValues: true });
  const value = await readSecretLine(deps, "Remote password");
  if (value.length < 10 || value.length > 128) throw new CliUsageError("Remote password must be 10 to 128 characters", USAGE);
  const result = await runtimeRequest("/api/remote/password", {
    method: "PUT",
    body: JSON.stringify({ password: value }),
  }, deps);
  printData(result, wantsJson, ["Remote password updated. Existing browser sessions were revoked."]);
}

async function activate(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const name = takeOption(args, "--name");
  const slug = takeOption(args, "--slug");
  rejectArgs(args, USAGE);
  if (!name || !slug) throw new CliUsageError("activate requires --name and --slug", USAGE);
  const result = await runtimeRequest("/api/remote/activate", {
    method: "POST",
    body: JSON.stringify({ name, slug }),
  }, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function pairingCode(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/api/remote/pairing-code", { method: "POST" }, deps);
  printData(result, wantsJson, [
    `One-time pairing code: ${String(result.code ?? "-")}`,
    `Expires: ${String(result.expiresAt ?? "-")}`,
  ]);
}

async function disconnect(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const yes = takeFlag(args, "--yes");
  rejectArgs(args, USAGE);
  if (!yes) throw new CliUsageError("disconnect requires --yes", USAGE);
  const result = await runtimeRequest("/api/remote/device", { method: "DELETE" }, deps);
  printData(result, wantsJson, ["This computer was disconnected from OpenCodex Remote."]);
}

/** Headless parity for the local Remote page; every action uses the same management API. */
export async function handleRemoteCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "status", ...rest] = argv;
    if (sub === "status") await readStatus(rest, deps);
    else if (sub === "link") await link(rest, deps);
    else if (sub === "password") await password(rest, deps);
    else if (sub === "activate") await activate(rest, deps);
    else if (sub === "pairing-code" || sub === "pair") await pairingCode(rest, deps);
    else if (sub === "disconnect") await disconnect(rest, deps);
    else throw new CliUsageError(`unknown remote command ${sub}`, USAGE);
  });
}

export const REMOTE_USAGE = USAGE;

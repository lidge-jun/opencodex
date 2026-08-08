import { writeSync } from "node:fs";
import { warnIfCodexCatalogRefreshPending } from "./account-catalog-refresh";
import {
  CliUsageError,
  printData,
  readSecretLine,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  takeOptionWithSyntax,
  type CliStdin,
  type RuntimeApiDeps,
} from "./runtime-api";

/**
 * Write the whole block to fd 1 synchronously (#1007). `console.log` can
 * buffer behind a pipe, which hid the authorization URL for the entire
 * polling window under non-TTY stdout. A partial write loops; a zero-byte
 * write is a hard failure, never silent progress.
 */
function writeStdoutFully(text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(1, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new CliUsageError("failed to write login instructions to stdout");
    offset += written;
  }
}

const USAGE = `Usage:
  ocx account login <provider> [--id <account-id>] [--reauth] [--code -] [--no-wait] [--json]
  ocx account code <provider> [--flow <flow-id>] [--json]   (reads the code from stdin)
  ocx account cancel <provider> [--flow <flow-id>] [--json]
  ocx account reset-credits <account-id|main> [--consume --yes] [--json]

The redirect URL or authorization code is a short-lived credential. Pipe it in
rather than passing it as an argument, where it lands in shell history and is
visible to anyone who can run ps:
  pbpaste | ocx account code <provider> --flow <flow-id>
  ocx account login <provider> --code -   (same, for the login flow)`;

const CODEX_NAMES = new Set(["openai", "codex", "chatgpt"]);

interface LoginStart {
  url?: string;
  flowId?: string;
  instructions?: string;
  deviceCode?: string;
}

/** `-` means "read it from stdin", the documented way to pass a code silently. */
const STDIN_SENTINEL = "-";

const ARGV_WARNING =
  "warning: the authorization code was passed as a command-line argument, so it is now in your shell history and was visible in the process list while this ran. Pipe it on stdin instead, or pass `-` to read from stdin.";

/**
 * Resolve the code, preferring stdin.
 *
 * Never logs the value itself — the warning names the exposure, not the
 * credential. What this closes is shell history, `ps`, and this program's own
 * output; a code pasted at an interactive prompt is still visible on the
 * terminal, exactly as it is in the existing interactive login.
 */
async function resolveCode(
  supplied: { value: string; inline: boolean } | undefined,
  deps: RuntimeApiDeps,
  required: boolean,
): Promise<string | undefined> {
  if (supplied && supplied.value !== STDIN_SENTINEL) {
    console.error(ARGV_WARNING);
    return supplied.value;
  }
  if (!supplied && !required) return undefined;
  const input: CliStdin = deps.stdinImpl ?? process.stdin;
  if (input.isTTY) console.error("Paste the redirect URL or authorization code, then press Enter:");
  return await readSecretLine(deps, "authorization code");
}

async function login(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const provider = args.shift()?.trim().toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  const noWait = takeFlag(args, "--no-wait");
  const reauth = takeFlag(args, "--reauth");
  const id = takeOption(args, "--id");
  const suppliedCode = takeOptionWithSyntax(args, "--code");
  if (!provider) throw new CliUsageError("provider is required", USAGE);
  rejectArgs(args, USAGE);
  // Only resolve when --code was actually given: a plain `ocx account login`
  // opens the browser flow and polls, and must not block on stdin.
  const code = await resolveCode(suppliedCode, deps, false);

  if (CODEX_NAMES.has(provider)) {
    const start = await runtimeRequest<LoginStart>("/api/codex-auth/login", {
      method: "POST",
      body: JSON.stringify({ ...(id ? { id } : {}), ...(reauth ? { reauth: true } : {}) }),
    }, deps);
    if (!wantsJson) {
      // One atomic pre-poll block, flushed synchronously so a piped parent
      // reads the URL before the polling window starts (#1007).
      const block = [
        start.url ? `Open this URL to sign in:\n${start.url}` : "",
        start.instructions ?? "",
        start.flowId ? `Flow: ${start.flowId}` : "",
      ].filter(line => line !== "").join("\n");
      if (block) writeStdoutFully(`${block}\n`);
    }
    if (code && start.flowId) {
      await runtimeRequest("/api/codex-auth/login/code", {
        method: "POST",
        body: JSON.stringify({ flowId: start.flowId, input: code }),
      }, deps);
    }
    if (noWait) {
      if (wantsJson) printData(start, true);
      return;
    }
    if (!start.flowId) throw new CliUsageError("login did not return a flow id");
    for (let attempt = 0; attempt < 150; attempt++) {
      await Bun.sleep(2_000);
      const state = await runtimeRequest<Record<string, unknown>>(
        `/api/codex-auth/login-status?flowId=${encodeURIComponent(start.flowId)}${id ? `&accountId=${encodeURIComponent(id)}` : ""}${reauth ? "&reauth=1" : ""}`,
        {}, deps,
      );
      if (state.status === "done") {
        printData(state, wantsJson, [`Logged in${state.email ? ` as ${String(state.email)}` : ""}.`]);
        if (!wantsJson) warnIfCodexCatalogRefreshPending(state);
        return;
      }
      if (state.status === "error" || state.status === "expired") {
        throw new CliUsageError(String(state.error ?? `login ${state.status}`));
      }
    }
    throw new CliUsageError("login timed out");
  }

  if (id && !reauth) throw new CliUsageError("--id is only valid with --reauth for provider OAuth accounts", USAGE);
  const start = await runtimeRequest<LoginStart>("/api/oauth/login", {
    method: "POST",
    body: JSON.stringify({ provider, addAccount: !reauth, ...(reauth && id ? { accountId: id, reauth: true } : {}) }),
  }, deps);
  if (!wantsJson) {
    const block = [
      start.url ? `Open this URL to sign in:\n${start.url}` : "",
      start.instructions ?? "",
      start.deviceCode ? `Device code: ${start.deviceCode}` : "",
    ].filter(line => line !== "").join("\n");
    if (block) writeStdoutFully(`${block}\n`);
  }
  if (code) {
    await runtimeRequest("/api/oauth/login/code", {
      method: "POST",
      body: JSON.stringify({ provider, input: code }),
    }, deps);
  }
  if (noWait) {
    if (wantsJson) printData(start, true);
    return;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    await Bun.sleep(2_000);
    const state = await runtimeRequest<Record<string, unknown>>(`/api/oauth/status?provider=${encodeURIComponent(provider)}`, {}, deps);
    if (state.error) throw new CliUsageError(String(state.error));
    if (state.loggedIn === true) {
      printData(state, wantsJson, [`Logged in to ${provider}.`]);
      return;
    }
  }
  throw new CliUsageError("login timed out");
}

async function code(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const provider = args.shift()?.trim().toLowerCase();
  // Flags first. Taking the positional before parsing them made
  // `ocx account code openai --flow f1` read `--flow` as the code and then
  // reject `f1` as an unexpected argument.
  const wantsJson = takeFlag(args, "--json");
  const flowId = takeOption(args, "--flow");
  const suppliedCode = takeOptionWithSyntax(args, "--code");
  // An unknown flag is not a credential. Without this guard `--nope` becomes
  // the positional code and the real complaint ("unexpected argument") is
  // replaced by a confusing one about how the code was passed.
  const positional = args[0]?.startsWith("--") ? undefined : args.shift();
  if (!provider) throw new CliUsageError("provider is required", USAGE);
  // A second positional here is most likely the code, split by an unquoted
  // space or a stray shell expansion. Naming it back would put it on stderr.
  rejectArgs(args, USAGE, { redactValues: true });
  if (suppliedCode && positional !== undefined) {
    throw new CliUsageError("pass the code either positionally or with --code, not both", USAGE);
  }
  const input = await resolveCode(
    suppliedCode ?? (positional === undefined ? undefined : { value: positional, inline: false }),
    deps,
    true,
  );
  if (!input) throw new CliUsageError("provider and redirect/code are required", USAGE);
  const path = CODEX_NAMES.has(provider) ? "/api/codex-auth/login/code" : "/api/oauth/login/code";
  if (CODEX_NAMES.has(provider) && !flowId) throw new CliUsageError("Codex login code requires --flow <flow-id>", USAGE);
  const body = CODEX_NAMES.has(provider) ? { flowId, input } : { provider, input };
  const result = await runtimeRequest(path, { method: "POST", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, ["Login code submitted."]);
}

async function cancel(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const provider = args.shift()?.trim().toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  const flowId = takeOption(args, "--flow");
  if (!provider) throw new CliUsageError("provider is required", USAGE);
  rejectArgs(args, USAGE);
  const codex = CODEX_NAMES.has(provider);
  const result = await runtimeRequest(codex ? "/api/codex-auth/login/cancel" : "/api/oauth/login/cancel", {
    method: "POST",
    body: JSON.stringify(codex ? { flowId } : { provider }),
  }, deps);
  printData(result, wantsJson, [`Cancelled ${provider} login.`]);
}

async function resetCredits(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const rawId = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const consume = takeFlag(args, "--consume");
  const yes = takeFlag(args, "--yes");
  if (!rawId) throw new CliUsageError("account id is required", USAGE);
  if (consume && !yes) throw new CliUsageError("consuming a reset credit requires --yes", USAGE);
  rejectArgs(args, USAGE);
  const accountId = rawId === "main" ? "__main__" : rawId;
  const result = consume
    ? await runtimeRequest("/api/codex-auth/reset-credits/consume", { method: "POST", body: JSON.stringify({ accountId }) }, deps)
    : await runtimeRequest(`/api/codex-auth/reset-credits?accountId=${encodeURIComponent(accountId)}`, {}, deps);
  printData(result, wantsJson);
}

export async function handleAccountAuthCommand(sub: string, argv: string[], deps: RuntimeApiDeps = {}): Promise<number | null> {
  let action: (() => Promise<void>) | undefined;
  if (sub === "login" || sub === "reauth") action = () => login(sub === "reauth" ? [...argv, "--reauth"] : argv, deps);
  else if (sub === "code") action = () => code(argv, deps);
  else if (sub === "cancel") action = () => cancel(argv, deps);
  else if (sub === "reset-credits") action = () => resetCredits(argv, deps);
  if (!action) return null;
  return runCliAction(action);
}

export const ACCOUNT_AUTH_USAGE = USAGE;

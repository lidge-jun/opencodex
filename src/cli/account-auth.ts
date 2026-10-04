import { writeSync } from "node:fs";
import { isValidProviderName } from "../config/provider-name";
import { runCatalogAction } from "./catalog-command-result";
import { modelSelectionGuidance, modelSelectionNextSteps } from "./model-selection-guidance";
import { warnIfCodexCatalogRefreshPending } from "./account-catalog-refresh";
import { isCodexResetCreditOperationId } from "../codex/reset-credit-recovery";
import { BROWSER_LAUNCH_FAILED_NOTICE } from "../lib/browser-launch-notice";
import {
  CliUsageError,
  printData,
  readSecretLine,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  runtimeBaseUrl,
  terminalSafeText,
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
  ocx account login <provider> [--id <account-id>] [--reauth] [--device] [--method builder-id|google|github] [--open-browser on|off] [--add-account on|off] [--code -] [--no-wait] [--json]
  ocx account code <provider> [--flow <flow-id>] [--json]   (reads the code from stdin)
  ocx account cancel <provider> [--flow <flow-id>] [--json] (--flow required for codex)
  ocx account reset-credits <account-id|main> [--consume --yes [--operation-id <uuid>]] [--json]
  ocx account grok-reset-coupons [<account-id>] [--consume --yes [--token-id <token-id>] [--operation-id <uuid>]] [--json]

--device runs the OpenAI device-code login instead of the browser callback: use
it when the proxy has no browser or nothing can reach localhost:1455, such as a
headless or remote hub. Enter the printed code at the printed URL from any other
machine.

The redirect URL or authorization code is a short-lived credential. Pipe it in
rather than passing it as an argument, where it lands in shell history and is
visible to anyone who can run ps:
  pbpaste | ocx account code <provider> --flow <flow-id>
  ocx account login <provider> --code -   (same, for the login flow)`;

/**
 * The Codex account pool answers to three spellings, and a user reaches for whichever
 * one they already have a word for. `ocx login codex` routes here as well (dispatch.ts):
 * the pool is deliberately not an `ocx login` provider -- it keeps its own account
 * ledger and runs its browser flow inside the proxy -- but that is an implementation
 * boundary, not something a user should have to know before they can log in.
 */
const CODEX_NAMES = new Set(["openai", "codex", "chatgpt"]);

/** True for every spelling that means "the Codex account pool" rather than an OAuth provider. */
export function isCodexAccountLoginName(name: string): boolean {
  return CODEX_NAMES.has(name.trim().toLowerCase());
}

interface LoginStart {
  url?: string;
  flowId?: string;
  instructions?: string;
  deviceCode?: string;
  /** Whether the host actually opened a browser. Absent from older proxies. */
  browserLaunch?: "started" | "failed" | "skipped";
  method?: "builder-id" | "google" | "github";
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: number;
  state?: string;
  warning?: string;
}

/** Public handoff only. Never spread runtime bodies into terminal or JSON output. */
function loginObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid login reply");
  return value as Record<string, unknown>;
}
function publicLoginStart(value: unknown, kiro = false): LoginStart {
  const data = loginObject(value);
  const out: LoginStart = {};
  const strings = kiro
    ? ["flowId", "userCode", "verificationUri", "verificationUriComplete"] as const
    : ["url", "flowId", "instructions", "deviceCode"] as const;
  for (const key of strings) {
    if (data[key] !== undefined && typeof data[key] !== "string") throw new Error("Invalid login handoff field");
    if (typeof data[key] === "string") out[key] = data[key];
  }
  if (typeof data.browserLaunch === "string" && ["started", "failed", "skipped"].includes(data.browserLaunch)) out.browserLaunch = data.browserLaunch as LoginStart["browserLaunch"];
  if (typeof data.method === "string" && ["builder-id", "google", "github"].includes(data.method)) out.method = data.method as LoginStart["method"];
  if (typeof data.state === "string" && ["pending", "done", "failed", "expired", "cancelled"].includes(data.state)) out.state = data.state as string;
  if (typeof data.warning === "string" && ["duplicate_profile_arn", "manual_review_required"].includes(data.warning)) out.warning = data.warning as string;
  if (typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt)) out.expiresAt = data.expiresAt;
  return out;
}
function publicLoginStatus(value: unknown): Record<string, unknown> {
  const data = loginObject(value);
  const out: Record<string, unknown> = {};
  for (const key of ["accountId", "activeAccountId", "email"]) if (typeof data[key] === "string") out[key] = data[key];
  for (const key of ["loggedIn", "done", "needsReauth", "validationPending", "catalogRefreshPending"]) {
    if (data[key] !== undefined && typeof data[key] !== "boolean") throw new Error("Invalid login completion field");
    if (typeof data[key] === "boolean") out[key] = data[key];
  }
  if (typeof data.status === "string" && ["starting", "pending", "done", "error", "expired", "cancelled", "idle"].includes(data.status)) out.status = data.status;
  if (typeof data.source === "string" && ["oauth", "local-cli", "credential-file", "environment", "manual"].includes(data.source)) out.source = data.source;
  if (data.hint && typeof data.hint === "object" && !Array.isArray(data.hint)) out.hint = publicLoginStart(data.hint);
  if (Array.isArray(data.accounts)) out.accounts = data.accounts.map(value => {
    const row = loginObject(value);
    const account: Record<string, unknown> = {};
    for (const key of ["id", "alias", "email"]) if (typeof row[key] === "string") account[key] = row[key];
    for (const key of ["active", "needsReauth"]) if (typeof row[key] === "boolean") account[key] = row[key];
    if (row.needsReauthReason === "verify_account") account.needsReauthReason = "verify_account";
    if (typeof row.expiresAt === "number" && Number.isFinite(row.expiresAt)) account.expiresAt = row.expiresAt;
    if (row.plan === null) account.plan = null;
    return account;
  });
  return out;
}
function loginBoolean(args: string[], flag: string): boolean | undefined {
  const option = takeOptionWithSyntax(args, flag);
  if (!option) return undefined;
  if (option.value !== "on" && option.value !== "off") throw new CliUsageError(`${flag} must be on or off`, USAGE);
  return option.value === "on";
}
function writeLoginInstructions(lines: readonly string[]): void {
  const block = lines.filter(line => line !== "").flatMap(line => line.split("\n")).map(terminalSafeText).join("\n");
  if (block) writeStdoutFully(`${block}\n`);
}

/**
 * Said only when the host could not open a browser (#5261).
 *
 * Without it, a failed launch is indistinguishable from a successful one: the URL is printed
 * either way, so the user waits at a terminal that looks like it is working. Names the fixed
 * callback port because that is the part people cannot guess — ChatGPT supplies the redirect
 * URI, so the flow cannot move to a free port, and `--device` is the way around it.
 *
 * Extends the shared notice rather than repeating it: only the second line is specific to this
 * flow, and the first is the sentence every other login prints for the same failure.
 */
export const BROWSER_LAUNCH_FAILED_HINT =
  BROWSER_LAUNCH_FAILED_NOTICE
  + "\n   If nothing on this machine can reach http://localhost:1455, rerun with --device instead.";

/** `-` means "read it from stdin", the documented way to pass a code silently. */
const STDIN_SENTINEL = "-";

/** Providers whose ONLY login is already a device flow; --device is redundant, not wrong. */
const DEVICE_NATIVE_PROVIDERS = new Set(["kimi", "nous", "github-copilot"]);
const stripTerminalControls = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
export function formatKiroDeviceInstructions(start: { verificationUriComplete?: string; verificationUri?: string; userCode?: string; flowId?: string }): string {
  return [
    stripTerminalControls(start.verificationUriComplete ?? start.verificationUri ?? ""),
    start.userCode ? `User code: ${stripTerminalControls(start.userCode)}` : "",
    start.flowId ? `Flow: ${stripTerminalControls(start.flowId)}` : "",
  ].filter(Boolean).join("\n");
}

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

async function login(argv: string[], deps: RuntimeApiDeps): Promise<number | void> {
  const args = [...argv];
  const provider = args.shift()?.trim().toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  const noWait = takeFlag(args, "--no-wait");
  const reauth = takeFlag(args, "--reauth");
  const device = takeFlag(args, "--device");
  const method = takeOption(args, "--method");
  const id = takeOption(args, "--id");
  const suppliedCode = takeOptionWithSyntax(args, "--code");
  const openBrowser = loginBoolean(args, "--open-browser");
  const addAccount = loginBoolean(args, "--add-account");
  if (provider && !isValidProviderName(provider)) throw new CliUsageError("invalid provider name", USAGE);
  if (!provider) throw new CliUsageError("provider is required", USAGE);
  if (method !== undefined) {
    if (provider !== "kiro" || !["builder-id", "google", "github"].includes(method)) {
      throw new CliUsageError("--method requires kiro and builder-id, google, or github", USAGE);
    }
    if (reauth || id) throw new CliUsageError("native Kiro device login only adds accounts; remove and re-add to reauthenticate", USAGE);
    if (openBrowser !== undefined || addAccount !== undefined) throw new CliUsageError("native Kiro --method does not accept --open-browser or --add-account", USAGE);
    if (device || suppliedCode) throw new CliUsageError("--method cannot be combined with --device or --code", USAGE);
  }
  // A malformed leftover may contain pasted authorization input, even inside an
  // unknown flag. New login parsing reports only a fixed usage diagnostic.
  if (args.length) throw new CliUsageError("Unexpected arguments or repeated options", USAGE);
  // kimi, nous, and github-copilot are already device flows, so --device is a
  // true statement about them and is accepted as a no-op rather than an error.
  // Anything else has no device grant at all and must fail loudly.
  if (device && !CODEX_NAMES.has(provider) && !DEVICE_NATIVE_PROVIDERS.has(provider)) {
    throw new CliUsageError("--device is not supported for this provider", USAGE);
  }
  if (addAccount !== undefined && (reauth || CODEX_NAMES.has(provider))) throw new CliUsageError("--add-account is only valid for fresh provider OAuth login", USAGE);
  if (openBrowser !== undefined && (device || DEVICE_NATIVE_PROVIDERS.has(provider))) throw new CliUsageError("--open-browser is not supported for device login", USAGE);
  if (!CODEX_NAMES.has(provider) && id && !reauth) throw new CliUsageError("--id is only valid with --reauth for provider OAuth accounts", USAGE);
  // Only resolve when --code was actually given: a plain `ocx account login`
  // opens the browser flow and polls, and must not block on stdin.
  const code = await resolveCode(suppliedCode, deps, false);
  const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };

  if (method) {
    const start = publicLoginStart(await runtimeRequest<unknown>("/api/oauth/login", {
      method: "POST", redirect: "error", body: JSON.stringify({ provider: "kiro", method }),
    }, pinned), true);
    if (!wantsJson) {
      const block = formatKiroDeviceInstructions(start);
      if (block) writeStdoutFully(`${block}\n`);
    }
    if (noWait) { printData(start, wantsJson, []); return; }
    if (!start.flowId) throw new CliUsageError("Kiro device login did not return a flow id");
    for (let attempt = 0; attempt < 450; attempt++) {
      await Bun.sleep(2_000);
      const state = publicLoginStart(await runtimeRequest<unknown>(`/api/oauth/status?provider=kiro&flowId=${encodeURIComponent(start.flowId)}`, { redirect: "error" }, pinned), true);
      if (state.state === "done") {
        printData(state, wantsJson, ["Logged in to kiro.", ...(state.warning ? [`Warning: ${state.warning}`] : [])]);
        return;
      }
      if (state.state === "failed" || state.state === "expired" || state.state === "cancelled") {
        throw new CliUsageError(`Kiro device login ${state.state}`);
      }
    }
    throw new CliUsageError("Kiro device login timed out");
  }

  if (CODEX_NAMES.has(provider)) {
    const start = publicLoginStart(await runtimeRequest<unknown>("/api/codex-auth/login", {
      method: "POST", redirect: "error",
      body: JSON.stringify({
        ...(id ? { id } : {}),
        ...(reauth ? { reauth: true } : {}),
        ...(device ? { device: true } : {}),
        ...(openBrowser === undefined ? {} : { openBrowser }),
      }),
    }, pinned));
    if (!wantsJson) {
      // One atomic pre-poll block, flushed synchronously so a piped parent
      // reads the URL before the polling window starts (#1007).
      writeLoginInstructions([
        start.url ? `Open this URL to sign in:\n${start.url}` : "",
        start.deviceCode ? `Device code: ${start.deviceCode}` : "",
        start.instructions ?? "",
        start.browserLaunch === "failed" ? BROWSER_LAUNCH_FAILED_HINT : "",
        start.flowId ? `Flow: ${start.flowId}` : "",
      ]);
    }
    if (code && !start.flowId) throw new Error("Code submission requires a returned flow id");
    if (code && start.flowId) {
      const submitted = await runtimeRequest("/api/codex-auth/login/code", {
        method: "POST", redirect: "error",
        body: JSON.stringify({ flowId: start.flowId, input: code }),
      }, pinned);
      if (loginObject(submitted).ok !== true) throw new Error("Code submission was not accepted");
    }
    if (noWait) {
      printData({ ...start, modelSelection: modelSelectionNextSteps("openai", true) }, wantsJson, modelSelectionGuidance("openai", true));
      return;
    }
    if (!start.flowId) throw new CliUsageError("login did not return a flow id");
    // A device login is deliberately slow: the user leaves this machine to
    // enter the code elsewhere. Match the 15-minute grant instead of giving up
    // at minute five while it is still valid, plus settlement margin for the
    // token exchange and credential write after the final poll.
    const maxAttempts = device ? 480 : 150;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await Bun.sleep(2_000);
      const state = publicLoginStatus(await runtimeRequest<unknown>(
        `/api/codex-auth/login-status?flowId=${encodeURIComponent(start.flowId)}${id ? `&accountId=${encodeURIComponent(id)}` : ""}${reauth ? "&reauth=1" : ""}`,
        { redirect: "error" }, pinned,
      ));
      if (start.flowId) state.flowId = start.flowId;
      if (state.status === "done") {
        if (state.validationPending === true) {
          printData({ ...state, recoveryCommand: "ocx gui", recoveryAction: "After quota recovers, click Refresh quotas in the dashboard Codex account pool." }, wantsJson, [
            "Account registered; validation pending (routing disabled).",
            "After quota recovers, open 'ocx gui' and click Refresh quotas to complete validation.",
          ]);
        } else {
          printData({ ...state, modelSelection: modelSelectionNextSteps("openai") }, wantsJson, [`Logged in${state.email ? ` as ${String(state.email)}` : ""}.`, ...modelSelectionGuidance("openai")]);
        }
        if (!wantsJson) warnIfCodexCatalogRefreshPending(state);
        return state.validationPending === true || state.catalogRefreshPending === true ? 1 : 0;
      }
      if (state.status === "error" || state.status === "expired" || state.status === "cancelled") {
        throw new Error("Login failed or expired");
      }
    }
    throw new CliUsageError("login timed out");
  }

  const start = publicLoginStart(await runtimeRequest<unknown>("/api/oauth/login", {
    method: "POST", redirect: "error",
    body: JSON.stringify({ provider, addAccount: addAccount ?? !reauth, ...(openBrowser === undefined ? {} : { openBrowser }), ...(reauth && id ? { accountId: id, reauth: true } : {}) }),
  }, pinned));
  if (!wantsJson) {
    writeLoginInstructions([
      start.url ? `Open this URL to sign in:\n${start.url}` : "",
      start.instructions ?? "",
      start.deviceCode ? `Device code: ${start.deviceCode}` : "",
    ]);
  }
  if (code) {
    const submitted = await runtimeRequest("/api/oauth/login/code", {
      method: "POST", redirect: "error",
      body: JSON.stringify({ provider, input: code }),
    }, pinned);
    if (loginObject(submitted).ok !== true) throw new Error("Code submission was not accepted");
  }
  if (noWait) {
    printData({ ...start, modelSelection: modelSelectionNextSteps(provider, true) }, wantsJson, modelSelectionGuidance(provider, true));
    return;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    await Bun.sleep(2_000);
    const raw = await runtimeRequest<Record<string, unknown>>(`/api/oauth/status?provider=${encodeURIComponent(provider)}`, { redirect: "error" }, pinned);
    if (loginObject(raw).error) throw new Error("Provider login failed");
    const state = publicLoginStatus(raw);
    if (state.done === true && state.loggedIn !== true) throw new Error("Provider login ended without authentication");
    if (state.loggedIn === true) {
      printData({ ...state, modelSelection: modelSelectionNextSteps(provider) }, wantsJson, [`Logged in to ${provider}.`, ...modelSelectionGuidance(provider)]);
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
  const flowId = takeOption(args, "--flow")?.trim();
  if (!provider) throw new CliUsageError("provider is required", USAGE);
  rejectArgs(args, USAGE);
  const codex = CODEX_NAMES.has(provider);
  if (codex && !flowId) {
    throw new CliUsageError("Codex login cancel requires --flow <flow-id> (printed by 'ocx account login').", USAGE);
  }
  const result = await runtimeRequest(codex ? "/api/codex-auth/login/cancel" : "/api/oauth/login/cancel", {
    method: "POST",
    body: JSON.stringify(codex ? { flowId } : { provider, ...(provider === "kiro" && flowId ? { flowId } : {}) }),
  }, deps);
  printData(result, wantsJson, [`Cancelled ${provider} login.`]);
}

async function resetCredits(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const rawId = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const consume = takeFlag(args, "--consume");
  const yes = takeFlag(args, "--yes");
  // Before rejectArgs: takeOption splices its two tokens out of `args`.
  const operationId = takeOption(args, "--operation-id");
  if (!rawId) throw new CliUsageError("account id is required", USAGE);
  if (consume && !yes) throw new CliUsageError("consuming a reset credit requires --yes", USAGE);
  if (operationId !== undefined && !consume) {
    throw new CliUsageError("--operation-id requires --consume", USAGE);
  }
  if (operationId !== undefined && !isCodexResetCreditOperationId(operationId)) {
    throw new CliUsageError("--operation-id must be a UUIDv4", USAGE);
  }
  rejectArgs(args, USAGE);
  const accountId = rawId === "main" ? "__main__" : rawId;
  const result = consume
    ? await runtimeRequest("/api/codex-auth/reset-credits/consume", {
      method: "POST",
      // Spread, not `operationId: undefined`: the server distinguishes an absent
      // key (legacy random id) from a caller who asked for a stable identity.
      body: JSON.stringify({ accountId, ...(operationId === undefined ? {} : { operationId }) }),
    }, deps)
    : await runtimeRequest(`/api/codex-auth/reset-credits?accountId=${encodeURIComponent(accountId)}`, {}, deps);
  printData(result, wantsJson);
}

async function grokResetCoupons(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  // The account id is optional here (the server falls back to the selected xAI
  // account), so a flag-shaped first token must not be swallowed as the id:
  // `grok-reset-coupons --consume` has to reach the --yes gate, not become a
  // read of account "--consume".
  const rawId = args[0]?.startsWith("--") ? undefined : args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const consume = takeFlag(args, "--consume");
  const yes = takeFlag(args, "--yes");
  // Before rejectArgs: takeOption splices its two tokens out of `args`.
  const tokenId = takeOption(args, "--token-id");
  const operationId = takeOption(args, "--operation-id");
  if (consume && !yes) throw new CliUsageError("consuming a Grok reset coupon requires --yes", USAGE);
  if (operationId !== undefined && !consume) {
    throw new CliUsageError("--operation-id requires --consume", USAGE);
  }
  if (tokenId !== undefined && !consume) {
    throw new CliUsageError("--token-id requires --consume", USAGE);
  }
  if (operationId !== undefined && !isCodexResetCreditOperationId(operationId)) {
    throw new CliUsageError("--operation-id must be a UUIDv4", USAGE);
  }
  rejectArgs(args, USAGE);
  const accountId = rawId ? (rawId === "main" ? "__main__" : rawId) : undefined;
  const result = consume
    ? await runtimeRequest("/api/grok/reset-coupons/consume", {
      method: "POST",
      // Spread, not `operationId: undefined`: the server distinguishes an absent
      // key from a caller who asked for a stable idempotency identity.
      body: JSON.stringify({ accountId, tokenId, ...(operationId === undefined ? {} : { operationId }) }),
    }, deps)
    : await runtimeRequest(
      `/api/grok/reset-coupons${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`,
      {},
      deps,
    );
  printData(result, wantsJson);
}

export async function handleAccountAuthCommand(sub: string, argv: string[], deps: RuntimeApiDeps = {}): Promise<number | null> {
  let action: (() => Promise<void>) | undefined;
  if (sub === "login" || sub === "reauth") return runCatalogAction(() => login(sub === "reauth" ? [...argv, "--reauth"] : argv, deps));
  else if (sub === "code") action = () => code(argv, deps);
  else if (sub === "cancel") action = () => cancel(argv, deps);
  else if (sub === "reset-credits") action = () => resetCredits(argv, deps);
  else if (sub === "grok-reset-coupons") action = () => grokResetCoupons(argv, deps);
  if (!action) return null;
  return runCliAction(action);
}

export const ACCOUNT_AUTH_USAGE = USAGE;

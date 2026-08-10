/**
 * Shared management-plane client for headless CLI commands.
 *
 * [Decision Log]
 * - 목적과 의도: GUI가 사용하는 관리 기능을 CLI에서도 같은 검증과 저장 경로로 제공한다.
 * - 기존 구현 및 제약 조건: 관리 API에 이미 도메인 검증과 live-config 갱신이 있으나 CLI마다 fetch를 복제했다.
 * - 검토한 주요 대안: config.json 직접 수정, 각 CLI 모듈별 fetch 구현, 공용 관리 API client.
 * - 선택한 방식: identity-checked live proxy를 찾은 뒤 공용 client로 관리 API를 호출한다.
 * - 다른 대안 대신 이 방식을 선택한 이유: GUI/CLI의 검증 규칙이 갈라지지 않고 fallback port도 안전하게 찾는다.
 * - 장점, 단점 및 영향: 동작 일관성이 높아지는 대신 live 관리 명령은 실행 중인 proxy가 필요하다.
 */
import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
import { runningProxyUpdateHeaders } from "../oauth/login-cli";

export type CliStdin = NodeJS.ReadableStream & { isTTY?: boolean; readableEnded?: boolean };

export interface RuntimeApiDeps {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Test injection for commands that read a secret from stdin instead of argv. */
  stdinImpl?: CliStdin;
  stdinTimeoutMs?: number;
}

export class CliUsageError extends Error {
  constructor(message: string, readonly usage?: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class RuntimeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "RuntimeApiError";
  }
}

export async function runtimeBaseUrl(deps: RuntimeApiDeps = {}): Promise<string> {
  if (deps.baseUrl) return deps.baseUrl.replace(/\/$/, "");
  const live = await findLiveProxy();
  if (!live) throw new RuntimeApiError("Proxy is not running. Start it with: ocx start", 503, null);
  return `http://${probeHostname(live.hostname)}:${live.port}`;
}

function responseMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 400);
  return `Management request failed (${status})`;
}

export async function runtimeRequest<T = unknown>(
  path: string,
  init: RequestInit = {},
  deps: RuntimeApiDeps = {},
): Promise<T> {
  const baseUrl = await runtimeBaseUrl(deps);
  const headers = runningProxyUpdateHeaders();
  for (const [key, value] of new Headers(init.headers).entries()) headers.set(key, value);
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers });
  } catch (error) {
    throw new RuntimeApiError(
      `Management API is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      503,
      null,
    );
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = text; }
  }
  if (!response.ok) throw new RuntimeApiError(responseMessage(body, response.status), response.status, body);
  return body as T;
}

export function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

export function takeOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliUsageError(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
}

export function takeBooleanOption(args: string[], flag: string): boolean | undefined {
  const raw = takeOption(args, flag);
  if (raw === undefined) return undefined;
  if (["on", "true", "yes", "1", "enabled"].includes(raw.toLowerCase())) return true;
  if (["off", "false", "no", "0", "disabled"].includes(raw.toLowerCase())) return false;
  throw new CliUsageError(`${flag} must be on or off`);
}

export function takeIntegerOption(args: string[], flag: string, options: { min?: number } = {}): number | undefined {
  const raw = takeOption(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw.replace(/[_,]/g, ""));
  if (!Number.isInteger(value) || value < (options.min ?? Number.MIN_SAFE_INTEGER)) {
    throw new CliUsageError(`${flag} must be an integer${options.min !== undefined ? ` >= ${options.min}` : ""}`);
  }
  return value;
}

export function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];
}

/**
 * Options whose VALUE is a credential (or can carry one), listed here so a parse
 * error never prints one. `--headers` belongs on the list defensively: custom
 * headers are documented as non-secret metadata and the validator rejects the
 * standard credential names, but it cannot recognize an arbitrary one such as
 * `X-My-Token`, so a parse error must not echo the value back either way.
 *
 * `takeOption` only understands `--flag value`. `--flag=value` therefore falls
 * through to `rejectArgs`, which reports the offending argument verbatim — for
 * `--code=https://…?code=SECRET` that writes the authorization code to stderr,
 * which is the exact exposure the stdin path exists to avoid.
 */
const SECRET_OPTIONS = ["--code", "--headers"];

/**
 * Replace credential values before they are reported back.
 *
 * Both spellings have to be covered, and the space-separated one spans two
 * tokens: mistyping `ocx account cancel <p> --code <secret>` on a command that
 * does not parse `--code` leaves the flag AND its value in the leftovers, and
 * reporting them verbatim writes the credential to stderr. Repeating the
 * option does the same with the second value, since the parser takes only the
 * first occurrence.
 *
 * The token after the option is redacted whatever it looks like. Skipping
 * `--`-prefixed tokens read as "that is a flag, not a value", but the shell
 * hands over whatever was typed: `--code --SUPERSECRET` and
 * `--code -- SUPERSECRET` both put the credential straight in the message. A
 * mistaken `--code --json` now reads `--code <redacted>`, which is worse
 * diagnostics for a case that already prints the usage text, and better than
 * printing a credential.
 *
 * `redactValues` extends that to bare leftovers, for commands whose positional
 * argument is itself a credential.
 */
function redactSecretArgs(args: string[], redactValues = false): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    const inline = SECRET_OPTIONS.find(option => arg.startsWith(`${option}=`));
    if (inline) {
      out.push(`${inline}=<redacted>`);
      continue;
    }
    if (SECRET_OPTIONS.includes(arg)) {
      out.push(arg);
      // Swallow the value that belongs to it. `--` is an end-of-options
      // separator, so the value is the token after it.
      let valueIndex = index + 1;
      if (args[valueIndex] === "--") {
        out.push("--");
        valueIndex++;
      }
      if (args[valueIndex] !== undefined) {
        out.push("<redacted>");
        index = valueIndex;
      }
      continue;
    }
    out.push(redactValues && !arg.startsWith("-") ? "<redacted>" : arg);
  }
  return out;
}

export interface RejectArgsOptions {
  /**
   * Report bare leftovers as `<redacted>`. Set by commands where a stray
   * positional is plausibly the credential itself — `ocx account code <p>`
   * takes one positional code, so a second one is echoed by the usage error
   * unless it is hidden. Flag-shaped leftovers stay visible, because a
   * mistyped flag is the thing the message needs to name.
   */
  redactValues?: boolean;
}

export function rejectArgs(args: string[], usage: string, options?: RejectArgsOptions): void {
  if (args.length > 0) {
    const shown = redactSecretArgs(args, options?.redactValues === true);
    throw new CliUsageError(`Unexpected argument(s): ${shown.join(" ")}`, usage);
  }
}

/**
 * `--flag value` or `--flag=value`, reporting which spelling was used.
 *
 * The equals form is accepted rather than rejected: rejecting it routes the
 * value through `rejectArgs`, and a caller who typed `--code=<secret>` would
 * see their credential echoed back. Accepting it lets the command warn about
 * the shell-history exposure without repeating the value.
 */
export function takeOptionWithSyntax(
  args: string[],
  flag: string,
): { value: string; inline: boolean } | undefined {
  const occurrences = args.filter(arg => arg === flag || arg.startsWith(`${flag}=`)).length;
  // Taking only the first occurrence would leave the second value in the
  // leftovers for rejectArgs to report. Say what is wrong without repeating
  // either value.
  if (occurrences > 1) throw new CliUsageError(`${flag} was given more than once`);

  const inlineIndex = args.findIndex(arg => arg.startsWith(`${flag}=`));
  if (inlineIndex !== -1) {
    const [raw] = args.splice(inlineIndex, 1) as [string];
    const value = raw.slice(flag.length + 1);
    if (!value) throw new CliUsageError(`${flag} requires a value`);
    return { value, inline: true };
  }
  const value = takeOption(args, flag);
  return value === undefined ? undefined : { value, inline: false };
}

/**
 * Read one line from stdin without it ever reaching argv.
 *
 * Same shape as `readStdinLine` in account-extended.ts: resolve on the first
 * newline, on end-of-stream, or reject on timeout, and always drop the
 * listeners so a caller that continues running does not leak them.
 */
export async function readSecretLine(deps: RuntimeApiDeps, label: string): Promise<string> {
  const input: CliStdin = deps.stdinImpl ?? process.stdin;
  const timeoutMs = deps.stdinTimeoutMs ?? 120_000;
  // A stream that already ended emits nothing more, so attaching listeners
  // would wait out the full timeout and then blame a slow paste. `echo … |
  // something-else | ocx account code <p>` reaches here that way.
  if (input.readableEnded === true) throw new CliUsageError(`${label} input was empty`);
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onData = (chunk: unknown) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const newline = buffer.search(/[\r\n]/);
      if (newline >= 0) finish(() => resolve(buffer.slice(0, newline).trim()));
    };
    const onEnd = () => finish(() => resolve(buffer.trim()));
    const onError = (error: Error) => finish(() => reject(error));
    const timer = setTimeout(
      () => finish(() => reject(new CliUsageError(`timed out waiting for ${label} on stdin`))),
      timeoutMs,
    );
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
  if (!line) throw new CliUsageError(`${label} input was empty`);
  return line;
}

export function printData(value: unknown, wantsJson: boolean, lines?: string[]): void {
  if (wantsJson || !lines) console.log(JSON.stringify(value, null, 2));
  else for (const line of lines) console.log(line);
}

/** Compact human view for safe management DTOs; JSON remains available for complete fidelity. */
export function summaryLines(value: unknown, prefix = "", depth = 0): string[] {
  if (!value || typeof value !== "object" || depth > 1) return [`${prefix || "value"}: ${String(value)}`];
  const lines: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(child)) {
      const scalar = child.every(item => item === null || ["string", "number", "boolean"].includes(typeof item));
      lines.push(`${label}: ${scalar ? child.join(", ") || "none" : `${child.length} item(s)`}`);
    } else if (child && typeof child === "object" && depth < 1) {
      lines.push(...summaryLines(child, label, depth + 1));
    } else {
      lines.push(`${label}: ${child === null || child === undefined || child === "" ? "-" : String(child)}`);
    }
  }
  return lines;
}

export async function runCliAction(action: () => Promise<void>): Promise<number> {
  try {
    await action();
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`Error: ${error.message}`);
      if (error.usage) console.error(error.usage);
      return 2;
    }
    if (error instanceof RuntimeApiError) {
      console.error(`Error: ${error.message}`);
      return error.status === 404 ? 4 : error.status === 409 ? 5 : 1;
    }
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

import type { OAuthController, OAuthCredentials } from "./types";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAddrInUse } from "../server/ports";
import { parseCallbackInput } from "./callback-server";

const COMMAND_CODE_STUDIO_URL = "https://commandcode.ai";
const COMMAND_CODE_CALLBACK_PORT = 5959;
const LOGIN_TIMEOUT_MS = 120_000;
const CALLBACK_PATH = "/callback";

interface CommandCodeCallback {
  apiKey: string;
  state: string;
  userId: string;
  userName: string;
  keyName: string;
}

interface CommandCodeLocalAuth {
  apiKey?: unknown;
  userId?: unknown;
}

export interface CommandCodeLoginOptions {
  /** Add-account and reauthentication flows must select a fresh browser identity. */
  importLocal?: "fallback" | "off";
}

export function shouldImportLocalCommandCodeAuth(options: CommandCodeLoginOptions = {}): boolean {
  return options.importLocal !== "off";
}

async function importLocalCommandCodeAuth(signal?: AbortSignal): Promise<OAuthCredentials | undefined> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Command Code login aborted", "AbortError");
  }
  let parsed: CommandCodeLocalAuth;
  try {
    parsed = JSON.parse(await Bun.file(join(homedir(), ".commandcode", "auth.json")).text()) as CommandCodeLocalAuth;
  } catch {
    return undefined;
  }
  if (typeof parsed.apiKey !== "string" || parsed.apiKey.length === 0) return undefined;
  let accountId: string | undefined;
  try {
    const response = await fetch("https://api.commandcode.ai/alpha/whoami", {
      headers: { Authorization: `Bearer ${parsed.apiKey}`, Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    // Carry the validated whoami identity so an imported credential keeps multi-account
    // semantics even when the local auth.json omits userId.
    const body = (await response.json()) as { user?: { id?: unknown } };
    if (typeof body.user?.id === "string" && body.user.id.length > 0) accountId = body.user.id;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Command Code login aborted", "AbortError");
    return undefined;
  }
  if (!accountId && typeof parsed.userId === "string" && parsed.userId.length > 0) accountId = parsed.userId;
  return {
    access: parsed.apiKey,
    refresh: parsed.apiKey,
    expires: Number.MAX_SAFE_INTEGER,
    ...(accountId ? { accountId } : {}),
    source: "local-cli",
  };
}

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function parseCommandCodeCallback(value: unknown, expectedState: string): CommandCodeCallback {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Command Code callback must be an object");
  }
  const body = value as Record<string, unknown>;
  if (body.state !== expectedState) throw new Error("Command Code OAuth state mismatch");
  for (const field of ["apiKey", "userId", "userName", "keyName"] as const) {
    if (typeof body[field] !== "string" || body[field].length === 0) {
      throw new Error(`Command Code callback missing ${field}`);
    }
  }
  return body as unknown as CommandCodeCallback;
}

function createCallbackServer(state: string): {
  servers: Array<ReturnType<typeof Bun.serve>>;
  callback: Promise<CommandCodeCallback>;
} {
  let resolve!: (value: CommandCodeCallback) => void;
  const callback = new Promise<CommandCodeCallback>((res) => { resolve = res; });
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const headers = new Headers({
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin === COMMAND_CODE_STUDIO_URL ? origin : COMMAND_CODE_STUDIO_URL,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (url.pathname !== CALLBACK_PATH) return Response.json({ success: false, error: "Not found" }, { status: 404, headers });
    if (request.method !== "POST") return Response.json({ success: false, error: "Method not allowed" }, { status: 405, headers });
    try {
      const body = await request.json();
      const parsed = parseCommandCodeCallback(body, state);
      queueMicrotask(() => resolve(parsed));
      return Response.json({ success: true }, { headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ success: false, error: message }, { status: 400, headers });
    }
  };
  const create = (port: number): Array<ReturnType<typeof Bun.serve>> => {
    // The advertised callback host is `127.0.0.1`; on Windows `localhost` commonly resolves to `::1`
    // first, so also bind the IPv6 loopback best-effort (mirrors the shared OAuthCallbackFlow).
    const servers = [Bun.serve({ hostname: "127.0.0.1", port, fetch })];
    try {
      servers.push(Bun.serve({ hostname: "::1", port: servers[0].port, fetch }));
    } catch (error) {
      if (isAddrInUse(error)) {
        for (const server of servers) server.stop(true);
        throw error;
      }
      // IPv6 unsupported (EAFNOSUPPORT etc.) degrades to the IPv4-only listener.
    }
    return servers;
  };
  try {
    return { servers: create(COMMAND_CODE_CALLBACK_PORT), callback };
  } catch {
    return { servers: create(0), callback };
  }
}

/** Validate a raw pasted Command Code API key and return the validated identity. */
async function validatePastedApiKey(apiKey: string): Promise<{ userId: string; userName: string } | undefined> {
  try {
    const response = await fetch("https://api.commandcode.ai/alpha/whoami", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { user?: { id?: unknown; userName?: unknown } };
    const userId = body.user?.id;
    const userName = body.user?.userName;
    if (typeof userId !== "string" || typeof userName !== "string") return undefined;
    if (!userId.trim() || !userName.trim()) return undefined;
    return { userId, userName };
  } catch {
    return undefined;
  }
}

/** Manual-paste fallback: a raw API key, or a pasted callback JSON/URL that carries `apiKey`. */
function parsePastedCommandCodeInput(input: string, expectedState: string): CommandCodeCallback | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      return parseCommandCodeCallback(JSON.parse(trimmed) as unknown, expectedState);
    } catch {
      return undefined;
    }
  }
  const parsed = parseCallbackInput(trimmed);
  const apiKey = parsed.code?.trim();
  if (!apiKey) return undefined;
  // A URL/query-shaped paste is an authorization response and must carry a matching state,
  // mirroring the shared OAuth callback flow; a stale or attacker-supplied URL from another
  // session must not be accepted. Raw in-session keys are exempt (no state to compare).
  if (parsed.kind !== "raw" && parsed.state !== expectedState) return undefined;
  return { apiKey, state: expectedState, userId: "", userName: "", keyName: "manual" };
}

export async function loginCommandCode(ctrl: OAuthController, options: CommandCodeLoginOptions = {}): Promise<OAuthCredentials> {
  if (ctrl.signal?.aborted) {
    throw ctrl.signal.reason ?? new DOMException("Command Code login aborted", "AbortError");
  }
  if (shouldImportLocalCommandCodeAuth(options)) {
    const local = await importLocalCommandCodeAuth(ctrl.signal);
    if (local) {
      ctrl.onProgress?.("Imported existing Command Code CLI authentication.");
      return local;
    }
  }
  const state = randomState();
  let servers: Array<ReturnType<typeof Bun.serve>> = [];
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const created = createCallbackServer(state);
    servers = created.servers;
    const callbackUrl = `http://127.0.0.1:${servers[0].port}${CALLBACK_PATH}`;
    const authUrl = `${COMMAND_CODE_STUDIO_URL}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;
    ctrl.onAuth?.({ url: authUrl, instructions: "Sign in with Command Code in the browser." });
    ctrl.onProgress?.("Waiting for Command Code authentication...");
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Command Code OAuth callback timed out")), LOGIN_TIMEOUT_MS);
      ctrl.signal?.addEventListener("abort", () => { if (timeoutId) clearTimeout(timeoutId); reject(ctrl.signal?.reason); }, { once: true });
    });
    const manual = ctrl.onManualCodeInput
      ? (async (): Promise<CommandCodeCallback> => {
          while (true) {
            // The loop keeps waiting until a valid paste arrives; invalid pastes re-prompt.
            // Yield between iterations so an abort signal can interrupt a fast re-prompt loop.
            if (ctrl.signal?.aborted) throw ctrl.signal.reason ?? new DOMException("Command Code login aborted", "AbortError");
            const input = await ctrl.onManualCodeInput?.(state);
            if (input === undefined) continue;
            const pasted = parsePastedCommandCodeInput(input, state);
            if (!pasted) continue;
            const identity = await validatePastedApiKey(pasted.apiKey);
            if (identity) return { ...pasted, ...identity };
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        })()
      : undefined;
    const result = await Promise.race([created.callback, timeout, ...(manual ? [manual] : [])]);
    if (result === undefined) throw new Error("Command Code OAuth callback cancelled");
    return {
      access: result.apiKey,
      refresh: result.apiKey,
      expires: Number.MAX_SAFE_INTEGER,
      accountId: result.userId,
      source: "oauth",
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    for (const server of servers) server.stop(true);
  }
}

export async function refreshCommandCodeToken(apiKey: string): Promise<OAuthCredentials> {
  if (!apiKey) throw new Error("Command Code API key missing; run ocx login command-code");
  return { access: apiKey, refresh: apiKey, expires: Number.MAX_SAFE_INTEGER, source: "oauth" };
}

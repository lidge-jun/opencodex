import type { OAuthController, OAuthCredentials } from "./types";
import { homedir } from "node:os";
import { join } from "node:path";

const COMMAND_CODE_STUDIO_URL = "https://commandcode.ai";
const COMMAND_CODE_CALLBACK_PORT = 5959;
const LOGIN_TIMEOUT_MS = 120_000;

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

async function importLocalCommandCodeAuth(): Promise<OAuthCredentials | undefined> {
  let parsed: CommandCodeLocalAuth;
  try {
    parsed = JSON.parse(await Bun.file(join(homedir(), ".commandcode", "auth.json")).text()) as CommandCodeLocalAuth;
  } catch {
    return undefined;
  }
  if (typeof parsed.apiKey !== "string" || parsed.apiKey.length === 0) return undefined;
  try {
    const response = await fetch("https://api.commandcode.ai/alpha/whoami", {
      headers: { Authorization: `Bearer ${parsed.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
  } catch {
    return undefined;
  }
  return {
    access: parsed.apiKey,
    refresh: parsed.apiKey,
    expires: Number.MAX_SAFE_INTEGER,
    ...(typeof parsed.userId === "string" && parsed.userId.length > 0 ? { accountId: parsed.userId } : {}),
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
  server: ReturnType<typeof Bun.serve>;
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
    if (url.pathname !== "/callback") return Response.json({ success: false, error: "Not found" }, { status: 404, headers });
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
  try {
    return { server: Bun.serve({ hostname: "127.0.0.1", port: COMMAND_CODE_CALLBACK_PORT, fetch }), callback };
  } catch {
    return { server: Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }), callback };
  }
}

export async function loginCommandCode(ctrl: OAuthController): Promise<OAuthCredentials> {
  const local = await importLocalCommandCodeAuth();
  if (local) {
    ctrl.onProgress?.("Imported existing Command Code CLI authentication.");
    return local;
  }
  const state = randomState();
  const { server, callback } = createCallbackServer(state);
  const callbackUrl = `http://localhost:${server.port}/callback`;
  const authUrl = `${COMMAND_CODE_STUDIO_URL}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;
  ctrl.onAuth?.({ url: authUrl, instructions: "Sign in with Command Code in the browser." });
  ctrl.onProgress?.("Waiting for Command Code authentication...");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Command Code OAuth callback timed out")), LOGIN_TIMEOUT_MS);
      ctrl.signal?.addEventListener("abort", () => { if (timeoutId) clearTimeout(timeoutId); reject(ctrl.signal?.reason); }, { once: true });
    });
    const result = await Promise.race([callback, timeout]);
    return {
      access: result.apiKey,
      refresh: result.apiKey,
      expires: Number.MAX_SAFE_INTEGER,
      accountId: result.userId,
      source: "oauth",
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    server.stop(true);
  }
}

export async function refreshCommandCodeToken(apiKey: string): Promise<OAuthCredentials> {
  if (!apiKey) throw new Error("Command Code API key missing; run ocx login command-code");
  return { access: apiKey, refresh: apiKey, expires: Number.MAX_SAFE_INTEGER, source: "oauth" };
}

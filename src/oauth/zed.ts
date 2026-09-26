import type { OAuthController, OAuthCredentials } from "./types";
import {
  createZedNativeAuthData,
  decryptZedAccessToken,
  parseZedCallbackPayload,
} from "../providers/zed";

const LOGIN_TIMEOUT_MS = 300_000;

type ZedServer = ReturnType<typeof Bun.serve>;

function closingResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", Connection: "close" },
  });
}

function callbackSuccess(): Response {
  return closingResponse(
    "<!doctype html><html><body><h2>Login complete</h2><p>You can close this tab.</p></body></html>",
    200,
  );
}

function callbackFailure(message: string): Response {
  // Do not reflect the callback query, encrypted token, or decryption error details into HTML.
  void message;
  return closingResponse(
    "<!doctype html><html><body><h2>Login failed</h2><p>Return to OpenCodex and retry the login.</p></body></html>",
    400,
  );
}

async function parseManualCallback(input: string, privateKeyVerifier: string): Promise<OAuthCredentials> {
  const payload = parseZedCallbackPayload(input);
  const access = decryptZedAccessToken(payload.encryptedAccessToken, privateKeyVerifier);
  return {
    access,
    refresh: access,
    expires: Number.MAX_SAFE_INTEGER,
    accountId: payload.userId,
    source: "oauth",
  };
}

/** Zed native-app login: local RSA callback, not OAuth2/PKCE and not refreshable. */
export async function loginZed(ctrl: OAuthController): Promise<OAuthCredentials> {
  let resolveCallback: ((credential: OAuthCredentials) => void) | undefined;
  const callback = new Promise<OAuthCredentials>(resolve => {
    resolveCallback = resolve;
  });

  let privateKeyVerifier: string | undefined;
  let server: ZedServer | undefined;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async request => {
        const url = new URL(request.url);
        if (request.method !== "GET" || url.pathname !== "/") return closingResponse("Not found", 404);
        try {
          if (!privateKeyVerifier) throw new Error("Zed login callback is not initialized");
          const credential = await parseManualCallback(url.toString(), privateKeyVerifier);
          resolveCallback?.(credential);
          return callbackSuccess();
        } catch (error) {
          return callbackFailure(error instanceof Error ? error.message : "invalid callback");
        }
      },
    });
    if (!server.port) throw new Error("Zed login callback port was not allocated");
    const authData = createZedNativeAuthData(server.port);
    privateKeyVerifier = authData.privateKeyVerifier;
    ctrl.onAuth?.({
      url: authData.authUrl,
      instructions: "Sign in with your Zed account in the browser, then return here after Zed redirects to the local callback.",
    });
    ctrl.onProgress?.("Waiting for Zed login callback…");

    const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
    const signal = ctrl.signal ? AbortSignal.any([ctrl.signal, timeout]) : timeout;
    const cancelled = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new Error("Zed login cancelled"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("Zed login cancelled")), { once: true });
    });
    const manual = ctrl.onManualCodeInput
      ? (async (): Promise<OAuthCredentials> => {
          while (true) {
            const input = await ctrl.onManualCodeInput?.();
            if (!input) continue;
            try { return await parseManualCallback(input, authData.privateKeyVerifier); } catch { /* keep waiting */ }
          }
        })()
      : undefined;
    return await Promise.race([callback, cancelled, ...(manual ? [manual] : [])]);
  } catch (error) {
    throw error;
  } finally {
    server?.stop(true);
  }
}

/** Zed's long-lived native token has no refresh endpoint. */
export async function refreshZedToken(refresh: string, _signal?: AbortSignal, credential?: OAuthCredentials): Promise<OAuthCredentials> {
  const accountId = credential?.accountId;
  if (!accountId || !refresh) throw new Error("Zed credential is missing its user id");
  return {
    access: refresh,
    refresh,
    expires: Number.MAX_SAFE_INTEGER,
    accountId,
    source: credential?.source ?? "oauth",
  };
}

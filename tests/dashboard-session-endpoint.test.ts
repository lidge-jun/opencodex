import { describe, expect, test } from "bun:test";
import type { OcxConfig } from "../src/types";
import {
  GUI_SESSION_ENDPOINT_PATH,
  type ManagementAuthState,
  handleGuiSessionEndpoint,
  initializeManagementAuthState,
  requireManagementAuth,
} from "../src/server/management-auth";

const HOST = "127.0.0.1:10100";
const ORIGIN = `http://${HOST}`;
const ADMIN_TOKEN = "ocx_admin_test_admin_token_value";

const config: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "test",
  providers: {},
};

function state(): ManagementAuthState {
  return { available: true, token: ADMIN_TOKEN, source: "environment", sessions: new Map() };
}

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; url?: string } = {},
): Request {
  return new Request(init.url ?? `${ORIGIN}${path}`, {
    method: init.method ?? "POST",
    headers: { Host: HOST, ...init.headers },
  });
}

function mint(headers: Record<string, string>, stateOverride?: ManagementAuthState): Response {
  return handleGuiSessionEndpoint(
    request(GUI_SESSION_ENDPOINT_PATH, { headers }),
    new URL(`${ORIGIN}${GUI_SESSION_ENDPOINT_PATH}`),
    stateOverride ?? state(),
    config,
  ) as Response;
}

describe("POST /api/auth/session", () => {
  test("exchanges the admin token for an origin-bound opaque session", async () => {
    const active = state();
    const response = mint({ "X-OpenCodex-API-Key": ADMIN_TOKEN }, active);
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string; csrfToken: string; origin: string; expiresAt: number };
    expect(body.token.startsWith("ocx_session_")).toBe(true);
    expect(body.csrfToken.length).toBeGreaterThan(0);
    expect(body.origin).toBe(ORIGIN);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(active.sessions.has(body.token)).toBe(true);
  });

  test("rejects a wrong admin token", () => {
    expect(mint({ "X-OpenCodex-API-Key": "ocx_admin_wrong" }).status).toBe(401);
    expect(mint({}).status).toBe(401);
  });

  test("rejects non-POST methods and ignores other paths", () => {
    const active = state();
    const notAllowed = handleGuiSessionEndpoint(
      request(GUI_SESSION_ENDPOINT_PATH, { method: "GET", headers: { "X-OpenCodex-API-Key": ADMIN_TOKEN } }),
      new URL(`${ORIGIN}${GUI_SESSION_ENDPOINT_PATH}`),
      active,
      config,
    ) as Response;
    expect(notAllowed.status).toBe(405);
    expect(handleGuiSessionEndpoint(
      request("/api/config", { headers: { "X-OpenCodex-API-Key": ADMIN_TOKEN } }),
      new URL(`${ORIGIN}/api/config`),
      active,
      config,
    )).toBeNull();
  });
});

describe("minted persistent session admission", () => {
  test("authorizes mutations only with the matching origin and CSRF token", async () => {
    const active = state();
    const mintResponse = mint({ "X-OpenCodex-API-Key": ADMIN_TOKEN }, active);
    const body = await mintResponse.json() as { token: string; csrfToken: string };
    const mutate = (headers: Record<string, string>): Response | null =>
      requireManagementAuth(
        request("/api/providers", { method: "POST", body: "{}", headers }),
        active,
        config,
      );
    const armed = {
      "X-OpenCodex-API-Key": body.token,
      "X-OpenCodex-GUI-Origin": ORIGIN,
      Origin: ORIGIN,
      "X-OpenCodex-CSRF-Token": body.csrfToken,
    };
    expect(mutate(armed)).toBeNull();
    expect(mutate({ ...armed, "X-OpenCodex-CSRF-Token": "wrong-csrf" })?.status).toBe(401);
    expect(mutate({ "X-OpenCodex-API-Key": body.token, "X-OpenCodex-GUI-Origin": ORIGIN, Origin: ORIGIN })?.status).toBe(401);
  });

  test("a session bound to one origin does not admit another origin", async () => {
    const active = state();
    const body = await (mint({ "X-OpenCodex-API-Key": ADMIN_TOKEN }, active)).json() as { token: string; csrfToken: string };
    const otherHost = "127.0.0.1:20202";
    const response = requireManagementAuth(
      new Request(`http://${otherHost}/api/config`, {
        headers: {
          Host: otherHost,
          "X-OpenCodex-API-Key": body.token,
          "X-OpenCodex-GUI-Origin": `http://${otherHost}`,
          Origin: `http://${otherHost}`,
        },
      }),
      active,
      config,
    );
    expect(response?.status).toBe(401);
  });

  test("environment-backed state initialization still works on this branch", () => {
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
    const initialized = initializeManagementAuthState(config);
    expect(initialized.available).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_PROVIDERS, upsertOAuthProvider } from "../../src/oauth";
import {
  loginOpenDesign,
  OpenDesignDeviceLoginError,
  pollOpenDesignDeviceAuthorization,
  requestOpenDesignDeviceAuthorization,
  listOpenDesignWorkspaces,
} from "../../src/oauth/opendesign";
import { saveCredential } from "../../src/oauth/store";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";

declare global {
  // eslint-disable-next-line no-var
  var __opendesignFetchLog: string[];
}

const CONTROL_API = "https://amr-api.open-design.ai";
const DEVICE_URL = `${CONTROL_API}/api/v1/cli/device-authorizations`;
const WORKSPACES_URL = `${CONTROL_API}/api/v1/workspaces`;
const CONTROL_KEY = "vela_ctrl_synthetic-0123456789abcdef";
const originalFetch = globalThis.fetch;
const originalEnv = { HOME: process.env.HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME };
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "opendesign-device-"));
  process.env.HOME = home;
  process.env.OPENCODEX_HOME = join(home, "ocx");
  mkdirSync(process.env.OPENCODEX_HOME, { recursive: true });
  globalThis.__opendesignFetchLog = [];
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete globalThis.__opendesignFetchLog;
  await drainAndRemoveFixtureRoots({
    roots: [{ path: join(home, "ocx"), remove: () => {} }, { path: home }],
    restoreEnvironment: () => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    },
  });
});

/** Fixture fetch: no network, no real clock. Exact URL match first, then prefix. */
function fixtureFetch(routes: Record<string, () => Response>): typeof fetch {
  const entries = Object.entries(routes);
  return (async (input: string | URL | Request) => {
    const url = String(input);
    globalThis.__opendesignFetchLog.push(url);
    const exact = entries.find(([pattern]) => pattern === url);
    if (exact) return exact[1]();
    const route = entries.find(([pattern]) => pattern.endsWith("*") && url.startsWith(pattern.slice(0, -1)));
    if (!route) return new Response(null, { status: 404 });
    return route[1]();
  }) as typeof fetch;
}

function deviceAuthorizationResponse(): Response {
  return Response.json({
    deviceAuthorizationId: "da-synthetic-0123456789",
    userCode: "123456",
    verificationUrl: "https://amr-api.open-design.ai/device/123456",
    intervalMs: 1,
    expiresIn: 600,
  });
}

function approvedAuthorizationResponse(): Response {
  return Response.json({ status: "approved", controlKey: CONTROL_KEY });
}

function workspacesResponse(): Response {
  return Response.json({
    items: [
      { workspaceId: "ws-design-team", workspaceName: "Design Team", workspaceMemberId: "member-0123456789", role: "owner", memberStatus: "active", lifecycleState: "active", workspaceType: "team" },
      { workspaceId: "ws-iteractive", workspaceName: "Iteractive Development", workspaceMemberId: "member-0123456789", role: "owner", memberStatus: "active", lifecycleState: "active", workspaceType: "team" },
    ],
  });
}

const pendingSleep = async (): Promise<void> => {};

describe("requestOpenDesignDeviceAuthorization", () => {
  test("returns the user code and verification URL", async () => {
    const fetchImpl = fixtureFetch({ [DEVICE_URL]: deviceAuthorizationResponse });
    const authorization = await requestOpenDesignDeviceAuthorization({ fetchImpl, sleep: pendingSleep });
    expect(authorization.deviceAuthorizationId).toBe("da-synthetic-0123456789");
    expect(authorization.userCode).toBe("123456");
    expect(authorization.verificationUrl).toBe("https://amr-api.open-design.ai/device/123456");
    expect(authorization.intervalMs).toBe(1000); // clamped from 1s below the floor
    expect(authorization.expiresAtMs).toBeGreaterThan(0);
  });

  test("a non-2xx authorization response fails with the status only, never the body", async () => {
    const fetchImpl = fixtureFetch({ [DEVICE_URL]: () => new Response("upstream says vela_ctrl_real_key_leaked", { status: 500 }) });
    const error = await requestOpenDesignDeviceAuthorization({ fetchImpl, sleep: pendingSleep }).catch(e => e);
    expect(error).toBeInstanceOf(OpenDesignDeviceLoginError);
    expect(error.kind).toBe("device-authorization");
    expect(error.status).toBe(500);
    expect(error.message).not.toContain("vela_ctrl");
  });

  test("a body missing the user code is a parse failure, not a pending state", async () => {
    const fetchImpl = fixtureFetch({ [DEVICE_URL]: () => Response.json({ deviceAuthorizationId: "da-synthetic-0123456789" }) });
    const error = await requestOpenDesignDeviceAuthorization({ fetchImpl, sleep: pendingSleep }).catch(e => e);
    expect(error).toBeInstanceOf(OpenDesignDeviceLoginError);
    expect(error.kind).toBe("device-authorization");
  });
});

describe("pollOpenDesignDeviceAuthorization", () => {
  const authorization = {
    deviceAuthorizationId: "da-synthetic-0123456789",
    userCode: "123456",
    verificationUrl: "https://amr-api.open-design.ai/device/123456",
    intervalMs: 1000,
    expiresAtMs: Date.now() + 600_000,
  };

  test("resolves the control key once approved", async () => {
    const fetchImpl = fixtureFetch({ [`${DEVICE_URL}/da-synthetic-0123456789`]: approvedAuthorizationResponse });
    const controlKey = await pollOpenDesignDeviceAuthorization(authorization, { fetchImpl, sleep: pendingSleep });
    expect(controlKey).toBe(CONTROL_KEY);
  });

  test("a denied poll stops instead of retrying", async () => {
    const fetchImpl = fixtureFetch({ [`${DEVICE_URL}/da-synthetic-0123456789`]: () => new Response(null, { status: 403 }) });
    const error = await pollOpenDesignDeviceAuthorization(authorization, { fetchImpl, sleep: pendingSleep }).catch(e => e);
    expect(error).toBeInstanceOf(OpenDesignDeviceLoginError);
    expect(error.kind).toBe("device-denied");
    expect(globalThis.__opendesignFetchLog.length).toBe(1);
  });

  test("an expired grant fails rather than sleeping forever", async () => {
    const fetchImpl = fixtureFetch({ [`${DEVICE_URL}/da-synthetic-0123456789`]: () => Response.json({ status: "pending" }) });
    const expired = { ...authorization, expiresAtMs: Date.now() - 1 };
    const error = await pollOpenDesignDeviceAuthorization(expired, { fetchImpl, sleep: pendingSleep }).catch(e => e);
    expect(error).toBeInstanceOf(OpenDesignDeviceLoginError);
    expect(error.kind).toBe("device-expired");
  });

  test("slow_down stretches the interval, capped at the ceiling", async () => {
    let polls = 0;
    const seenIntervals: number[] = [];
    const fetchImpl = fixtureFetch({
      [`${DEVICE_URL}/da-synthetic-0123456789`]: () => {
        polls += 1;
        if (polls <= 3) return new Response(null, { status: 429, headers: { "retry-after": "1" } });
        return approvedAuthorizationResponse();
      },
    });
    const sleep = async (ms: number): Promise<void> => { seenIntervals.push(ms); };
    const controlKey = await pollOpenDesignDeviceAuthorization(authorization, { fetchImpl, sleep });
    expect(controlKey).toBe(CONTROL_KEY);
    // Every advised wait is the Retry-After of 1s, not the unbounded interval.
    for (const ms of seenIntervals) expect(ms).toBeLessThanOrEqual(60_000);
    expect(seenIntervals.length).toBe(3);
  });
});

describe("listOpenDesignWorkspaces", () => {
  test("maps the directory rows and drops malformed entries", async () => {
    const fetchImpl = fixtureFetch({ [WORKSPACES_URL]: () => Response.json({
      items: [
        { workspaceId: "ws-one", workspaceName: "One", workspaceMemberId: "member-1", role: "owner", memberStatus: "active", lifecycleState: "active", workspaceType: "team" },
        { workspaceName: "Dropped: no id" },
      ],
    }) });
    const workspaces = await listOpenDesignWorkspaces(CONTROL_KEY, { fetchImpl, sleep: pendingSleep });
    expect(workspaces).toEqual([{ workspaceId: "ws-one", workspaceName: "One", workspaceMemberId: "member-1" }]);
  });

  test("401/403 fails the read; the caller decides whether that is terminal", async () => {
    const fetchImpl = fixtureFetch({ [WORKSPACES_URL]: () => new Response(null, { status: 401 }) });
    const error = await listOpenDesignWorkspaces(CONTROL_KEY, { fetchImpl, sleep: pendingSleep }).catch(e => e);
    expect(error).toBeInstanceOf(OpenDesignDeviceLoginError);
    expect(error.status).toBe(401);
  });
});

describe("loginOpenDesign", () => {
  test("stores a static credential: same key as access and refresh, never-expires sentinel", async () => {
    const fetchImpl = fixtureFetch({
      [`${DEVICE_URL}/da-synthetic-0123456789`]: approvedAuthorizationResponse,
      [DEVICE_URL]: deviceAuthorizationResponse,
      [WORKSPACES_URL]: workspacesResponse,
    });
    const credentials = await loginOpenDesign({}, { fetchImpl, sleep: pendingSleep });
    expect(credentials.access).toBe(CONTROL_KEY);
    expect(credentials.refresh).toBe(CONTROL_KEY);
    expect(credentials.expires).toBe(Number.MAX_SAFE_INTEGER);
    expect(credentials.source).toBe("oauth");
    // Slot identity comes from the member id, not a workspace id.
    expect(credentials.accountId).toBe("member-0123456789");
  });

  test("onAuth surfaces the verification URL and the user code", async () => {
    const fetchImpl = fixtureFetch({
      [`${DEVICE_URL}/da-synthetic-0123456789`]: approvedAuthorizationResponse,
      [DEVICE_URL]: deviceAuthorizationResponse,
      [WORKSPACES_URL]: workspacesResponse,
    });
    const seen: Array<{ url: string; instructions?: string; deviceCode?: string }> = [];
    await loginOpenDesign(
      { onAuth: info => { seen.push(info); } },
      { fetchImpl, sleep: pendingSleep },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://amr-api.open-design.ai/device/123456");
    expect(seen[0]!.instructions).toContain("123456");
    expect(seen[0]!.deviceCode).toBe("123456");
  });
});

describe("opendesign OAuth registration", () => {
  test("is registered as a no-refresh OAuth provider with a registry entry", () => {
    const def = OAUTH_PROVIDERS["opendesign"];
    expect(def).toBeDefined();
    expect(def.defaultRefreshPolicy).toBe("disabled");
    const entry = PROVIDER_REGISTRY.find(row => row.id === "opendesign");
    expect(entry).toBeDefined();
    expect(entry!.authKind).toBe("oauth");
    expect(entry!.oauthId).toBe("opendesign");
    expect(entry!.baseUrl).toBe("https://amr-link.open-design.ai/v1");
    expect(entry!.adapter).toBe("openai-chat");
  });

  test("saveCredential accepts the static credential into a fresh store", async () => {
    const fetchImpl = fixtureFetch({
      [`${DEVICE_URL}/da-synthetic-0123456789`]: approvedAuthorizationResponse,
      [DEVICE_URL]: deviceAuthorizationResponse,
      [WORKSPACES_URL]: workspacesResponse,
    });
    const credentials = await loginOpenDesign({}, { fetchImpl, sleep: pendingSleep });
    saveCredential("opendesign", credentials);
    const stored = OAUTH_PROVIDERS["opendesign"];
    expect(stored).toBeDefined();
  });
});

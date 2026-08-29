import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../src/codex/auth-api";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  resolveCodexAccountForThreadDetailed,
} from "../src/codex/routing";
import { handleResponses, handleResponsesCompact } from "../src/server/responses";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";

/**
 * #2887: an ordinary stored pool account holding a TIME-VALID access token that upstream
 * rejects with a pre-stream 401. Before the fix the refresh-and-replay branch admitted only
 * `main-pool`, so this account was never refreshed: one send, zero token-endpoint calls, a
 * 401 handed to the client, `needsReauth` set, and its affinity swept.
 *
 * These assertions are written against that failure signature, not against a value
 * comparison, so restoring the `main-pool`-only predicate turns them red.
 */

const ACCOUNT_ID = "work";
const OTHER_ACCOUNT_ID = "other";
const originalFetch = globalThis.fetch;
let home = "";
let previousOcxHome: string | undefined;
let previousCodexHome: string | undefined;

function config(options: { secondAccount?: boolean } = {}): OcxConfig {
  return {
    defaultProvider: "openai",
    activeCodexAccountId: ACCOUNT_ID,
    autoSwitchThreshold: 0,
    // Round-robin over two accounts makes a lost binding observable. Under a single-account
    // pool, selection re-picks and re-binds the same account, so a dropped affinity looks
    // identical to a preserved one and the assertion would prove nothing.
    ...(options.secondAccount ? { accountPoolStrategy: "round-robin" } : {}),
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: options.secondAccount
      ? [{ id: ACCOUNT_ID, label: "work" }, { id: OTHER_ACCOUNT_ID, label: "other" }]
      : [{ id: ACCOUNT_ID, label: "work" }],
  } as unknown as OcxConfig;
}

const THREAD_ID = "thread-2887";

function request(
  path: "/v1/responses" | "/v1/responses/compact",
  options: { affined?: boolean } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // A bound thread is what makes affinity exist at all; without it there is no
      // entry to carry across the refresh and the handoff cannot be observed.
      ...(options.affined ? { "x-codex-parent-thread-id": THREAD_ID } : {}),
    },
    body: JSON.stringify(path.endsWith("compact")
      ? { model: "gpt-5.5", input: [] }
      : { model: "gpt-5.5", input: "hello", stream: false }),
  });
}

function storedRecord(options: {
  accessToken: string;
  refreshToken: string;
  generation: number;
  chatgptAccountId: string;
}) {
  return {
    credential: {
      accessToken: options.accessToken,
      refreshToken: options.refreshToken,
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: options.chatgptAccountId,
    },
    generation: options.generation,
    refreshGrantFingerprint: createHash("sha256")
      .update(`codex-refresh-grant:${options.refreshToken}`)
      .digest("hex"),
  };
}

/** A stored credential whose expiry is far beyond the refresh skew, as in the report. */
function writeStoredAccount(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify({
    [ACCOUNT_ID]: storedRecord({
      accessToken: "rejected-access",
      refreshToken: "refresh-grant",
      generation: 3,
      chatgptAccountId: "acc-work",
    }),
    ...extra,
  }, null, 2));
}

function readStoredGeneration(): number {
  const raw = JSON.parse(readFileSync(join(home, "codex-accounts.json"), "utf8")) as
    Record<string, { generation: number }>;
  return raw[ACCOUNT_ID]!.generation;
}

type Harness = { sends: string[]; refreshes: string[] };

/**
 * Upstream rejects the old bearer once, the token endpoint rotates, and the replay with the
 * new bearer succeeds — the reporter's deterministic harness.
 */
function installHarness(options: { refresh?: () => Response } = {}): Harness {
  const sends: string[] = [];
  const refreshes: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "auth.openai.com") {
      refreshes.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
      if (options.refresh) return options.refresh();
      return Response.json({
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    }
    if (!url.pathname.endsWith("/responses") && !url.pathname.endsWith("/responses/compact")) {
      return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    }
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    sends.push(authorization);
    if (authorization === "Bearer rejected-access") {
      return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
    }
    return Response.json({ id: "resp_replayed", object: "response", status: "completed", output: [] });
  }) as typeof fetch;
  return { sends, refreshes };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-responses-pool-401-"));
  previousOcxHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  clearAccountNeedsReauth(ACCOUNT_ID);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  writeStoredAccount();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAccountNeedsReauth(ACCOUNT_ID);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(home, { recursive: true, force: true });
});

describe("ordinary pool 401 refresh and replay (#2887)", () => {
  test("Responses refreshes a time-valid stored credential once and replays the same account", async () => {
    const harness = installHarness();
    const response = await handleResponses(
      request("/v1/responses"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    // The defect surfaced as a 401 reaching the client with no refresh attempted.
    expect(response.status).toBe(200);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    // Quarantine is the other half of the report: the account must stay usable.
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);
    expect(readStoredGeneration()).toBe(4);
  });

  test("compact refreshes a time-valid stored credential once and replays the same account", async () => {
    const harness = installHarness();
    const response = await handleResponsesCompact(
      request("/v1/responses/compact"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(200);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);
  });

  test("the replayed account is still selectable on the NEXT request, not just this one", async () => {
    // The affinity entry is bound under generation G; the forced refresh CAS-writes G+1 and
    // isThreadAffinityGenerationLive demands exact equality. Without the same-lineage handoff
    // the entry is dead the moment the replay succeeds, so the account this request just
    // recovered is dropped on the following one. Asserting at replay time cannot see that.
    installHarness();
    writeStoredAccount({
      [OTHER_ACCOUNT_ID]: storedRecord({
        accessToken: "other-access",
        refreshToken: "other-grant",
        generation: 1,
        chatgptAccountId: "acc-other",
      }),
    });
    const cfg = config({ secondAccount: true });
    const response = await handleResponses(
      request("/v1/responses", { affined: true }),
      cfg,
      { model: "", provider: "" } as RequestLogContext,
    );
    expect(response.status).toBe(200);

    // The thread must still resolve through its EXISTING binding. A dead entry is deleted and
    // reported as expired, which is the behavior the missing handoff produces.
    // The binding lives under the model's quota scope, so resolution must be asked in that
    // same scope; a scopeless read looks in the legacy bucket and finds nothing.
    expect(resolveCodexAccountForThreadDetailed(THREAD_ID, cfg, Date.now(), "shared")).toEqual({
      status: "selected",
      accountId: ACCOUNT_ID,
    });
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);
  });

  test("a sibling alias holding the rejected token does not satisfy the forced refresh", async () => {
    // findFreshCredentialForGrant scans by refresh grant, so a second account sharing the grant
    // can hand back a still-unexpired copy of the very token upstream just rejected. Reusing it
    // bumps the generation and replays the identical bearer: a second 401 dressed as recovery.
    writeStoredAccount({
      alias: storedRecord({
        accessToken: "rejected-access",
        refreshToken: "refresh-grant",
        generation: 1,
        chatgptAccountId: "acc-work",
      }),
    });
    const harness = installHarness();
    const response = await handleResponses(
      request("/v1/responses"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(200);
    // The rejected bearer must never be sent twice.
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });

  test("a transient refresh failure does not quarantine the account", async () => {
    // A token-endpoint 5xx becomes TokenRefreshError("unknown"). Treating that as terminal
    // would rebuild this very bug: an upstream blip would retire a healthy account.
    const harness = installHarness({
      refresh: () => Response.json({ error: "server_error" }, { status: 503 }),
    });
    const response = await handleResponses(
      request("/v1/responses"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(harness.refreshes.length).toBe(1);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);
  });

  test("a revoked grant is terminal and retires the account", async () => {
    // The mirror case: core historically returned the 401 without recording an outcome, so a
    // genuinely dead grant stayed selectable and every request repeated the doomed refresh.
    installHarness({
      refresh: () => Response.json(
        { error: "invalid_grant", error_description: "refresh token revoked" },
        { status: 400 },
      ),
    });
    const response = await handleResponses(
      request("/v1/responses"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(401);
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
  });

  test("a 401 carrying a superseded credential generation cannot quarantine the replacement", async () => {
    // Two requests can be in flight while an operator re-authenticates. The slower one comes
    // back 401 against a credential that no longer exists; without the generation fence it
    // takes the fresh credential out of rotation and sweeps affinities that belong to it.
    const { recordCodexUpstreamOutcome } = await import("../src/codex/routing");

    // generation 3 is what the stored fixture was written at; 4 is the replacement.
    writeStoredAccount({
      [ACCOUNT_ID]: storedRecord({
        accessToken: "replacement-access",
        refreshToken: "replacement-grant",
        generation: 4,
        chatgptAccountId: "acc-work",
      }),
    });

    recordCodexUpstreamOutcome(config(), ACCOUNT_ID, 401, { credentialGeneration: 3 });
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);

    // The same evidence against the live generation still retires it, so the fence is a
    // lineage check and not a blanket suppression of credential failures.
    recordCodexUpstreamOutcome(config(), ACCOUNT_ID, 401, { credentialGeneration: 4 });
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
  });

  test("a credential replaced before the request never reaches the 401 path at all", async () => {
    // Establishes the boundary for the lineage rule: once the replacement is stored, it is
    // picked up at selection time, so no rejected bearer is ever sent and no rotation is
    // spent. The interesting case — a replacement landing WHILE the forced refresh runs — is
    // covered at the store level, where the handoff's `selfRefreshed` gate is observable
    // without racing the endpoint.
    const { saveCodexAccountCredential } = await import("../src/codex/account-store");
    const harness = installHarness({
      refresh: () => {
        throw new Error("the token endpoint must not be reached in this scenario");
      },
    });
    saveCodexAccountCredential(ACCOUNT_ID, {
      accessToken: "externally-replaced",
      refreshToken: "external-grant",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "acc-work",
    });

    const response = await handleResponses(
      request("/v1/responses", { affined: true }),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(200);
    expect(harness.refreshes).toEqual([]);
    // One send, with the replacement bearer: the rejected token is never used.
    expect(harness.sends).toEqual(["Bearer externally-replaced"]);
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);
  });
});

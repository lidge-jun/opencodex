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
import { clearCompactHandoffRoutesForTests } from "../src/server/responses/compact";
import {
  REQUEST_PACING_MAX_QUEUE_DEPTH,
  resetProviderRequestPacingForTest,
  setProviderRequestPacingLimitsForTest,
} from "../src/providers/request-pacing";
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
  options: { affined?: boolean; model?: string; headers?: HeadersInit; stream?: boolean } = {},
): Request {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  if (options.affined) headers.set("x-codex-parent-thread-id", THREAD_ID);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(path.endsWith("compact")
      ? { model: options.model ?? "gpt-5.5", input: [] }
      : { model: options.model ?? "gpt-5.5", input: "hello", stream: options.stream ?? false }),
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
function installHarness(options: {
  refresh?: () => Response;
  responseForSend?: (authorization: string, sendNumber: number, url: URL) => Response | undefined;
} = {}): Harness {
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
    const customResponse = options.responseForSend?.(authorization, sends.length, url);
    if (customResponse) return customResponse;
    if (authorization === "Bearer rejected-access") {
      return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
    }
    return Response.json({ id: "resp_replayed", object: "response", status: "completed", output: [] });
  }) as typeof fetch;
  return { sends, refreshes };
}

function recoveryComboConfig(): OcxConfig {
  const cfg = config();
  cfg.providers.backup = {
    adapter: "openai-responses",
    baseUrl: "https://backup.example/v1",
    authMode: "key",
    apiKey: "backup-test-key",
  };
  cfg.combos = {
    recovery: {
      strategy: "failover",
      targets: [
        { provider: "openai", model: "gpt-5.5" },
        { provider: "backup", model: "m2" },
      ],
    },
  };
  return cfg;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-responses-pool-401-"));
  previousOcxHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  clearAccountNeedsReauth(ACCOUNT_ID);
  clearAccountNeedsReauth(OTHER_ACCOUNT_ID);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  writeStoredAccount();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCompactHandoffRoutesForTests();
  clearAccountNeedsReauth(ACCOUNT_ID);
  clearAccountNeedsReauth(OTHER_ACCOUNT_ID);
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

  test("Responses does not compose a stored-account replay 429 with another Pool account", async () => {
    writeStoredAccount({
      [OTHER_ACCOUNT_ID]: storedRecord({
        accessToken: "other-access",
        refreshToken: "other-grant",
        generation: 1,
        chatgptAccountId: "acc-other",
      }),
    });
    const harness = installHarness({
      responseForSend: authorization => {
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
        }
        if (authorization === "Bearer refreshed-access") {
          return Response.json({ error: { message: "pool exhausted" } }, { status: 429 });
        }
        if (authorization === "Bearer other-access") {
          return Response.json({ id: "must-not-run", object: "response", status: "completed", output: [] });
        }
        return undefined;
      },
    });

    const cfg = config({ secondAccount: true });
    // This test needs one eligible alternate but must not advance the process-wide
    // round-robin cursor used by the existing next-request affinity regression.
    cfg.accountPoolStrategy = "fill-first";
    const response = await handleResponses(
      request("/v1/responses"),
      cfg,
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(429);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });

  test("a combo stops after a stored-account replay consumes the recovery budget", async () => {
    const cfg = recoveryComboConfig();
    const harness = installHarness({
      responseForSend: (authorization, _sendNumber, url) => {
        if (url.hostname === "backup.example") {
          return Response.json({ id: "must-not-run", object: "response", status: "completed", output: [] });
        }
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
        }
        if (authorization === "Bearer refreshed-access") {
          return Response.json({ error: { message: "pool exhausted" } }, { status: 429 });
        }
        return undefined;
      },
    });

    const response = await handleResponses(
      request("/v1/responses", { model: "combo/recovery" }),
      cfg,
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(429);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });

  test("a combo stops when the stored-account replay hits a transport error", async () => {
    const cfg = recoveryComboConfig();
    const harness = installHarness({
      responseForSend: (authorization, _sendNumber, url) => {
        if (url.hostname === "backup.example") {
          return Response.json({ id: "must-not-run", object: "response", status: "completed", output: [] });
        }
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
        }
        if (authorization === "Bearer refreshed-access") {
          throw new TypeError("stored replay transport failure");
        }
        return undefined;
      },
    });

    const response = await handleResponses(
      request("/v1/responses", { model: "combo/recovery" }),
      cfg,
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(502);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });

  test("a combo stops on a zero-output failure from the stored-account replay stream", async () => {
    const cfg = recoveryComboConfig();
    const harness = installHarness({
      responseForSend: (authorization, _sendNumber, url) => {
        if (url.hostname === "backup.example") {
          return Response.json({ id: "must-not-run", object: "response", status: "completed", output: [] });
        }
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
        }
        if (authorization === "Bearer refreshed-access") {
          const events = [
            { type: "response.created", response: { id: "replay", status: "in_progress" } },
            {
              type: "response.failed",
              response: {
                id: "replay",
                status: "failed",
                error: { type: "server_error", code: "upstream_server_error", message: "busy" },
              },
            },
          ];
          return new Response(
            events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return undefined;
      },
    });

    const response = await handleResponses(
      request("/v1/responses", { model: "combo/recovery", stream: true }),
      cfg,
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(502);
    const failure = await response.clone().json() as {
      error?: { code?: string; message?: string };
    };
    expect(failure.error?.code).toBe("upstream_server_error");
    expect(failure.error?.message).toContain("busy");
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });

  for (const replayStatus of [429, 402] as const) {
    test(`compact does not compose a stored-account replay ${replayStatus} with another account or remembered model`, async () => {
      const headers = { "x-codex-parent-thread-id": `compact-refresh-budget-${replayStatus}` };
      writeStoredAccount({
        [OTHER_ACCOUNT_ID]: storedRecord({
          accessToken: "other-access",
          refreshToken: "other-grant",
          generation: 1,
          chatgptAccountId: "acc-other",
        }),
      });
      const cfg = config({ secondAccount: true });
      cfg.accountPoolStrategy = "fill-first";
      cfg.providers.seed = {
        adapter: "openai-responses",
        baseUrl: "https://seed.example/v1",
        authMode: "key",
        apiKey: "seed-test-key",
      };
      let seedModelSends = 0;
      let alternateAccountSends = 0;
      const harness = installHarness({
        responseForSend: (authorization, _sendNumber, url) => {
          if (url.hostname === "seed.example") {
            seedModelSends += 1;
            return Response.json({
              id: "seed",
              object: "response",
              status: "completed",
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "seed summary", annotations: [] }],
              }],
            });
          }
          if (authorization === "Bearer rejected-access") {
            return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
          }
          if (authorization === "Bearer refreshed-access") {
            return Response.json({ error: { message: "pool exhausted" } }, { status: replayStatus });
          }
          if (authorization === "Bearer other-access") {
            alternateAccountSends += 1;
            return Response.json({ id: "must-not-run", object: "response", status: "completed", output: [] });
          }
          return undefined;
        },
      });

      const seed = await handleResponsesCompact(
        request("/v1/responses/compact", { model: "seed/seed-model", headers }),
        cfg,
        { model: "", provider: "" } as RequestLogContext,
      );
      expect(seed.status).toBe(200);

      const response = await handleResponsesCompact(
        request("/v1/responses/compact", { headers }),
        cfg,
        { model: "", provider: "" } as RequestLogContext,
      );

      expect(response.status).toBe(replayStatus);
      expect(harness.sends).toEqual([
        "Bearer seed-test-key",
        "Bearer rejected-access",
        "Bearer refreshed-access",
      ]);
      expect(alternateAccountSends).toBe(0);
      expect(seedModelSends).toBe(1);
      expect(harness.refreshes).toEqual(["refresh-grant"]);
    });
  }

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

  // The recovery budget bounds which ACCOUNT may be charged, not whether the request may be
  // rescued at all. Two ladders send to the account that was already paying, so a stored replay
  // must not cut them: the one-shot opaque-blob rebuild, and the allow-listed gated-model 400
  // retry against a still-entitled account. A blanket "no sends after the replay" rule passes
  // every test above and silently converts both into a user-visible 400.
  test("a stored-account replay may still rebuild a rejected opaque blob on the same account", async () => {
    const harness = installHarness({
      responseForSend: (authorization, sendNumber) => {
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
        }
        if (authorization !== "Bearer refreshed-access") return undefined;
        // First refreshed send still carries the stale blob; upstream names the exact code.
        if (sendNumber === 2) {
          return Response.json({
            error: { type: "invalid_request_error", code: "invalid_encrypted_content" },
          }, { status: 400 });
        }
        // The rebuild stripped it, so the same refreshed account now succeeds.
        return Response.json({ id: "resp_rebuilt", object: "response", status: "completed", output: [] });
      },
    });

    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [{ type: "reasoning", encrypted_content: "stale-blob", summary: [] }],
      }),
    });
    const response = await handleResponses(
      req,
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(200);
    // Three sends, all on the SAME account: rejected bearer, refreshed replay, rebuilt resend.
    expect(harness.sends).toEqual([
      "Bearer rejected-access",
      "Bearer refreshed-access",
      "Bearer refreshed-access",
    ]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });

  test("a stored-account replay 402 cannot reach another account even when one is eligible", async () => {
    // The mirror of the case above: a quota failure has no same-account move left, so it is
    // terminal. Asserted with a healthy alternate present, so passing means the budget stopped
    // it rather than there being nowhere to go.
    writeStoredAccount({
      [OTHER_ACCOUNT_ID]: storedRecord({
        accessToken: "other-access",
        refreshToken: "other-grant",
        generation: 1,
        chatgptAccountId: "acc-other",
      }),
    });
    const harness = installHarness({
      responseForSend: authorization => {
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
        }
        if (authorization === "Bearer refreshed-access") {
          return Response.json({ error: { message: "quota exhausted" } }, { status: 402 });
        }
        if (authorization === "Bearer other-access") {
          return Response.json({ id: "must-not-run", object: "response", status: "completed", output: [] });
        }
        return undefined;
      },
    });

    const cfg = config({ secondAccount: true });
    cfg.accountPoolStrategy = "fill-first";
    const response = await handleResponses(
      request("/v1/responses"),
      cfg,
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(402);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });

  test("a gated-model 400 after a stored replay refuses an alternate account", async () => {
    // The narrow seam the budget leaves open, tested on the branch where it could leak. When the
    // refreshed roster no longer grants the model, retryCodexPoolOnAlternateAccount would
    // ordinarily resolve a DIFFERENT account; after a stored replay it must decline instead, or
    // the 400 ladder becomes a way to spend the account budget twice.
    //
    // This covers the REFUSAL only. The same-account rescue that the ladder still allows is a
    // different branch (retryAuthCtx = firstAuthCtx, taken when the refreshed roster still grants
    // the model) and is covered by the opaque-blob case above, which is the ladder this fix was
    // actually reported to have broken.
    writeStoredAccount({
      [OTHER_ACCOUNT_ID]: storedRecord({
        accessToken: "other-access",
        refreshToken: "other-grant",
        generation: 1,
        chatgptAccountId: "acc-other",
      }),
    });
    const gatedModel = "gpt-5.6-sol";
    const harness = installHarness({
      responseForSend: authorization => {
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
        }
        if (authorization === "Bearer refreshed-access") {
          // Exactly the allow-listed unsupported-model detail the 400 ladder recognises.
          return Response.json({
            detail: `The '${gatedModel}' model is not supported when using Codex with a ChatGPT account.`,
          }, { status: 400 });
        }
        if (authorization === "Bearer other-access") {
          return Response.json({ id: "must-not-run", object: "response", status: "completed", output: [] });
        }
        return undefined;
      },
    });

    const cfg = config({ secondAccount: true });
    cfg.accountPoolStrategy = "fill-first";
    const response = await handleResponses(
      request("/v1/responses", { model: gatedModel }),
      cfg,
      { model: "", provider: "" } as RequestLogContext,
      {
        // Both accounts are entitled on the FIRST resolution, so ordinary selection still picks
        // the affined work account and the stored 401 happens. From the retry resolution onward
        // only the other account is entitled, which declines the same-account retry and leaves
        // the alternate-account branch as the one under test.
        resolveCodexModelEntitlements: (() => {
          let call = 0;
          return async () => {
            call += 1;
            const accounts = call === 1 ? [ACCOUNT_ID, OTHER_ACCOUNT_ID] : [OTHER_ACCOUNT_ID];
            return {
              modelsByAccount: new Map(accounts.map(id => [id, new Set([gatedModel])])),
              confirmedAccountIds: new Set(accounts),
              credentialIdentities: new Map(),
            };
          };
        })(),
      },
    );

    // The 400 is surfaced rather than paid for out of the other account.
    expect(response.status).toBe(400);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
  });

  test("a combo stops after a stored replay 4xx that is neither quota nor a gated-model 400", async () => {
    // The contributor's original bound was a single `status >= 400` break in the passthrough loop,
    // which stopped combo fallback for EVERY stored replay 4xx. Removing it to keep same-account
    // rescue alive means the outer layers now rely on the dispatch signal instead. This pins that
    // substitution on the case the break used to cover and the pool-retry site does not: a plain
    // 403 is not a quota status, so it never reaches the quota bound at all.
    const cfg = recoveryComboConfig();
    const harness = installHarness({
      responseForSend: (authorization, _sendNumber, url) => {
        if (url.hostname === "backup.example") {
          return Response.json({ id: "must-not-run", object: "response", status: "completed", output: [] });
        }
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
        }
        if (authorization === "Bearer refreshed-access") {
          return Response.json({ error: { message: "forbidden" } }, { status: 403 });
        }
        return undefined;
      },
    });

    const response = await handleResponses(
      request("/v1/responses", { model: "combo/recovery" }),
      cfg,
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(403);
    // The backup target is never sent to, and the account is charged exactly twice.
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });

  test("a replay that never leaves the pacing queue does not spend the recovery budget", async () => {
    // The dispatch signal is what bounds combo and policy fallback, so it has to describe a send
    // that actually happened. fetchWithHeaderTimeout awaits pacing admission BEFORE calling the
    // executor, so signalling at the call site would spend the budget for a replay that never
    // reached the network — the request would lose its fallback for nothing. This drives the real
    // path: pacing is enabled with a zero-depth queue, so the replay's admission is rejected.
    //
    // A plain request, deliberately NOT a combo: handleComboResponses installs its own
    // onStoredPool401ReplayDispatched for the child, which replaces the caller's and would make
    // the signal unobservable from here.
    const cfg = config();
    // Pacing must be enabled BEFORE routing: `route.provider` is a snapshot taken at routing
    // time, so enabling it mid-flight cannot affect the replay. The queue DEPTH limit, by
    // contrast, is a module-level value read on every admission, which is what lets the first
    // send through and rejects only the replay.
    cfg.providers.openai!.requestPacing = { enabled: true, minIntervalMs: 60_000 };
    const harness = installHarness({
      responseForSend: (authorization, _sendNumber, url) => {
        if (authorization === "Bearer rejected-access") {
          // Close the admission queue only once the original send is through, so the rejection
          // lands on the replay rather than on the request that produces the 401.
          setProviderRequestPacingLimitsForTest({ maxQueueDepth: 0 });
          return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
        }
        return undefined;
      },
    });

    let dispatchSignals = 0;
    let response: Response;
    try {
      response = await handleResponses(
        request("/v1/responses"),
        cfg,
        { model: "", provider: "" } as RequestLogContext,
        { onStoredPool401ReplayDispatched: () => { dispatchSignals += 1; } },
      );
    } finally {
      setProviderRequestPacingLimitsForTest({ maxQueueDepth: REQUEST_PACING_MAX_QUEUE_DEPTH });
      resetProviderRequestPacingForTest();
    }

    // The replay never reached the network, so the budget must not be reported as spent. Asserted
    // on the signal itself rather than on a fallback outcome: a pacing overload is deliberately
    // terminal (it propagates as an error and becomes a 429 above the combo layer), so the
    // downstream fallback is unreachable here for a reason that has nothing to do with this fix.
    expect(dispatchSignals).toBe(0);
    expect(harness.sends.filter(send => send === "Bearer refreshed-access")).toEqual([]);
    // The refresh did happen — this is the post-refresh replay being rejected, not an earlier stop.
    expect(harness.refreshes).toEqual(["refresh-grant"]);
    expect(response.status).toBe(429);
  });

  test("a gated-model 400 after a stored replay still retries the SAME account when entitled", async () => {
    // The branch the budget deliberately leaves open, asserted directly rather than by implication
    // from the opaque-blob case. When the refreshed roster still grants the model,
    // retryCodexPoolOnAlternateAccount sets retryAuthCtx = firstAuthCtx and sends again to the
    // account already paying — no other account is charged, so it is outside the budget.
    const gatedModel = "gpt-5.6-sol";
    const harness = installHarness({
      responseForSend: (authorization, sendNumber) => {
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
        }
        if (authorization !== "Bearer refreshed-access") return undefined;
        if (sendNumber === 2) {
          return Response.json({
            detail: `The '${gatedModel}' model is not supported when using Codex with a ChatGPT account.`,
          }, { status: 400 });
        }
        // Upstream shards can briefly disagree during a gated-model rollout, so the same account
        // succeeds on the retry.
        return Response.json({ id: "resp_same_account", object: "response", status: "completed", output: [] });
      },
    });

    const response = await handleResponses(
      request("/v1/responses", { model: gatedModel }),
      config(),
      { model: "", provider: "" } as RequestLogContext,
      {
        // The single configured account stays entitled across both resolutions.
        resolveCodexModelEntitlements: async () => ({
          modelsByAccount: new Map([[ACCOUNT_ID, new Set([gatedModel])]]),
          confirmedAccountIds: new Set([ACCOUNT_ID]),
          credentialIdentities: new Map(),
        }),
      },
    );

    expect(response.status).toBe(200);
    // Three sends, every one of them on the same account.
    expect(harness.sends).toEqual([
      "Bearer rejected-access",
      "Bearer refreshed-access",
      "Bearer refreshed-access",
    ]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });
});

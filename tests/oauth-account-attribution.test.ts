import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oauthAccountLogLabel, ACCOUNT_LOG_LABEL_RE } from "../src/codex/account-label";
import { getAccountSet, saveCredential } from "../src/oauth/store";
import { clearGenericFailoverHealth } from "../src/oauth/generic-account-failover";
import { stampOAuthAccountLabel } from "../src/providers/label";
import { isCodexUsageAccountLogLabel, isCodexPoolAccountLogLabel } from "../src/usage/log";
import type { PersistedUsageEntry } from "../src/usage/log";
import { summarizeUsage } from "../src/usage/summary";
import type { RequestLogContext } from "../src/server/request-log";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * #2699: usage could not be attributed per account for non-Codex OAuth providers. The label type
 * was Codex-only by construction, so an xai or cursor account had nowhere to be recorded and
 * `ocx usage` reported nothing for it.
 *
 * The trap this file is built around: the obvious stamping point in `core.ts` sits inside
 * `isGenericFailoverProvider`, whose rotation paths additionally require two or more stored
 * accounts. Stamping there leaves the ORDINARY case -- one account, failover off -- with no label
 * at all, while a two-account rotation test still passes. So the single-account scenario is the
 * first test here, not an afterthought.
 */

const originalFetch = globalThis.fetch;

function oauthConfig(): OcxConfig {
  return {
    defaultProvider: "xai",
    providers: {
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
    },
  } as OcxConfig;
}

function request(): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.6", input: "hello", stream: false }),
  });
}

function completed(): Response {
  return Response.json({
    id: "resp_attrib",
    status: "completed",
    output: [],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });
}

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "ocx-oauth-attribution-"));
  const prevOpencodex = process.env.OPENCODEX_HOME;
  const prevCodex = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  try {
    return await run(home);
  } finally {
    globalThis.fetch = originalFetch;
    removeTreeWithRetry(home);
    if (prevOpencodex === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevOpencodex;
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("the label families", () => {
  test("an o-label is a valid persisted label and a p-label still is", () => {
    expect(isCodexUsageAccountLogLabel(oauthAccountLogLabel("acct-1"))).toBe(true);
    expect(isCodexUsageAccountLogLabel("main")).toBe(true);
    expect(isCodexUsageAccountLogLabel("pabc123")).toBe(true);
  });

  test("validation did NOT become permissive", () => {
    // The point of widening was to admit one more shape, not to stop rejecting bad ones.
    for (const bad of ["", "o", "oZZZZZZ", "ozzzzzz", "oabc12", "oabc1234", "xabc123", "acct-1", "user@example.com", null, 42]) {
      expect(isCodexUsageAccountLogLabel(bad)).toBe(false);
    }
  });

  test("the Codex-only predicate stays Codex-only", () => {
    // Kept as a separate predicate so a caller that genuinely means "a pool account" still can.
    expect(isCodexPoolAccountLogLabel("main")).toBe(true);
    expect(isCodexPoolAccountLogLabel("pabc123")).toBe(true);
    expect(isCodexPoolAccountLogLabel(oauthAccountLogLabel("acct-1"))).toBe(false);
  });

  test("the label is a digest, never the account id itself", () => {
    // Privacy criterion 4: the label is written to the usage log and served over the
    // management API, so it must not carry an email or a raw provider account id.
    const label = oauthAccountLogLabel("user@example.com");
    expect(label).not.toContain("user");
    expect(label).not.toContain("@");
    expect(label).toMatch(/^o[a-f0-9]{6}$/);
    expect(ACCOUNT_LOG_LABEL_RE.test(label)).toBe(true);
    // Same account in, same label out -- attribution has to be stable across requests.
    expect(oauthAccountLogLabel("user@example.com")).toBe(label);
    expect(oauthAccountLogLabel("other@example.com")).not.toBe(label);
    expect(oauthAccountLogLabel("same-id", "xai")).not.toBe(oauthAccountLogLabel("same-id", "cursor"));
  });
});

describe("stampOAuthAccountLabel", () => {
  const oauth = { authMode: "oauth" } as const;

  test("stamps a non-Codex OAuth provider", () => {
    const ctx: { accountLogLabel?: string } = {};
    stampOAuthAccountLabel(ctx, "xai", oauth, "acct-1");
    expect(ctx.accountLogLabel).toBe(oauthAccountLogLabel("acct-1", "xai"));
  });

  test("skips the two providers that already have attribution", () => {
    // openai produces its own p-labels; anthropic folds the account into the provider label.
    // Stamping either would overwrite a working mechanism with a second, conflicting one.
    for (const name of ["openai", "anthropic"]) {
      const ctx: { accountLogLabel?: string } = {};
      stampOAuthAccountLabel(ctx, name, oauth, "acct-1");
      expect(ctx.accountLogLabel).toBeUndefined();
    }
  });

  test("skips a suffixed openai provider name too", () => {
    // `openai-pabc123` bases to `openai`, so a suffix must not smuggle it past the check.
    const ctx: { accountLogLabel?: string } = {};
    stampOAuthAccountLabel(ctx, "openai-pabc123", oauth, "acct-1");
    expect(ctx.accountLogLabel).toBeUndefined();
  });

  test("skips a non-OAuth provider and a missing account id", () => {
    const keyed: { accountLogLabel?: string } = {};
    stampOAuthAccountLabel(keyed, "xai", { authMode: "key" }, "acct-1");
    expect(keyed.accountLogLabel).toBeUndefined();

    const noAccount: { accountLogLabel?: string } = {};
    stampOAuthAccountLabel(noAccount, "xai", oauth, undefined);
    expect(noAccount.accountLogLabel).toBeUndefined();
  });
});

describe("Responses per-account attribution for non-Codex OAuth", () => {
  /**
   * THE ACTIVATION SCENARIO. One stored account, generic failover never configured. If this
   * test passes only because failover happened to be on, the fix does not reach the operator it
   * was written for.
   */
  test("a SINGLE-account xai request is attributed, with failover off", async () => {
    await withHome(async () => {
      await saveCredential("xai", {
        access: "xai-access-token",
        refresh: "xai-refresh-token",
        expires: Date.now() + 3_600_000,
        accountId: "xai-acct-1",
        source: "local-cli",
      });
      globalThis.fetch = (async () => completed()) as typeof fetch;

      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(request(), oauthConfig(), logCtx, {});

      expect(response.status).toBe(200);
      expect(logCtx.accountLogLabel).toBeDefined();
      expect(logCtx.accountLogLabel).toMatch(/^o[a-f0-9]{6}$/);
      // And it survives into the attempt, which is what the usage log persists.
      expect(logCtx.activeAttempt?.accountLogLabel).toBe(logCtx.accountLogLabel);
    });
  });

  test("the label is not an email or account id in plain text", async () => {
    await withHome(async () => {
      await saveCredential("xai", {
        access: "xai-access-token",
        refresh: "xai-refresh-token",
        expires: Date.now() + 3_600_000,
        accountId: "person@example.com",
        email: "person@example.com",
        source: "local-cli",
      });
      globalThis.fetch = (async () => completed()) as typeof fetch;

      const logCtx: RequestLogContext = { model: "", provider: "" };
      expect((await handleResponses(request(), oauthConfig(), logCtx, {})).status).toBe(200);
      expect(logCtx.accountLogLabel).not.toContain("person");
      expect(logCtx.accountLogLabel).not.toContain("@");
    });
  });

  /**
   * Criterion 2: a request that rotated accounts must credit the account that SERVED it, not the
   * one that hit the 429. All three rotation sites in `core.ts` funnel through
   * `applyFailoverSnapshot`, so the re-stamp lives there -- one edit covering all three.
   */
  test("a rotated request is attributed to the account that actually served it", async () => {
    await withHome(async () => {
      clearGenericFailoverHealth();
      for (const i of [1, 2]) {
        await saveCredential("xai", {
          access: `xai-access-${i}`,
          refresh: `xai-refresh-${i}`,
          expires: Date.now() + 3_600_000,
          accountId: `xai-acct-${i}`,
          source: "local-cli",
        }, { addAccount: true } as never);
      }
      const ids = getAccountSet("xai")?.accounts.map(a => a.id) ?? [];
      expect(ids).toHaveLength(2);

      const bearers: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bearers.push(new Headers(init?.headers).get("authorization") ?? "");
        if (bearers.length === 1) {
          return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "42" } });
        }
        return completed();
      }) as typeof fetch;

      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(request(), oauthConfig(), logCtx, {});

      // Two accounts present and no explicit knob is the presence-consent case (#2568d), so the
      // rotation happens without configuration.
      expect(response.status).toBe(200);
      expect(bearers).toHaveLength(2);
      expect(bearers[0]).not.toBe(bearers[1]);

      // The label is derived from the STORE account id, not the credential `accountId` field --
      // `saveCredential` generates its own stable id and that is what the resolved snapshot
      // carries. Resolving it through the bearer keeps the assertion about which account served
      // the request rather than about how ids are minted.
      const accounts = getAccountSet("xai")?.accounts ?? [];
      const servedId = accounts.find(a => bearers[1]!.includes(a.credential.access))?.id;
      const failedId = accounts.find(a => bearers[0]!.includes(a.credential.access))?.id;
      expect(servedId).toBeDefined();
      expect(failedId).toBeDefined();
      expect(servedId).not.toBe(failedId);
      expect(logCtx.accountLogLabel).toBe(oauthAccountLogLabel(servedId!, "xai"));
      expect(logCtx.accountLogLabel).not.toBe(oauthAccountLogLabel(failedId!, "xai"));
      clearGenericFailoverHealth();
    });
  });
});

/**
 * Criterion 3: the label has to survive attribution into `ocx usage`, which is a separate gate
 * from persistence. `accountLabelForAttribution` used to accept only Codex labels and fall back to
 * a provider-string guess that returns null for anything non-openai, so a stamped xai row was
 * dropped from the account table even once it was being written.
 */
describe("usage attribution for non-Codex OAuth rows", () => {
  const NOW = Date.UTC(2026, 5, 28, 12, 0, 0);

  function entry(overrides: Partial<PersistedUsageEntry> & { ts: number }): PersistedUsageEntry {
    const { ts, ...rest } = overrides;
    return {
      requestId: rest.requestId ?? `req-${ts}`,
      timestamp: ts,
      provider: rest.provider ?? "xai",
      model: rest.model ?? "grok-4.6",
      status: 200,
      durationMs: 10,
      usageStatus: rest.usageStatus ?? "reported",
      ...(rest.accountLogLabel !== undefined ? { accountLogLabel: rest.accountLogLabel } : {}),
      ...(rest.usage ? { usage: rest.usage } : {}),
      ...(rest.totalTokens !== undefined ? { totalTokens: rest.totalTokens } : {}),
    } as PersistedUsageEntry;
  }

  const labelA = oauthAccountLogLabel("xai-acct-1");
  const labelB = oauthAccountLogLabel("xai-acct-2");

  test("two stamped xai accounts become two separate rows", () => {
    const sum = summarizeUsage([
      entry({ ts: NOW - 1_000, requestId: "a1", accountLogLabel: labelA, usage: { inputTokens: 100, outputTokens: 10 }, totalTokens: 110 }),
      entry({ ts: NOW - 2_000, requestId: "a2", accountLogLabel: labelA, usage: { inputTokens: 50, outputTokens: 5 }, totalTokens: 55 }),
      entry({ ts: NOW - 3_000, requestId: "b1", accountLogLabel: labelB, usage: { inputTokens: 20, outputTokens: 2 }, totalTokens: 22 }),
    ], "30d", NOW);

    expect(sum.accounts.map(r => r.accountLogLabel).sort()).toEqual([labelA, labelB].sort());
    expect(sum.accounts.find(r => r.accountLogLabel === labelA)).toMatchObject({ requests: 2, totalTokens: 165 });
    expect(sum.accounts.find(r => r.accountLogLabel === labelB)).toMatchObject({ requests: 1, totalTokens: 22 });
    // Neither is marked ambiguous: these are explicit labels, not a legacy guess.
    expect(sum.accounts.every(r => r.ambiguous !== true)).toBe(true);
  });

  test("an UNLABELED xai row is still dropped rather than guessed at", () => {
    // The legacy fallback infers an account from the provider string, which is only meaningful
    // for openai. Extending that guess to other providers would merge unrelated accounts.
    const sum = summarizeUsage([entry({ ts: NOW - 1_000, requestId: "bare", usage: { inputTokens: 5, outputTokens: 1 }, totalTokens: 6 })], "30d", NOW);
    expect(sum.accounts).toEqual([]);
  });

  test("openai legacy-ambiguous behavior is untouched", () => {
    const sum = summarizeUsage([
      entry({ ts: NOW - 1_000, requestId: "openai-bare", provider: "openai", model: "gpt-5.5", usageStatus: "unreported" }),
      entry({ ts: NOW - 2_000, requestId: "xai-labeled", accountLogLabel: labelA, usage: { inputTokens: 10, outputTokens: 1 }, totalTokens: 11 }),
    ], "30d", NOW);

    // The two must not merge: an unlabeled openai row is genuinely ambiguous, a stamped xai row
    // is not, and folding one into the other would report a Codex account as having served xai.
    expect(sum.accounts.map(r => r.accountLogLabel).sort()).toEqual([labelA, "legacy-ambiguous"].sort());
    expect(sum.accounts.find(r => r.accountLogLabel === "legacy-ambiguous")?.ambiguous).toBe(true);
    expect(sum.accounts.find(r => r.accountLogLabel === labelA)?.ambiguous).not.toBe(true);
  });
});

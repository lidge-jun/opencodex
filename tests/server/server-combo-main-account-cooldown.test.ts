import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceComboAfterFailure, clearComboSelectionState, pickComboTarget } from "../../src/combos/resolve";
import { clearComboTargetCooldowns, comboTargetCooldownExpiry, isComboTargetInCooldown } from "../../src/combos/failover";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { clearCodexUpstreamHealth, clearCodexUpstreamHealthForAccount, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { handleResponses } from "../../src/server/responses";
import { cooledPoolAccountLabel } from "../../src/server/responses/core-combo";
import type { OcxConfig } from "../../src/types";
import { responsesSuccess } from "../helpers/combo-failover-upstream";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createTempHome, type TempHome } from "../helpers/temp-home";

// #8880: a 429 the Codex pool served from the MAIN account logs as `<provider>-main`, which is not a
// `codexAccounts` entry. It used to read as unattributed, so the combo parked the whole target for
// the upstream Retry-After (up to 24h) and answered 503 with zero attempts after main recovered.

const MODEL = "gpt-6.1-terra";
const target = { provider: "openai", model: MODEL };
const POOL_ACCOUNT = "combo-main-sibling";
let home = "";
let previousHome: string | undefined;

function config(mode: "pool" | "direct" | undefined): OcxConfig {
  return {
    port: 0, defaultProvider: "openai",
    providers: { openai: {
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward",
      ...(mode ? { codexAccountMode: mode } : {}),
    } },
    codexAccounts: [{ id: POOL_ACCOUNT, email: "sibling@example.test", isMain: false }],
    combos: { jev: { strategy: "failover", targets: [target] } },
  } as OcxConfig;
}

function coolMain(cfg: OcxConfig, now: number): void {
  recordCodexUpstreamOutcome(cfg, MAIN_CODEX_ACCOUNT_ID, 429, { now, retryAfter: "86400", modelId: MODEL });
}

/** What the combo layer records for one 429 the main account answered, with the issue's 24h Retry-After. */
function failOnMain(cfg: OcxConfig, now: number): void {
  const failedAccount = cooledPoolAccountLabel(cfg, "openai", MODEL, "openai-main");
  advanceComboAfterFailure(cfg, pickComboTarget(cfg, "jev", { now })!, {
    status: 429, retryAfter: "86400", cooldownScope: "target", now, failedAccount,
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-combo-main-cooldown-"));
  process.env.OPENCODEX_HOME = home;
  clearCodexUpstreamHealth();
  clearComboSelectionState();
  clearComboTargetCooldowns();
});

afterEach(() => {
  clearCodexUpstreamHealth();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

for (const mode of ["pool", undefined] as const) {
  test(`pool mode (${mode ?? "omitted, the canonical default"}): a cooled main account's 429 leaves the target selectable`, () => {
    const now = Date.now();
    const cfg = config(mode);
    coolMain(cfg, now);
    expect(cooledPoolAccountLabel(cfg, "openai", MODEL, "openai-main")).toBe("openai-main");
    failOnMain(cfg, now);
    // The pool holds main's own cooldown and rotates past it; the combo target is not parked.
    expect(isComboTargetInCooldown("jev", target, now + 1)).toBe(false);
  });
}

test("direct mode keeps the target cooldown: nothing local refuses a cooled main there", () => {
  const now = Date.now();
  const cfg = config("direct");
  coolMain(cfg, now);
  expect(cooledPoolAccountLabel(cfg, "openai", MODEL, "openai-main")).toBeUndefined();
  failOnMain(cfg, now);
  expect(comboTargetCooldownExpiry("jev", target, now)).toBe(now + 86_400_000);
});

test("a main account with no live cooldown is not attributed, so the target still cools", () => {
  const now = Date.now();
  const cfg = config("pool");
  expect(cooledPoolAccountLabel(cfg, "openai", MODEL, "openai-main")).toBeUndefined();
  failOnMain(cfg, now);
  expect(isComboTargetInCooldown("jev", target, now + 1)).toBe(true);
});

test("a label for another provider's main account is not attributed", () => {
  const now = Date.now();
  const cfg = config("pool");
  coolMain(cfg, now);
  expect(cooledPoolAccountLabel(cfg, "openai", MODEL, "chatgpt-main")).toBeUndefined();
});

describe("end to end: a combo served by the Codex pool's main account", () => {
  const MAIN_TOKEN_SUBJECT = "acct-main-8880";
  let temp: TempHome;
  let release: (() => void) | undefined;
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  let sent: string[] = [];
  let probes: string[] = [];
  let mainSpent = true;

  function bearerFor(subject: string): string {
    const claims = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: subject } })).toString("base64url");
    return `header.${claims}.signature`;
  }

  beforeEach(() => {
    temp = createTempHome("ocx-combo-main-e2e-");
    release = acquireOwnedSpendHome();
    clearCodexUpstreamHealth();
    clearComboSelectionState();
    clearComboTargetCooldowns();
    sent = [];
    mainSpent = true;
    mkdirSync(temp.codexHome, { recursive: true });
    writeFileSync(join(temp.codexHome, "auth.json"), JSON.stringify({ tokens: {
      access_token: bearerFor(MAIN_TOKEN_SUBJECT), refresh_token: "fixture-main-refresh", account_id: MAIN_TOKEN_SUBJECT,
    } }));
    reconcileMainCodexAccountRuntimeState();
    saveCodexAccountCredential(POOL_ACCOUNT, {
      accessToken: "synthetic-pool-access", refreshToken: "synthetic-pool-refresh",
      expiresAt: Date.now() + 86_400_000, chatgptAccountId: "acct-pool-8880",
    });
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const who = auth.includes(bearerFor(MAIN_TOKEN_SUBJECT).split(".")[1]!) ? "main" : "pool";
      // Model turns only; quota and account-info reads are not sends this test counts.
      if (!new URL(url).pathname.endsWith("/responses")) { probes.push(`${who} ${new URL(url).pathname}`); return Response.json({}); }
      sent.push(who);
      if (who === "main" && mainSpent) {
        return Response.json({ error: { type: "usage_limit_reached", code: "usage_limit_reached",
          message: "The usage limit has been reached", resets_in_seconds: 86_400 } }, { status: 429, headers: { "retry-after": "86400" } });
      }
      return Response.json(responsesSuccess("served", MODEL));
    }) as unknown as typeof fetch);
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    clearCodexUpstreamHealth();
    clearComboSelectionState();
    clearComboTargetCooldowns();
    release?.();
    release = undefined;
    resetMainCodexAccountIdentityTrackingForTests();
    await temp.removeAfterBackgroundWork();
  });

  async function post(cfg: OcxConfig, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "combo/jev", input: "hello", stream: false }),
    }), cfg, { model: "", provider: "" });
    return { status: response.status, body: await response.text() };
  }

  test("pool mode: main's 429 does not park the target, and a recovered main serves the next request", async () => {
    const cfg = config(undefined);
    // The issue's sequence: the sibling is already spent, so the pool serves from main.
    recordCodexUpstreamOutcome(cfg, POOL_ACCOUNT, 429, { now: Date.now(), retryAfter: "86400", modelId: MODEL });
    const first = await post(cfg);
    expect(first.status, first.body).toBe(429);
    expect(sent).toEqual(["main"]);
    expect(isComboTargetInCooldown("jev", target)).toBe(false);

    // Main recovers (its window resets, or the operator clears its cooldown).
    mainSpent = false;
    clearCodexUpstreamHealthForAccount(MAIN_CODEX_ACCOUNT_ID);
    sent = [];
    const second = await post(cfg);
    expect(second.status, second.body).toBe(200);
    expect(second.body).toContain("served");
    expect(sent).toEqual(["main"]);
  });

  test("direct mode (caller-owned main): the 429 still parks the target, so the next request sends nothing", async () => {
    const cfg = config("direct");
    // Direct mode serves the caller's own credential (kind "main", no pool account label).
    const caller = { authorization: `Bearer ${bearerFor(MAIN_TOKEN_SUBJECT)}` };
    const first = await post(cfg, caller);
    expect(first.status, first.body).toBe(429);
    expect(sent).toEqual(["main"]);
    expect(isComboTargetInCooldown("jev", target)).toBe(true);
    sent = [];
    const second = await post(cfg, caller);
    expect(second.status, second.body).not.toBe(200);
    expect(sent).toEqual([]);
  });
});

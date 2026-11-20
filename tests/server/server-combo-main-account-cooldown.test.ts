import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceComboAfterFailure, clearComboSelectionState, pickComboTarget } from "../../src/combos/resolve";
import { clearComboTargetCooldowns, comboTargetCooldownExpiry, isComboTargetInCooldown } from "../../src/combos/failover";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { clearCodexUpstreamHealth, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { cooledPoolAccountLabel } from "../../src/server/responses/core-combo";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

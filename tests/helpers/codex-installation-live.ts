import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "./fake-chatgpt-jwt";
import { createTempHome, type TempHome } from "./temp-home";

export const install = "x-codex-installation-id";
export const turn = "x-codex-turn-metadata";
export const callerId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
export const clientKey = "ocx_data_installation_live_fixture";
export const callerToken = fakeChatGptJwt({ chatgpt_account_id: "caller-account" });
export type AuthKind = "main" | "pool" | "main-pool";
export function liveConfig(kind: AuthKind = "pool", account = "live-a"): OcxConfig {
  const selected = kind === "main-pool" ? MAIN_CODEX_ACCOUNT_ID : account;
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "openai", openaiProviderTierVersion: 2,
    codexMainAccountHardLock: false, autoSwitchThreshold: 0,
    providers: { openai: { adapter: "openai-responses", authMode: "forward",
      baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: kind === "main" ? "direct" : "pool" } },
    codexAccounts: ["live-a", "live-b"].map(id => ({ id, email: `${id}@example.test`, plan: "team", isMain: false })),
    activeCodexAccountId: selected, activeCodexAccountPinned: selected, accountPoolStrategy: "fill-first",
    apiKeys: [{ id: "live-client", name: "fixture", key: clientKey, createdAt: "2026-01-01T00:00:00Z" }],
  } as OcxConfig;
}
export function metadata(present = true) {
  return { keep: "unchanged", ...(present ? { [install]: callerId,
    [turn]: '{ "installation_id": "' + callerId + '", "keep": "turn" }' } : {}) };
}
export function turnMetadataBytes(bytes: number) {
  const raw = JSON.stringify({ installation_id: callerId, pad: "" });
  return JSON.stringify({ installation_id: callerId, pad: "a".repeat(bytes - Buffer.byteLength(raw)) });
}
export function installationLiveFixture() {
  let home: TempHome;
  let savedSecret: Buffer;
  const admission = process.env.OPENCODEX_API_AUTH_TOKEN;
  beforeAll(async () => {
    home = createTempHome("ocx-installation-live-");
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    mkdirSync(home.codexHome, { recursive: true });
    writeFileSync(home.path(".codex", "auth.json"), JSON.stringify({ tokens: {
      access_token: fakeChatGptJwt({ exp: 4_000_000_000, chatgpt_account_id: "stored-main-account" }), account_id: "stored-main-account",
    } }));
    saveConfig(liveConfig());
    for (const id of ["live-a", "live-b"]) saveCodexAccountCredential(id, {
      accessToken: `${id}-fixture-token`, refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: `canonical-${id}`,
    });
    savedSecret = Buffer.alloc(32, 0x61);
    writeFileSync(home.path("codex-installation-secret"), savedSecret);
    await flushConfigDirHardeningAndReaps(home.root);
  });
  beforeEach(() => {
    clearCodexUpstreamHealth(); clearThreadAccountMap(); clearAccountQuota(); resetLifecycleDrainStateForTests();
    for (const id of ["live-a", "live-b", MAIN_CODEX_ACCOUNT_ID]) {
      clearAccountNeedsReauth(id);
      setAccountQuotaFromParsed(id, { weeklyPercent: 10, weeklyResetAt: Date.now() / 1000 + 3_600 });
    }
  });
  afterEach(() => { writeFileSync(home.path("codex-installation-secret"), savedSecret); });
  afterAll(async () => {
    if (admission === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
    else process.env.OPENCODEX_API_AUTH_TOKEN = admission;
    await flushConfigDirHardeningAndReaps(home.root); home.remove();
  });
  return {
    corrupt: () => writeFileSync(home.path("codex-installation-secret"), Buffer.from([0])),
    expected(account = "live-a") {
      const bytes = createHmac("sha256", readFileSync(home.path("codex-installation-secret")))
        .update("opencodex-codex-installation-id-v1\0").update(`canonical-${account}`).digest().subarray(0, 16);
      bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
      const hex = bytes.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };
}

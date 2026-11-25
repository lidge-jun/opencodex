/**
 * Native compact carries a Codex pool account's credential, so it must leave by that account's
 * route (catch-up G-012), read at the physical send: a compact moved from one pool account to
 * another by a 429 takes the second account's route.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { bindCodexAccountEgressConfig, resetCodexAccountEgressConfigForTests } from "../../src/codex/account-egress-runtime";
import { clearPoolRecoveryState } from "../../src/routing/probe-lease";
import { handleResponsesCompact } from "../../src/server/responses";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import type { OcxConfig } from "../../src/types";

const PROXY_WORK = "http://127.0.0.1:9/";
const PROXY_OTHER = "http://127.0.0.1:11/";
const realFetch = globalThis.fetch;
const homeKeys = ["OPENCODEX_HOME", "CODEX_HOME"] as const;
const PROXY_ENV = ["NO_PROXY", "no_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
const savedEnv = new Map<string, string | undefined>();
let home: string;
let previous: Array<string | undefined>;
let release: () => void;
function clear() {
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); clearPoolRecoveryState();
  for (const id of ["work", "other"]) clearAccountNeedsReauth(id);
  resetCodexAccountEgressConfigForTests();
}
beforeEach(() => {
  for (const key of PROXY_ENV) { savedEnv.set(key, process.env[key]); delete process.env[key]; }
  home = mkdtempSync(join(tmpdir(), "ocx-compact-account-egress-"));
  previous = homeKeys.map(name => process.env[name]);
  for (const name of homeKeys) process.env[name] = home;
  release = acquireOwnedSpendHome(); clear();
  for (const id of ["work", "other"]) setAccountQuotaFromParsed(id, { weeklyPercent: 10 });
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries(["work", "other"].map(id => [id, {
    credential: { accessToken: `${id}-access`, refreshToken: `${id}-grant`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: `acc-${id}` },
    generation: 1, refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${id}-grant`).digest("hex"),
  }]))));
});
afterEach(async () => {
  globalThis.fetch = realFetch; release(); clear();
  for (const key of PROXY_ENV) { const value = savedEnv.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await drainAndRemoveFixtureRoots({ roots: [{ path: home }], restoreEnvironment: () => {
    homeKeys.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
  } });
});
const config = (): OcxConfig => ({ port: 0, defaultProvider: "openai", activeCodexAccountId: "work", autoSwitchThreshold: 0,
  accountPoolStrategy: "round-robin", codexAccounts: [
    { id: "work", label: "work", egress: { proxy: PROXY_WORK } },
    { id: "other", label: "other", egress: { proxy: PROXY_OTHER } },
  ],
  providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", upstreamWebsocket: false } },
} as OcxConfig);

test("a compact moved from one pool account to another by a 429 leaves by each account's own route", async () => {
  const cfg = config();
  bindCodexAccountEgressConfig(cfg);
  const sends: Array<{ account: string | null; proxy: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/responses/compact")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    const headers = new Headers(init?.headers);
    sends.push({ account: headers.get("chatgpt-account-id"), proxy: (init as { proxy?: unknown } | undefined)?.proxy });
    return headers.get("authorization") === "Bearer work-access"
      ? Response.json({ error: { message: "You have hit your usage limit." } }, { status: 429, headers: { "retry-after": "600" } })
      : Response.json({ id: "resp_done", object: "response.compaction", status: "completed", output: [] });
  }) as typeof fetch;
  const req = new Request("http://localhost/v1/responses/compact", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: [], stream: false }) });
  const response = await handleResponsesCompact(req, cfg, { model: "", provider: "" });
  await response.text();
  expect(response.status).toBe(200);
  expect(sends).toEqual([{ account: "acc-work", proxy: PROXY_WORK }, { account: "acc-other", proxy: PROXY_OTHER }]);
});

import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCodexAccountCredential } from "../../src/codex/account-store";
import * as authCollision from "../../src/codex/auth-collision";
import { acquireNativeMainProfileDrain } from "../../src/server/lifecycle";
import { saveConfig } from "../../src/config";
import type { OcxConfig } from "../../src/types";

interface CollisionOAuthOptions {
  config: OcxConfig;
  requestBody: { id: string };
  oauthAccountId: string;
  email?: string;
  accessToken: string;
  onWarmup: () => void;
  usageResponse: () => Response;
}

/** Uses the parent API suite's isolated homes and real login/persistence path. */
export function registerMainCollisionCases(
  makeConfig: () => OcxConfig,
  completeOAuth: (options: CollisionOAuthOptions) => Promise<{
    state: { status: string; error?: string };
  }>,
): void {
  test("fenced OAuth collision check retries without reading native main", async () => {
    const config = makeConfig();
    saveConfig(config);
    const drain = acquireNativeMainProfileDrain("collision-regression");
    const read = spyOn(authCollision, "readCodexTokensResult");
    let warmups = 0;
    try {
      const result = await completeOAuth({ config, requestBody: { id: "collision-candidate" },
        oauthAccountId: "candidate-account", email: "candidate@example.test", accessToken: "fake-access",
        onWarmup: () => { warmups += 1; }, usageResponse: () => new Response(null, { status: 503 }) });
      expect(result.state.status).toBe("error");
      expect(result.state.error).toContain("retry login");
      expect(read).not.toHaveBeenCalled();
      expect(warmups).toBe(0);
      expect(getCodexAccountCredential("collision-candidate")).toBeNull();
    } finally { read.mockRestore(); drain.release(); }
  });
  const cases = [
    { name: "workspace duplicate with failed WHAM", plan: "team", email: "main@example.test", usage: "error", blocked: true },
    { name: "workspace duplicate with timed-out WHAM", plan: "business", email: "main@example.test", usage: "timeout", blocked: true },
    { name: "workspace duplicate with missing WHAM plan", plan: "team", email: "main@example.test", usage: "empty", blocked: true },
    { name: "personal duplicate with missing email", plan: "plus", email: undefined, usage: "error", blocked: true },
    { name: "personal duplicate with blank email", plan: "plus", email: "  ", usage: "empty", blocked: true },
    { name: "different workspace member", plan: "team", email: "other@example.test", usage: "error", blocked: false },
    { name: "different workspace", plan: "team", email: "main@example.test", usage: "error", blocked: false, accountId: "other-workspace" },
    { name: "different plan bucket", plan: "plus", email: "main@example.test", usage: "error", blocked: false, mainPlan: "team" },
    { name: "WHAM plan overrides JWT", plan: "plus", email: "main@example.test", usage: "team", blocked: true, mainPlan: "team" },
  ];
  test.each(cases)("OAuth main collision: $name", async scenario => {
    const token = (plan: string) => `header.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_plan_type: plan },
      "https://api.openai.com/profile": { email: "main@example.test" },
    })).toString("base64url")}.sig`;
    writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({
      tokens: { access_token: token(scenario.mainPlan ?? scenario.plan), account_id: "main-account" },
    }));
    const config = makeConfig();
    saveConfig(config);
    let warmups = 0;
    const result = await completeOAuth({
      config,
      requestBody: { id: "collision-candidate" },
      oauthAccountId: scenario.accountId ?? "main-account",
      email: scenario.email,
      accessToken: token(scenario.plan),
      onWarmup: () => { warmups += 1; },
      usageResponse: () => {
        if (scenario.usage === "timeout") throw new DOMException("Timed out", "TimeoutError");
        if (scenario.usage === "error") return new Response(null, { status: 503 });
        return Response.json(scenario.usage === "team" ? { plan_type: "team" } : {});
      },
    });
    expect(result.state.status).toBe(scenario.blocked ? "error" : "done");
    if (scenario.blocked) {
      expect(result.state.error).toBe("Account is already configured as the native Codex main account.");
      expect(config.codexAccounts).toEqual([]);
      expect(getCodexAccountCredential("collision-candidate")).toBeNull();
      expect(warmups).toBe(0);
    } else {
      expect(config.codexAccounts).toHaveLength(1);
      expect(getCodexAccountCredential("collision-candidate")).not.toBeNull();
      expect(warmups).toBeGreaterThan(0);
    }
  });
}

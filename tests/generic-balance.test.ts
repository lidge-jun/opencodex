import { test, expect, mock } from "bun:test";
const root = "/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src";
const roster = { activeAccountId: "a", accounts: ["a","b","c"].map(id => ({id})) };
let readings: Record<string, [number, number]> = {};
mock.module(root + "/oauth/store", () => ({ getAccountSet: () => roster }));
mock.module(root + "/oauth/index", () => ({ getValidAccessSnapshotForAccount: async () => ({}) }));
mock.module(root + "/providers/quota", () => ({
  hasPassiveAccountQuota: () => false,
  getCachedProviderAccountQuota: (_: string,id: string) => readings[id] ? {
    updatedAt: Date.now(), customWindows: [{ label: "Gem", percent: readings[id][0] },{ label: "Cla", percent: readings[id][1] }],
  } : null,
}));
const r = await import(root + "/oauth/generic-account-failover");
const config = { providers: { "google-antigravity": { authMode: "oauth", oauthAccountFailover: { enabled: true, strategy: "quota" } } } };
test("healthy existing account no longer pins all requests; unknown quotas rotate", () => {
  r.clearGenericFailoverHealth(); readings = {}; roster.activeAccountId = "a";
  expect(Array.from({length:6},()=>r.preferredInitialAccount(config,"google-antigravity",Date.now(),"gemini-3.8-flash") ?? roster.activeAccountId)).toEqual(["a","b","c","a","b","c"]);
});
test("Gemini and Claude quota selection remains family-specific", () => {
  r.clearGenericFailoverHealth(); readings = { a:[80,5],b:[5,80],c:[50,50] };
  expect(r.preferredInitialAccount(config,"google-antigravity",Date.now(),"gemini-3.8-flash")).toBe("b");
  expect(r.preferredInitialAccount(config,"google-antigravity",Date.now(),"claude-sonnet-4-6") ?? "a").toBe("a");
});
test("429 cools failed account and selects a different eligible account", () => {
  r.clearGenericFailoverHealth(); readings = {};
  expect(r.rotateGenericOAuthAccountOn429(config,"google-antigravity","a","60",Date.now(),"gemini-3.8-flash")).toBe("b");
  expect(r.eligibleFailoverAccounts("google-antigravity")).not.toContain("a");
  expect(r.genericOAuthFailoverLimit("google-antigravity")).toBe(8);
  expect(r.genericOAuthFailoverLimit("xai")).toBe(3);
});
test("explicit preference disable and reauth exclusion are respected", () => {
  r.clearGenericFailoverHealth(); readings = {};
  expect(r.preferredInitialAccount({providers:{"google-antigravity":{authMode:"oauth",oauthAccountFailover:{enabled:false,strategy:"quota"}}}},"google-antigravity")).toBeNull();
  roster.accounts[1].needsReauth = true;
  const picked = Array.from({length:4},()=>r.preferredInitialAccount(config,"google-antigravity",Date.now(),"gemini-3.8-flash") ?? "a");
  expect(picked).not.toContain("b");
  delete roster.accounts[1].needsReauth;
});

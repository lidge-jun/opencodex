import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HubConfig } from "../hub/src/config";
import { HubService } from "../hub/src/server";

const directories: string[] = [];

function service(): HubService {
  const directory = mkdtempSync(join(tmpdir(), "hubapi-portal-test-"));
  directories.push(directory);
  const config: HubConfig = {
    databasePath: join(directory, "hub.sqlite"),
    digestSecret: "portal-test-digest-secret-with-at-least-32-bytes",
    publicOrigin: "http://127.0.0.1:10400",
    hostname: "127.0.0.1",
    port: 0,
    allowRegistration: true,
    sessionTtlSeconds: 3600,
    development: true,
    trustLoopbackProxy: false,
    opencodexOrigin: "http://127.0.0.1:10100",
    internalAdmissionToken: "portal-test-internal-token-with-at-least-32-bytes",
    requestCostUnits: 125,
    pricingVersion: "portal-test-v1",
    upstreamTimeoutMs: 5_000,
  };
  return new HubService(config);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("hub hosted portal", () => {
  test("serves only fixed local assets with a restrictive browser policy", async () => {
    const hub = service();
    const html = await hub.fetch(new Request("http://127.0.0.1:10400/hub/"));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(html.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(html.headers.get("x-frame-options")).toBe("DENY");
    expect(await html.text()).not.toMatch(/https?:\/\/[^"']+/);
    expect((await hub.fetch(new Request("http://127.0.0.1:10400/hub/app.js"))).status).toBe(200);
    expect((await hub.fetch(new Request("http://127.0.0.1:10400/hub/styles.css"))).status).toBe(200);
    expect((await hub.fetch(new Request("http://127.0.0.1:10400/hub/not-an-asset.js"))).status).toBe(404);
    hub.stop();
  });

  test("reports the configured pricing contract instead of a UI sample value", async () => {
    const hub = service();
    const response = await hub.fetch(new Request("http://127.0.0.1:10400/hub/health"));
    expect(await response.json()).toMatchObject({
      status: "ok",
      mode: "hosted",
      version: 1,
      pricingVersion: "portal-test-v1",
      requestCostUnits: 125,
      billingPolicy: "fixed_on_upstream_acceptance",
      registrationEnabled: true,
      proxy: {
        status: "edge_ready",
        upstreamStatus: "not_probed",
        endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/messages", "/v1/models"],
      },
    });
    hub.stop();
  });

  test("covers every existing GUI locale and never stores authentication in browser storage", () => {
    const source = readFileSync("hub/portal/app.js", "utf8");
    const styles = readFileSync("hub/portal/styles.css", "utf8");
    for (const marker of ["  en: {", '  "zh-CN": {', '  "zh-TW": {', "  de: {", "  fr: {", "  ja: {", "  ko: {", "  ru: {", "  tr: {"]) expect(source).toContain(marker);
    expect(source).not.toMatch(/localStorage|sessionStorage/);
    expect(source).not.toMatch(/Authorization:\s*[`"']Bearer\s*\$?\{?csrf/i);
    expect(source).toContain('["dashboard", t("dashboard")], ["proxy", t("proxy")]');
    expect(source).toContain('activeView === "admin" ? "adminDashboard"');
    expect(source).toContain('api("/hub/admin/user-status"');
    expect(source).toContain('api("/hub/account/requests?limit=6")');
    expect(source).toContain('api("/hub/admin/metrics")');
    expect(source).toContain('api("/hub/admin/requests?limit=20")');
    expect(source).toContain('api("/hub/account/models")');
    expect(source).toContain('api("/hub/admin/recharge-code-inventory"');
    expect(source).toContain('api("/hub/admin/api-key"');
    expect(source).toContain('api("/hub/admin/user-details"');
    expect(source).toContain('api("/hub/account/key"');
    expect(source).not.toMatch(/\/hub\/account\/keys\/\$\{/);
    expect(source).toContain('name="expiresAt" type="datetime-local"');
    expect(source).toContain('String(row.supportReference || "N/A")');
    expect(source).not.toContain('String(index + 1).padStart(3, "0")');
    expect(source.match(/batches: "/g)).toHaveLength(9);
    expect(source.match(/codeInventory: "/g)).toHaveLength(9);
    expect(source.match(/noRecords: "/g)).toHaveLength(9);
    expect(source.match(/noUserKeys: "/g)).toHaveLength(9);
    expect(source).toContain('<h2>${escapeHtml(t("users"))}</h2>');
    expect(source).toContain('<label for="adjust-units">${escapeHtml(t("creditUnit"))}</label>');
    expect(source).not.toContain('<label for="adjust-units">${escapeHtml(t("units"))}</label>');
    expect(source).toContain('api("/hub/auth/sessions")');
    expect(source).toContain('api("/hub/auth/status")');
    expect(source).toContain('api("/hub/auth/password"');
    expect(source).toContain('api("/hub/auth/logout-all"');
    expect(source).toContain('api("/hub/account/requests?limit=6")');
    expect(source).toContain('api("/hub/admin/metrics")');
    expect(source).toContain('api("/hub/admin/requests?limit=20")');
    expect(source).toContain('t("statusSettled")');
    expect(source).toContain('entry.terminalReason');
    expect(source).toContain('["security", t("security")]');
    expect(source.match(/authMode = "login"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('data-copy-recipe');
    expect(source).toContain('model_provider = "hubapi"');
    expect(source).toContain('model = "YOUR_CONFIGURED_ALIAS"');
    expect(source).not.toContain('coding · vision · fast · private');
    expect(source).toContain('never classifies prompt text');
    expect(source).toContain('ANTHROPIC_BASE_URL');
    expect(source).toContain('OPENAI_BASE_URL');
    expect(source).not.toMatch(/user\.email|row\.email/);
    expect(source).not.toContain("OpenCodex");
    expect(styles).toContain("--pixel-shadow");
    expect(styles).toContain(".pixel-route");
    expect(styles).toContain(".recipe-grid");
    expect(styles).toContain("prefers-reduced-motion: reduce");
    expect(styles).toContain("prefers-color-scheme: light");
  });
});

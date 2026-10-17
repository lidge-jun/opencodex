import { afterEach, beforeEach, expect, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { fixture } from "../helpers/provider-completion-fixture";

const previousAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
const previousData = process.env.OPENCODEX_API_AUTH_TOKEN;
let home: TempHome;
beforeEach(() => {
  home = createTempHome("ocx-completion-ingress-");
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "completion-admin-fixture";
  process.env.OPENCODEX_API_AUTH_TOKEN = "completion-data-fixture";
});
afterEach(() => {
  if (previousAdmin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdmin;
  if (previousData === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = previousData;
  home.remove();
});

test("real management ingress rejects anonymous/data credentials, foreign Origin and GUI session without CSRF before any upstream send", async () => {
  // Exercise startServer's real auth/origin/CSRF gates rather than a fabricated route principal.
  const f = fixture();
  saveConfig(f.config);
  const server = startServer(0);
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("provider.example")) { sends++; throw new Error("must not send"); }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    const target = new URL("/api/providers/test-completion?name=fixture", server.url);
    const post = (headers: Record<string, string>) => fetch(target, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "test-model", confirm: true }) });
    expect((await post({})).status).toBe(401);
    expect((await post({ "x-opencodex-api-key": "completion-data-fixture" })).status).toBe(401);
    expect((await post({ "x-opencodex-api-key": "completion-admin-fixture", Origin: "https://foreign.example" })).status).toBe(403);
    const html = await (await fetch(new URL("/opencodex-session", server.url))).text();
    const token = html.match(/name="opencodex-session-token" content="([^"]+)"/)?.[1];
    const csrf = html.match(/name="opencodex-session-csrf" content="([^"]+)"/)?.[1];
    expect(token).toBeDefined(); expect(csrf).toBeDefined();
    const missingCsrf = await post({ "x-opencodex-api-key": token!, "x-opencodex-gui-origin": server.url.origin, Origin: server.url.origin });
    expect([401, 403]).toContain(missingCsrf.status);
    expect(sends).toBe(0);
    expect(f.calls).toHaveLength(0);
  } finally { globalThis.fetch = originalFetch; await server.stop(true); }
});

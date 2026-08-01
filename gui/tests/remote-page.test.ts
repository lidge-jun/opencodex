import { expect, test } from "bun:test";

const LOCALES = ["en", "de", "ja", "ko", "ru", "zh"] as const;

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

test("Remote is a local GUI route directly after the established Codex Auth entry", async () => {
  const routing = await read("../src/app-routing.ts");
  const app = await read("../src/App.tsx");
  expect(routing).toContain('| "remote"');
  expect(routing).toContain('"remote",');
  expect(app).toContain('{page === "remote" && <Remote apiBase={API_BASE} />}');
  const nav = app.slice(app.indexOf("const NAV"), app.indexOf("];", app.indexOf("const NAV")));
  expect(nav.indexOf('id: "codex-auth"')).toBeLessThan(nav.indexOf('id: "remote"'));
});

test("Remote page owns device linking, password setup, hostname activation, and connector pairing without handling GitHub credentials", async () => {
  const page = await read("../src/pages/Remote.tsx");
  expect(page).toContain("/api/remote/link");
  expect(page).toContain("/api/remote/status");
  expect(page).toContain("/api/remote/password");
  expect(page).toContain("/api/remote/activate");
  expect(page).toContain("/api/remote/pairing-code");
  expect(page).toContain("/api/remote/device");
  expect(page).not.toContain("access_token");
  expect(page).not.toContain("refresh_token");
  expect(page).not.toContain("clientSecret");
});

test("every locale carries the Remote onboarding copy", async () => {
  const keys = [
    "nav.remote", "remote.title", "remote.subtitle", "remote.stepAccount", "remote.stepPassword",
    "remote.stepTunnel", "remote.signedOutTitle", "remote.signIn", "remote.pendingTitle",
    "remote.codeLabel", "remote.passwordTitle", "remote.passwordLabel", "remote.savePassword",
    "remote.domainTitle", "remote.activate", "remote.provisioningTitle", "remote.connectorTitle",
    "remote.prepareConnector", "remote.readyTitle", "remote.openRemote", "remote.disconnect",
  ];
  const missing: string[] = [];
  for (const locale of LOCALES) {
    const dictionary = await read(`../src/i18n/${locale}.ts`);
    for (const key of keys) if (!dictionary.includes(`"${key}":`)) missing.push(`${locale}:${key}`);
  }
  expect(missing).toEqual([]);
});

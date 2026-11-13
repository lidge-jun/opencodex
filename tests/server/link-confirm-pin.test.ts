import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { LinkSupervisor } from "../../src/link/supervisor";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const PROBED_FP = "SHA256:abcdefghijklmnop";
const OTHER_FP = "SHA256:zzzzzzzzzzzzzzzz";

let temp = "";
beforeEach(() => { temp = mkdtempSync(join(tmpdir(), "ocx-confirm-pin-")); });
afterEach(() => { if (temp) removeTreeWithRetry(temp); temp = ""; });

function link(alias: string, fingerprint: string): LinkRecord {
  return { id: "lnk_0123456789abcdef", alias, direction: "hub-initiated", hostKeyFingerprint: fingerprint, tunnelPort: 19002, apiKeyId: "link-key", createdAt: "2026-11-01T00:00:00.000Z" };
}

function harness(options: { links?: LinkRecord[]; knownHosts?: string; duringVersion?: (setStore: (store: LinkStore) => void) => void } = {}) {
  const config = { port: 10100, hostname: "127.0.0.1", runtimeRole: "hub", defaultProvider: "mock", providers: {}, apiKeys: [] } as unknown as OcxConfig;
  let current: LinkStore = { version: 1, listenerPort: 19001, links: options.links ?? [] };
  const knownHostsPath = join(temp, "known_hosts");
  writeFileSync(knownHostsPath, options.knownHosts ?? "");
  const runner: SshRunner = {
    async run(argv): Promise<SshRunResult> {
      const text = argv.join(" ");
      if (text.includes("ssh-keygen")) return { code: 0, stdout: "256 " + PROBED_FP + " host (ED25519)", stderr: "" };
      const remote = argv.at(-1) ?? "";
      if (remote === "echo ocx-link-probe") {
        const option = argv.find(value => value.startsWith("UserKnownHostsFile="))!.slice("UserKnownHostsFile=".length);
        writeFileSync(option, argv[argv.indexOf("--") + 1] + " ssh-ed25519 AAAAPROBED\n");
        return { code: 0, stdout: "ocx-link-probe\n", stderr: "" };
      }
      if (remote === "cmd /c echo %OS%") return { code: 127, stdout: "", stderr: "" };
      // The remote ocx script also mentions uname, so the version call is recognised first.
      if (remote.includes("--version")) {
        options.duringVersion?.(store => { current = store; });
        return { code: 0, stdout: "opencodex 2.99.0\n", stderr: "" };
      }
      if (remote.includes("uname")) return { code: 0, stdout: "Linux\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    spawnTunnel: () => { throw new Error("no tunnel"); },
  };
  const supervisor: LinkSupervisor = { start() {}, ensureStarted: async () => {}, reload: async () => {}, stopLink: async () => {}, status: () => [], stop: async () => {} };
  const listener = { ensureStarted: async () => {}, status: () => ({ state: "listening" as const, port: 19001, reason: null }), close: async () => {}, onAuthenticatedCatalog: () => () => {} };
  const deps: ManagementApiDeps = {
    readLinkStore: () => structuredClone(current), writeLinkStore: next => { current = structuredClone(next); },
    linkSupervisor: () => supervisor, linkListener: () => listener, linkKnownHostsPath: () => knownHostsPath, sshRunner: runner,
  };
  const call = async (path: string, body: unknown) => {
    const url = new URL("http://127.0.0.1" + path);
    const req = new Request(url, { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = await handleManagementAPI(req, url, config, deps, "admin-token", { isPaired: () => false, isCurrent: () => false, revokeCurrent: () => false }, { trustedLoopback: true, guiSessionIssuance: null });
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  };
  const confirm = async (alias: string) => {
    expect((await call("/api/link/probe", { alias })).status).toBe(200);
    return call("/api/link/confirm-host", { alias, fingerprint: PROBED_FP });
  };
  return { confirm, knownHostsPath };
}

test.each([
  ["the same spelling", "home", "home"],
  ["another case", "Home", "home"],
])("confirming another key for an alias a Home-initiated link owns (%s) is refused and writes nothing", async (_label, owner, confirmed) => {
  const h = harness({ links: [link(owner, OTHER_FP)], knownHosts: owner + " ssh-ed25519 AAAAPINNED\n" });
  const before = readFileSync(h.knownHostsPath, "utf8");
  const response = await h.confirm(confirmed);
  expect(response).toMatchObject({ status: 409, body: { error: { code: "link_pin_conflict" } } });
  expect(readFileSync(h.knownHostsPath, "utf8")).toBe(before);
});

test("a link that appears while the confirmation runs its SSH work is seen by the locked check", async () => {
  const h = harness({ duringVersion: setStore => setStore({ version: 1, listenerPort: 19001, links: [link("HOME", OTHER_FP)] }) });
  const response = await h.confirm("home");
  expect(response).toMatchObject({ status: 409, body: { error: { code: "link_pin_conflict" } } });
  expect(readFileSync(h.knownHostsPath, "utf8")).toBe("");
});

test("confirming the same key again is allowed, and a case variant leaves exactly one matching line", async () => {
  const h = harness({ links: [link("home", PROBED_FP)], knownHosts: "HOME ssh-ed25519 AAAAPROBED\nother ssh-ed25519 AAAAOTHER\n" });
  expect((await h.confirm("home")).status).toBe(200);
  const lines = readFileSync(h.knownHostsPath, "utf8").split("\n").filter(Boolean);
  expect(lines.filter(line => line.split(" ")[0]!.toLowerCase() === "home")).toEqual(["home ssh-ed25519 AAAAPROBED"]);
  expect(lines).toContain("other ssh-ed25519 AAAAOTHER");
});

test("every confirm-host write goes through the locked pin check", () => {
  const source = readFileSync(repoPath("src/server/management/link-enrollment.ts"), "utf8");
  const confirm = source.slice(source.indexOf("export async function confirmHost"), source.indexOf("function parsePort"));
  expect(confirm.match(/putConfirmedKnownHost\(/g)?.length).toBe(3);
  expect(confirm).not.toMatch(/[^d]putKnownHost\(/);
});

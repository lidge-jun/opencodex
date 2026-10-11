import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";

const fingerprint = "SHA256:abcdefghijklmnop";
const probe = { alias: "child-a", fingerprint, keyType: "ED25519", ocxVersion: "2.83.0" };
const confirm = { alias: probe.alias, fingerprint, ocxVersion: probe.ocxVersion };
const linkId = "lnk_0123456789abcdef";
function harness(bodies: unknown[] = [probe, confirm, { linkId }], status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [], out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  const deps: LinkCliDeps = { baseUrl: "http://127.0.0.1:10100", readAdminToken: () => "ocx_admin_test",
    stdinImpl: Object.assign(Readable.from([]), { isTTY: false }),
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return Response.json(bodies.shift(), { status }); } };
  return { calls, out, err, deps, restore: () => { console.log = log; console.error = error; } };
}
describe("CLI Remote Link enrollment", () => {
  test("probe reports the offered version without confirming or issuing a key", async () => {
    const h = harness(); try {
      expect(await runLinkCommand(["probe", "child-a", "--json"], h.deps)).toBe(0);
      expect(h.out).toHaveLength(1); expect(JSON.parse(h.out[0]!)).toEqual(probe);
      expect(h.calls.map(x => new URL(x.url).pathname)).toEqual(["/api/link/probe"]);
      expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({ alias: "child-a", includeVersion: true });
    } finally { h.restore(); }
  });
  test("non-TTY add refuses before discovery or network when no fingerprint is supplied", async () => {
    const h = harness(); try {
      let discovered = false;
      h.deps.findLiveProxy = async () => { discovered = true; return null; }; delete h.deps.baseUrl;
      expect(await runLinkCommand(["add", "child-a"], h.deps)).not.toBe(0);
      expect(discovered).toBe(false); expect(h.calls).toHaveLength(0);
    } finally { h.restore(); }
  });
  test("exact fingerprint binds one discovery and all three requests, without a key in output", async () => {
    const h = harness(); try {
      delete h.deps.baseUrl; let discovered = 0;
      h.deps.findLiveProxy = async () => { discovered++; return { pid: 123, port: 10100, source: "runtime" }; };
      expect(await runLinkCommand(["add", "child-a", "--expect-fingerprint", fingerprint, "--json"], h.deps)).toBe(0);
      expect(discovered).toBe(1);
      expect(h.out).toHaveLength(1); expect(JSON.parse(h.out[0]!)).toEqual({ linkId, alias: "child-a", state: "connected", childRole: "client" });
      expect(h.calls.map(x => new URL(x.url).pathname)).toEqual(["/api/link/probe", "/api/link/confirm-host", "/api/link/apply"]);
      for (const c of h.calls) { expect(new URL(c.url).origin).toBe("http://127.0.0.1:10100"); expect(c.init?.redirect).toBe("error"); expect(c.init?.signal).toBeInstanceOf(AbortSignal); expect(new Headers(c.init?.headers).get("x-opencodex-api-key")).toBe("ocx_admin_test"); }
      expect(JSON.parse(String(h.calls[2]?.init?.body))).toEqual({ alias: "child-a", fingerprint });
      expect(h.err).toEqual([]);
    } finally { h.restore(); }
  });
  test("mismatched fingerprint refuses before durable confirmation", async () => {
    const h = harness(); try {
      expect(await runLinkCommand(["add", "child-a", "--expect-fingerprint", "SHA256:xxxxxxxxxxxxxxxx"], h.deps)).not.toBe(0);
      expect(h.calls).toHaveLength(1); expect(h.out).toEqual([]);
    } finally { h.restore(); }
  });
  test.each([false, true])("TTY requires explicit confirmation: %s", async approved => {
    const h = harness(); try {
      h.deps.stdinImpl = Object.assign(Readable.from([]), { isTTY: true });
      h.deps.confirmFingerprint = async offered => { expect(offered).toEqual(probe); return approved; };
      expect(await runLinkCommand(["add", "child-a"], h.deps)).toBe(approved ? 0 : 2);
      expect(h.calls).toHaveLength(approved ? 3 : 1);
    } finally { h.restore(); }
  });
  test.each([["-bad"], ["child-a", "--unknown"], ["child-a", "--expect-fingerprint", "bad"], ["child-a", "--expect-fingerprint", fingerprint, "--expect-fingerprint", fingerprint]])("bad arguments refuse before network: %j", async args => {
    const h = harness(); try { expect(await runLinkCommand(["add", ...args], h.deps)).not.toBe(0); expect(h.calls).toHaveLength(0); } finally { h.restore(); }
  });
  test.each(["probe", "confirm", "apply"])("malformed %s response never prints a credential", async stage => {
    const secret = "ocx_data_" + "a".repeat(40);
    const bodies = stage === "probe" ? [{ ...probe, key: secret }] : stage === "confirm" ? [probe, { ...confirm, key: secret }] : [probe, confirm, { linkId, key: secret }];
    const h = harness(bodies); try {
      expect(await runLinkCommand(["add", "child-a", "--expect-fingerprint", fingerprint], h.deps)).toBe(1);
      expect(h.out).toEqual([]); expect(h.err.join("\n")).not.toContain(secret);
      expect(h.calls).toHaveLength(stage === "probe" ? 1 : stage === "confirm" ? 2 : 3);
    } finally { h.restore(); }
  });
  test("residual failures retain fixed Child recovery without remote error text", async () => {
    const h = harness(); try {
      let i = 0;
      h.deps.fetchImpl = async () => ++i < 3 ? Response.json(i === 1 ? probe : confirm) : Response.json({ error: { code: "child_restart_failed", message: "ocx_data_secret", hint: "ocx_data_secret" }, residual: true, recovery: "ocx_data_secret" }, { status: 502 });
      expect(await runLinkCommand(["add", "child-a", "--expect-fingerprint", fingerprint], h.deps)).toBe(1);
      expect(h.err.join("\n")).toContain("Run ocx disconnect and ocx restart on the Child before retrying.");
      expect(h.err.join("\n")).not.toContain("ocx_data_secret"); expect(h.out).toEqual([]);
    } finally { h.restore(); }
  });
  test("whole deadline bounds an unfinished response body and prevents later apply", async () => {
    const h = harness(); try {
      h.deps.enrollmentTimeoutMs = 15;
      let body!: ReadableStreamDefaultController<Uint8Array>;
      h.deps.fetchImpl = async (url, init) => { h.calls.push({ url: String(url), init }); return new Response(new ReadableStream({ start(c) { body = c; } })); };
      const code = await runLinkCommand(["add", "child-a", "--expect-fingerprint", fingerprint], h.deps);
      expect(code).toBe(1); expect(h.calls).toHaveLength(1); expect(h.err.join("\n")).toContain("outcome is uncertain");
      body.enqueue(new TextEncoder().encode(JSON.stringify(probe))); body.close();
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(h.calls).toHaveLength(1); expect(h.out).toEqual([]);
    } finally { h.restore(); }
  });
  test("offline Child uses config identity and supplied tunnel failure despite an empty Home store", async () => {
    const h = harness(); try {
      delete h.deps.baseUrl; h.deps.findLiveProxy = async () => null;
      h.deps.readStore = () => ({ version: 1, listenerPort: null, links: [] });
      h.deps.readConfig = () => ({ runtimeRole: "client", client: { transport: "link", serverUrl: "http://127.0.0.1:19200", connectedAt: "2026-10-11T00:00:00Z", link: { linkId, tunnelPort: 19200 } } });
      h.deps.readClientLinkIdentity = () => ({ direction: "hub-initiated" });
      h.deps.readChildStatus = () => ({ alias: "Home", state: "failed", since: "2026-10-11T01:00:00Z", reason: "sidecar_invalid" });
      expect(await runLinkCommand(["status", "--json"], h.deps)).toBe(0);
      const value = JSON.parse(h.out[0]!); expect(value.role).toBe("child"); expect(value.links[0]).toMatchObject({ id: linkId, tunnelPort: 19200, state: "failed" }); expect(value.child.state).toBe("failed");
    } finally { h.restore(); }
  });
});

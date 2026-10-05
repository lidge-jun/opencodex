import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { handleClientIntegrationCommand } from "../../src/cli/integrations";
import { handleIntegrationAsideSync, type AsideSyncCliDeps } from "../../src/cli/integration-aside-sync";
import { getRuntimePortPath } from "../../src/config/process-state";
import { LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER, createLocalAttestationProof } from "../../src/lib/local-management-attestation";
import { LOCAL_ASIDE_SYNC_CAPABILITY_HEADER, LOCAL_ASIDE_SYNC_CAPABILITY_VERSION, LOCAL_ASIDE_SYNC_EXPECTED_PID_HEADER, LOCAL_ASIDE_SYNC_EXPIRES_AT_HEADER, LOCAL_ASIDE_SYNC_NONCE_HEADER, LOCAL_ASIDE_SYNC_PATH, verifyLocalAsideSyncCapability } from "../../src/lib/local-aside-sync-contract";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome, output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let token: string | undefined;
beforeEach(() => {
  home = createTempHome("ocx-cli-aside-sync-"); token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {}); errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled(); network.mockRestore(); output.mockRestore(); errors.mockRestore();
  if (token === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = token;
  home.remove();
});
const json = () => JSON.parse(output.mock.calls.flat().join("\n"));
const channels = () => [...output.mock.calls.flat(), ...errors.mock.calls.flat()].join("\n");
const args = ["--client", "aside", "--json"];
function fixture(body: unknown = { results: [] }, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const deps: AsideSyncCliDeps = { baseUrl: "http://127.0.0.1:15002", fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init }); return Response.json(body, { status });
  } };
  return { calls, deps };
}

describe("Aside-only synchronization command", () => {
  test.each([[], ["--json"], ["--client", "hermes"], [...args, "--profile", "1"], [...args, "--client", "aside"],
    [...args, "--json"], [...args, "--yes"], [...args, "private-canary"], ["--client"],
  ].map(argv => ({ argv })))("validates all arguments before owner/discovery: $argv", async ({ argv }) => {
    const f = fixture(); let called = false;
    f.deps.refreshAsideProfilesImpl = async () => { called = true; return []; };
    expect(await handleIntegrationAsideSync(argv, f.deps)).toBe(2); expect(called).toBe(false);
    expect(f.calls).toHaveLength(0); expect(output).not.toHaveBeenCalled(); expect(channels()).not.toContain("private-canary");
  });
  test("forwards the exact original deps object to the existing owner seam", async () => {
    const deps: AsideSyncCliDeps = { findLiveProxy: async () => { throw new Error("No independent discovery"); } };
    deps.refreshAsideProfilesImpl = async received => { expect(received).toBe(deps); expect(received?.baseUrl).toBeUndefined(); return []; };
    expect(await handleIntegrationAsideSync(args, deps)).toBe(0); expect(json()).toEqual({ results: [] });
  });
  test("explicit transport still invokes the established helper path once", async () => {
    const f = fixture({ results: [{ client: "aside", profileId: 2, ok: true, changed: true, private: "private-canary" }] });
    expect(await handleIntegrationAsideSync(args, f.deps)).toBe(0);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.url).toBe("http://127.0.0.1:15002/api/client-integrations/aside/sync");
    expect(f.calls[0]!.init).toMatchObject({ method: "POST", body: "{}" });
    expect(json()).toEqual({ results: [{ client: "aside", profileId: 2, ok: true, changed: true }] });
  });
  test("empty eligible set is described as no work", async () => {
    const f = fixture(); expect(await handleIntegrationAsideSync(["--client", "aside"], f.deps)).toBe(0);
    expect(channels()).toContain("No eligible Aside profiles"); expect(channels()).not.toContain("updated");
  });
  test.each([true, false])("partial results preserve safe outcomes and return nonzero (JSON %s)", async wantsJson => {
    const f = fixture({ results: [
      { client: "aside", profileId: 1, ok: true, changed: false },
      { client: "aside", profileId: 2, ok: false, state: "unsafe", refusalReason: "write_failed", reason: "private-canary", residual: true,
        snapshotPath: "/Users/example/private-token-canary/backup.json", credentials: "private-canary" },
    ] });
    expect(await handleClientIntegrationCommand(["sync", "--client", "aside", ...(wantsJson ? ["--json"] : [])], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(1); expect(channels()).not.toContain("private-canary"); expect(channels()).not.toContain("private-token-canary"); expect(channels()).not.toContain("/Users/example/");
    if (wantsJson) {
      expect(json().results[0]).toEqual({ client: "aside", profileId: 1, ok: true, changed: false });
      expect(json().results[1]).toMatchObject({ profileId: 2, ok: false, residual: true, state: "unsafe", refusalReason: "write_failed" });
      expect(json().results[1].snapshotPath).toContain("backup.json");
    } else { expect(channels()).toContain("profile 1: unchanged"); expect(channels()).toContain("profile 2: failed"); expect(channels()).toContain("Backup (redacted path)"); }
  });
  test("a removed managed block remains unchanged with explicit notice", async () => {
    const f = fixture({ results: [{ client: "aside", profileId: 0, ok: true, changed: false, reason: "managed block is absent; refresh did not reconnect it" }] });
    expect(await handleIntegrationAsideSync(["--client", "aside"], f.deps)).toBe(0); expect(channels()).toContain("did not reconnect");
  });
  test.each([
    {}, { results: null }, { results: [null] },
    { results: [{ client: "aside", profileId: -1, ok: true, changed: false }] },
    { results: [{ client: "aside", profileId: 1.5, ok: true, changed: false }] },
    { results: [{ client: "aside", profileId: 9007199254740992, ok: true, changed: false }] },
    { results: [{ client: "other", profileId: 1, ok: true, changed: false }] },
    { results: [{ client: "aside", profileId: 1, ok: "true", changed: false }] },
    { results: [{ client: "aside", profileId: 1, ok: true }] },
    { results: [{ client: "aside", profileId: 1, ok: false, state: "unsafe", refusalReason: "unknown" }] },
    { results: [{ client: "aside", profileId: 1, ok: false, state: "unknown", refusalReason: "unsafe" }] },
    { results: [{ client: "aside", profileId: 1, ok: false }] },
    { results: [{ client: "aside", profileId: 1, ok: true, changed: false }, { client: "aside", profileId: 1, ok: true, changed: true }] },
  ])("malformed/duplicate identities never look like empty success", async body => {
    const f = fixture(body); expect(await handleIntegrationAsideSync(args, f.deps)).toBe(1);
    expect(output).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(1);
  });
  test.each([404, 409, 503])("helper HTTP refusal is nonzero and secret safe: %s", async status => {
    const f = fixture({ error: "private-canary", results: [] }, status);
    expect(await handleIntegrationAsideSync(args, f.deps)).toBe(1);
    expect(output).not.toHaveBeenCalled(); expect(channels()).not.toContain("private-canary");
  });
  test("unknown thrown helper error never leaks", async () => {
    expect(await handleIntegrationAsideSync(args, { refreshAsideProfilesImpl: async () => { throw new Error("private-canary"); } })).toBe(1);
    expect(channels()).not.toContain("private-canary"); expect(output).not.toHaveBeenCalled();
  });
});

describe("production default retains the attested Aside exchange", () => {
  test.each([true, false])("default helper requires valid listener proof before POST (%s)", async validProof => {
    const secret = "S".repeat(43);
    const paths: string[] = [];
    let nonce: string | null = null; let capabilityValid = false; let postBody = "unobserved";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname; paths.push(path);
      if (path === "/healthz") {
        nonce = req.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
        const proof = createLocalAttestationProof(secret, nonce!, process.pid, server.port!)!;
        return Response.json({ service: "opencodex", pid: process.pid, port: server.port, asideSyncCapability: LOCAL_ASIDE_SYNC_CAPABILITY_VERSION }, {
          headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: validProof ? proof : "W".repeat(43) },
        });
      }
      if (path === LOCAL_ASIDE_SYNC_PATH) {
        const expiresAt = Number(req.headers.get(LOCAL_ASIDE_SYNC_EXPIRES_AT_HEADER));
        capabilityValid = req.headers.get(LOCAL_ASIDE_SYNC_NONCE_HEADER) === nonce
          && req.headers.get(LOCAL_ASIDE_SYNC_EXPECTED_PID_HEADER) === String(process.pid)
          && !req.headers.has("x-opencodex-api-key")
          && verifyLocalAsideSyncCapability(secret, nonce, req.method, path, process.pid, server.port!, expiresAt, req.headers.get(LOCAL_ASIDE_SYNC_CAPABILITY_HEADER));
        postBody = await req.text();
        return Response.json({ results: [{ client: "aside", profileId: 1, ok: true, changed: false }] });
      }
      return new Response(null, { status: 404 });
    } });
    try {
      // Write only the owned fixture record; writeRuntimePort also registers a global owner home.
      writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: process.pid, port: server.port, hostname: "127.0.0.1", attestationSecret: secret }));
      const exit = await handleClientIntegrationCommand(["sync", ...args], { findLiveProxy: async () => ({ pid: process.pid, port: server.port!, hostname: "127.0.0.1", source: "runtime" }) });
      expect(exit).toBe(validProof ? 0 : 1);
      expect(paths).toEqual(validProof ? ["/healthz", LOCAL_ASIDE_SYNC_PATH] : ["/healthz"]);
      if (validProof) { expect(capabilityValid).toBe(true); expect(postBody).toBe(""); expect(json().results[0].profileId).toBe(1); }
      else expect(output).not.toHaveBeenCalled();
    } finally { await server.stop(true); }
  });
});

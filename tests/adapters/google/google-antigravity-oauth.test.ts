import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { discoverAntigravityProject, refreshAntigravityToken } from "../../../src/oauth/google-antigravity";
import { mkdirSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountCredential, getAccountSet, getCredential, saveCredential } from "../../../src/oauth/store";
import { getValidAccessTokenForAccount, getLoginStatus } from "../../../src/oauth";
import { ANTIGRAVITY_IDE_VERSION } from "../../../src/adapters/client-fingerprint";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function routeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { calls };
}

describe("antigravity project discovery", () => {
  test("loadCodeAssist returns the project (cloudaicompanionProject)", async () => {
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({ cloudaicompanionProject: "proj-A" }), { status: 200 });
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-A");
  });

  test("extracts project from a nested {id} shape", async () => {
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({ project: { id: "proj-nested" } }), { status: 200 });
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-nested");
  });

  test.each(["network", "non-2xx", "invalid JSON"] as const)("loadCodeAssist %s follows base onboarding behavior", async mode => {
    const { calls } = routeFetch(url => {
      if (url.includes(":loadCodeAssist")) {
        if (mode === "network") throw new Error("offline");
        if (mode === "non-2xx") return new Response("unavailable", { status: 503 });
        return new Response("not json");
      }
      if (url.includes(":onboardUser")) return Response.json({ done: true, response: { cloudaicompanionProject: "proj-onboarded" } });
      throw new Error(`Unexpected request: ${url}`);
    });
    if (mode === "network") await expect(discoverAntigravityProject("tok")).rejects.toThrow("offline");
    else await expect(discoverAntigravityProject("tok")).resolves.toBe("proj-onboarded");
    expect(calls.filter(url => url.includes(":onboardUser"))).toHaveLength(mode === "network" ? 0 : 1);
  });

  test("falls back to onboardUser poll loop (not-done then done)", async () => {
    let onboardCalls = 0;
    routeFetch((url, init) => {
      if (url.includes(":onboardUser")) {
        // #1889: the synthetic x-goog-api-client header is dropped from onboarding — the real
        // Antigravity client does not send it, so emitting it was a fingerprint mismatch.
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers["x-goog-api-client"]).toBeUndefined();
        expect(headers["User-Agent"]).toMatch(/^antigravity\/ide\//);
      }
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 }); // no project
      if (url.includes(":onboardUser")) {
        onboardCalls++;
        if (onboardCalls === 1) return new Response(JSON.stringify({ done: false }), { status: 200 });
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: "proj-onboarded" } }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-onboarded");
    expect(onboardCalls).toBe(2);
  });

  // `ide_version` was sending `antigravityUserAgent()` — the whole header, parentheses and all —
  // where the real client sends a bare version. Nothing failed, because the request still
  // succeeds; it just does not look like Antigravity. A fingerprint is only worth having if it
  // matches, so pin the field rather than trusting that nobody re-reaches for the UA helper.
  test("onboardUser sends a bare ide_version, not the User-Agent string", async () => {
    let onboardBody: string | undefined;
    routeFetch((url, init) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes(":onboardUser")) {
        onboardBody = typeof init?.body === "string" ? init.body : undefined;
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: "p" } }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });

    await discoverAntigravityProject("tok");

    const metadata = JSON.parse(onboardBody ?? "{}").metadata as { ide_version?: string };
    expect(metadata.ide_version).toBe(ANTIGRAVITY_IDE_VERSION);
    expect(metadata.ide_version).not.toContain("antigravity/ide/");
    expect(metadata.ide_version).not.toContain("(");
  });

  test("returns undefined when onboardUser aborts with a hard 4xx", async () => {
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes(":onboardUser")) return new Response("forbidden", { status: 403 });
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBeUndefined();
  });

  test("onboardUser retries a transient 503 within the attempt budget then succeeds", async () => {
    let onboardCalls = 0;
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes(":onboardUser")) {
        onboardCalls++;
        if (onboardCalls === 1) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: "proj-T" } }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-T");
    expect(onboardCalls).toBe(2);
  });
});

describe("antigravity refresh", () => {
  test("refreshes the access token and re-discovers project; never leaks the token in errors", async () => {
    routeFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({ cloudaicompanionProject: "proj-R" }), { status: 200 });
      return new Response("no", { status: 404 });
    });
    const issuedAt = 1_900_000_000_000;
    const nowSpy = spyOn(Date, "now").mockReturnValue(issuedAt);
    const cred = await (async () => {
      try {
        return await refreshAntigravityToken("refresh-tok");
      } finally {
        nowSpy.mockRestore();
      }
    })();
    expect(cred.access).toBe("fresh-access");
    expect(cred.refresh).toBe("refresh-tok");
    expect(cred.projectId).toBe("proj-R");
    // A one-hour Google token must retain roughly 55 minutes after the provider margin. The
    // previous 50-minute margin stored only ten minutes and caused repeated refreshes in use.
    expect(cred.expires - issuedAt).toBe(55 * 60 * 1000);
  });

  test.each([
    [{ id: "free-tier", name: "Free" }, "Free"],
    [{ id: "paid-pro", name: "Google AI Pro" }, "Google AI Pro"],
    [{ id: "paid-pro", name: " Google AI Pro " }, "Google AI Pro"],
    [{ id: "fixture-ultra", name: "Google AI Ultra" }, "Google AI Ultra"],
    [{ id: "paid", name: `Google AI ${"x".repeat(118)}` }, `Google AI ${"x".repeat(118)}`],
    [{ id: "paid", name: `Google AI ${"x".repeat(119)}` }, null],
    [{ id: "paid", name: "Google AI Pro\n" }, null],
    [{ id: "paid", name: "Google AI Pro\u0085" }, null],
    [{ id: "paid", name: 42 }, null],
    [{ id: "unknown-product", name: "Other Product" }, null],
    [undefined, null],
  ] as const)("observes loadCodeAssist paidTier %p as %p", async (paidTier, expected) => {
    routeFetch(url => {
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", expires_in: 3600 });
      if (url.includes(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "proj", paidTier });
      throw new Error(`Unexpected request: ${url}`);
    });
    expect((await refreshAntigravityToken("rt")).plan).toBe(expected);
  });

  test("refresh failure carries status only, not the response body", async () => {
    routeFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) return new Response("invalid_grant secret-detail", { status: 400 });
      return new Response("no", { status: 404 });
    });
    let caught: Error | undefined;
    try { await refreshAntigravityToken("refresh-tok"); } catch (e) { caught = e as Error; }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("400");
    expect(caught!.message).not.toContain("secret-detail");
  });
});

describe("antigravity credential persistence (projectId survives the store)", () => {
  const origHome = process.env.HOME;
  const origOcxHome = process.env.OPENCODEX_HOME;
  let tmp: string;

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
    if (tmp) removeTreeWithRetry(tmp);
  });

  test.each([
    ["request failure", "throw", "Google AI Pro"],
    ["non-2xx", "status", "Google AI Pro"],
    ["unparseable body", "invalid", "Google AI Pro"],
    ["unknown product", "unknown", null],
    ["oversized name", "oversized", null],
    ["missing tier", "missing", null],
    ["observed null then onboarding throws", "null-onboard", null],
    ["observed Pro then onboarding throws", "pro-onboard", "Google AI Pro"],
  ] as const)("refresh preserves or replaces the observed plan: %s", async (_label, mode, expected) => {
    tmp = join(tmpdir(), `ag-plan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env.HOME = tmp;
    process.env.OPENCODEX_HOME = join(tmp, "ocx");
    await saveCredential("google-antigravity", {
      access: "old", refresh: "rt", expires: Date.now() - 1000,
      projectId: "proj-old", plan: mode === "pro-onboard" ? "Free" : "Google AI Pro",
    });
    const id = getAccountSet("google-antigravity")!.activeAccountId;
    const { calls } = routeFetch(url => {
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", expires_in: 3600 });
      if (url.includes(":loadCodeAssist")) {
        if (mode === "throw") throw new Error("offline");
        if (mode === "status") return new Response("failure", { status: 503 });
        if (mode === "invalid") return new Response("not json");
        const paidTier = mode === "unknown" || mode === "null-onboard"
          ? { id: "other", name: "Other Product" }
          : mode === "oversized" ? { id: "paid", name: `Google AI ${"x".repeat(119)}` }
          : mode === "pro-onboard" ? { id: "pro", name: "Google AI Pro" } : undefined;
        return Response.json({ ...(["unknown", "oversized", "missing"].includes(mode) ? { cloudaicompanionProject: "proj-new" } : {}), paidTier });
      }
      if (url.includes(":onboardUser")) {
        if (mode.endsWith("-onboard")) throw new Error("onboarding unavailable");
        return new Response("forbidden", { status: 403 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    expect(await getValidAccessTokenForAccount("google-antigravity", id)).toBe("fresh");
    if (mode === "throw") expect(calls.some(url => url.includes(":onboardUser"))).toBe(false);
    if (mode.endsWith("-onboard")) expect(calls.filter(url => url.includes(":onboardUser"))).toHaveLength(1);
    expect(getAccountCredential("google-antigravity", id)?.plan).toBe(expected);
    expect(getLoginStatus("google-antigravity").accounts?.[0]?.plan).toBe(expected);
  });

  test("plan normalization persists null, trims bounded names, rejects controls and accepts legacy records", async () => {
    tmp = join(tmpdir(), `ag-store-plan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env.HOME = tmp;
    process.env.OPENCODEX_HOME = join(tmp, "ocx");
    const base = { access: "a", refresh: "r", expires: Date.now() + 3_600_000, email: "ag@example.test" };
    await saveCredential("google-antigravity", base);
    expect(getCredential("google-antigravity")?.plan).toBeUndefined();
    expect(Object.hasOwn(getCredential("google-antigravity")!, "plan")).toBe(false);
    for (const [input, expected] of [
      [null, null],
      ["  Google AI Pro  ", "Google AI Pro"],
      [`Google AI ${"x".repeat(118)}`, `Google AI ${"x".repeat(118)}`],
      ["bad\nplan", null],
      ["\tGoogle AI Pro", null],
      ["Google AI Pro\n", null],
      ["Google AI Pro\x7f", null],
      ["Google AI Pro\u0085", null],
      ["x".repeat(129), null],
      ["   ", null],
      [42, null],
    ] as const) {
      await saveCredential("google-antigravity", { ...base, plan: input as string | null });
      expect(getCredential("google-antigravity")?.plan).toBe(expected);
      expect(Object.hasOwn(getCredential("google-antigravity")!, "plan")).toBe(true);
    }
    await saveCredential("google-antigravity", base);
    expect(getCredential("google-antigravity")?.plan).toBeNull();
    expect(Object.hasOwn(getCredential("google-antigravity")!, "plan")).toBe(true);
  });

  test("saveCredential + getCredential round-trips projectId (regression: was stripped by normalizeCredential)", async () => {
    tmp = join(tmpdir(), `ag-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env.HOME = tmp;
    process.env.OPENCODEX_HOME = join(tmp, "ocx");
    await saveCredential("google-antigravity", { access: "a", refresh: "r", expires: Date.now() + 3_600_000, projectId: "proj-persist" });
    expect(getCredential("google-antigravity")?.projectId).toBe("proj-persist");
  });
});

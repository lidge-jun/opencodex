import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AntigravityTokenRequestError, discoverAntigravityProject, refreshAntigravityToken } from "../src/oauth/google-antigravity";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, getCredential, saveCredential } from "../src/oauth/store";
import { getValidAccessTokenForAccount, getValidAccessTokenSnapshotForAccount } from "../src/oauth";
import { ANTIGRAVITY_IDE_VERSION } from "../src/adapters/client-fingerprint";

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

  test("preserves only an allowlisted terminal OAuth code", async () => {
    routeFetch((url) => url.includes("oauth2.googleapis.com/token")
      ? new Response(JSON.stringify({ error: "invalid_grant", error_description: "private detail" }), { status: 400 })
      : new Response("no", { status: 404 }));
    await expect(refreshAntigravityToken("refresh-tok")).rejects.toMatchObject({
      constructor: AntigravityTokenRequestError,
      httpStatus: 400,
      oauthError: "invalid_grant",
    });
    try { await refreshAntigravityToken("refresh-tok"); } catch (error) {
      expect((error as Error).message).not.toContain("private detail");
    }
  });

  test("refresh preserves an existing project id without another CCA discovery request", async () => {
    const calls: string[] = [];
    routeFetch((url) => {
      calls.push(url);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ cloudaicompanionProject: "unexpected" }), { status: 200 });
    });
    const credential = await refreshAntigravityToken("refresh-tok", undefined, {
      access: "old-access",
      refresh: "refresh-tok",
      expires: 0,
      projectId: "existing-project",
    });
    expect(credential.projectId).toBe("existing-project");
    expect(calls.filter(url => url.includes(":loadCodeAssist")).length).toBe(0);
  });
});

describe("antigravity credential persistence (projectId survives the store)", () => {
  const origHome = process.env.HOME;
  const origOcxHome = process.env.OPENCODEX_HOME;
  let tmp: string;

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("saveCredential + getCredential round-trips projectId (regression: was stripped by normalizeCredential)", async () => {
    tmp = join(tmpdir(), `ag-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env.HOME = tmp;
    process.env.OPENCODEX_HOME = join(tmp, "ocx");
    await saveCredential("google-antigravity", { access: "a", refresh: "r", expires: Date.now() + 3_600_000, projectId: "proj-persist" });
    expect(getCredential("google-antigravity")?.projectId).toBe("proj-persist");
  });

  test("terminal refresh marks only the selected Antigravity account needsReauth", async () => {
    tmp = join(tmpdir(), `ag-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env.HOME = tmp;
    process.env.OPENCODEX_HOME = join(tmp, "ocx");
    await saveCredential("google-antigravity", { access: "a", refresh: "refresh-a", expires: 0, accountId: "acct-a" });
    await saveCredential("google-antigravity", { access: "b", refresh: "refresh-b", expires: Date.now() + 3_600_000, accountId: "acct-b" });
    const set = getAccountSet("google-antigravity")!;
    const accountA = set.accounts.find(account => account.credential.accountId === "acct-a")!;
    routeFetch(url => url.includes("oauth2.googleapis.com/token")
      ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      : new Response("no", { status: 404 }));
    await expect(getValidAccessTokenForAccount("google-antigravity", accountA.id)).rejects.toThrow();
    const after = getAccountSet("google-antigravity")!;
    expect(after.accounts.find(account => account.credential.accountId === "acct-a")?.needsReauth).toBe(true);
    expect(after.accounts.find(account => account.credential.accountId === "acct-b")?.needsReauth).not.toBe(true);
  });

  test("account refresh keeps the stored project id without CCA discovery", async () => {
    tmp = join(tmpdir(), `ag-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env.HOME = tmp;
    process.env.OPENCODEX_HOME = join(tmp, "ocx");
    await saveCredential("google-antigravity", {
      access: "expired-access",
      refresh: "refresh-account",
      expires: 0,
      projectId: "stored-project",
      accountId: "acct-refresh",
    });
    const accountId = getAccountSet("google-antigravity")!.activeAccountId;
    const calls: string[] = [];
    routeFetch(url => {
      calls.push(url);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ cloudaicompanionProject: "unexpected-project" }), { status: 200 });
    });

    const snapshot = await getValidAccessTokenSnapshotForAccount("google-antigravity", accountId);
    expect(snapshot.accessToken).toBe("fresh-access");
    expect(snapshot.projectId).toBe("stored-project");
    expect(calls.filter(url => url.includes(":loadCodeAssist")).length).toBe(0);
    expect(await getValidAccessTokenForAccount("google-antigravity", accountId)).toBe("fresh-access");
  });
});

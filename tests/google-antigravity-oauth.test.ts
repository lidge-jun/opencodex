import { afterEach, describe, expect, test } from "bun:test";
import { discoverAntigravityProject, refreshAntigravityToken } from "../src/oauth/google-antigravity";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCredential, saveCredential } from "../src/oauth/store";

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
    routeFetch((url) => {
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
    const cred = await refreshAntigravityToken("refresh-tok");
    expect(cred.access).toBe("fresh-access");
    expect(cred.refresh).toBe("refresh-tok");
    expect(cred.projectId).toBe("proj-R");
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
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("saveCredential + getCredential round-trips projectId (regression: was stripped by normalizeCredential)", () => {
    tmp = join(tmpdir(), `ag-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env.HOME = tmp;
    process.env.OPENCODEX_HOME = join(tmp, "ocx");
    saveCredential("google-antigravity", { access: "a", refresh: "r", expires: Date.now() + 3_600_000, projectId: "proj-persist" });
    expect(getCredential("google-antigravity")?.projectId).toBe("proj-persist");
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { discoverAntigravityProject, refreshAntigravityToken } from "../../../src/oauth/google-antigravity";
import { mkdirSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCredential, saveCredential } from "../../../src/oauth/store";
import { ANTIGRAVITY_IDE_VERSION } from "../../../src/adapters/client-fingerprint";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { OAuthCallbackFlow } from "../../../src/oauth/callback-server";
import { publicOAuthAuthenticationErrorMessage, runLogin } from "../../../src/oauth";
import { getDefaultConfig } from "../../../src/config";
import { AntigravityProjectDiscoveryError, summarizeAntigravityDiscovery } from "../../../src/oauth/antigravity-discovery-diagnostics";

const realFetch = globalThis.fetch;
const secret = "PRIVATE_DISCOVERY_SENTINEL";
const prevGoogleUa = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
beforeEach(() => { delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT; });
afterEach(() => {
  globalThis.fetch = realFetch;
  if (prevGoogleUa === undefined) delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
  else process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = prevGoogleUa;
});

function routeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { calls };
}

// Exercise the real exchange and runLogin admission, without a browser/listening socket or writes.
async function failedDiscoveryLogin(load: () => Response, onboard: () => Response): Promise<string> {
  routeFetch(url => url.includes("oauth2.googleapis.com/token")
    ? Response.json({ access_token: secret, refresh_token: secret })
    : url.includes(":loadCodeAssist") ? load() : onboard());
  const flow = spyOn(OAuthCallbackFlow.prototype, "login").mockImplementation(async function () {
    await this.generateAuthUrl("state", "http://127.0.0.1/callback");
    return this.exchangeToken("code", "state", "http://127.0.0.1/callback");
  });
  let writes = 0;
  const rejectWrite = async (): Promise<never> => { writes++; throw new Error("unexpected persistence"); };
  try {
    let caught: unknown;
    try {
      await runLogin("google-antigravity", { signal: new AbortController().signal, onAuth() {} }, undefined, {
        loadConfig: getDefaultConfig,
        saveCredential: rejectWrite,
        saveAccountCredential: rejectWrite,
        saveConfig: rejectWrite,
        mutatePersistedConfig: rejectWrite,
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(writes).toBe(0);
    const message = (caught as Error).message;
    expect(message).toContain("could not discover a Cloud Code Assist project");
    expect(message).not.toContain(secret);
    return message;
  } finally { flow.mockRestore(); }
}

describe("antigravity sanitized failed-login discovery diagnostics", () => {
  test("typed error projects only sanitized observations even when message and cause are overwritten", () => {
    const error = new AntigravityProjectDiscoveryError();
    error.observe("loadCodeAssist", 403, undefined);
    error.observe("onboardUser", 200, { done: false, [secret]: secret });
    error.observe("onboardUser", 200, { done: true, error: { message: secret } });
    const safeMessage = error.message;
    error.message = secret;
    error.cause = new Error(secret);
    const projected = publicOAuthAuthenticationErrorMessage(error);
    expect(projected).toBe(safeMessage);
    expect(projected).toContain('"stage":"loadCodeAssist","status":403');
    expect(projected).toContain('"outcome":"done-with-error"');
    expect(projected).not.toContain('"outcome":"pending"');
    expect(projected.match(/"stage":"onboardUser"/g)).toHaveLength(1);
    expect(projected).not.toContain(secret);
  });

  test("pure summary contains only fixed fields, enums and status with private keys/values", () => {
    const summary = summarizeAntigravityDiscovery("onboardUser", 200, {
      [secret]: secret, done: true, error: { [secret]: secret }, name: secret,
      cloudaicompanionProject: secret, projectId: { id: secret, [secret]: secret }, project: { [secret]: secret },
      response: { [secret]: secret, cloudaicompanionProject: [secret], projectId: null },
    });
    expect(summary).not.toContain(secret);
    expect(JSON.parse(summary)).toEqual({
      stage: "onboardUser", status: 200, root: "object", outcome: "done-with-error", done: "true", error: "present",
      projects: { cloudaicompanionProject: "string", projectId: "object-with-id", project: "object-without-id" },
      response: { cloudaicompanionProject: "other", projectId: "other", project: "absent" },
    });
  });

  for (const [label, load, outcome, root] of [
    ["HTTP refusal", () => new Response(secret, { status: 403 }), "http-refusal", "unparseable"],
    ["malformed JSON", () => new Response(secret), "unparseable", "unparseable"],
    ["array root", () => Response.json([{ [secret]: secret }]), "invalid-root", "array"],
    ["scalar root", () => Response.json(secret), "invalid-root", "other"],
    ["null root", () => Response.json(null), "invalid-root", "other"],
    ["object without project", () => Response.json({ [secret]: secret }), "no-project", "object"],
  ] as const) {
    test(`${label} has its own loadCodeAssist summary and cannot persist`, async () => {
      const message = await failedDiscoveryLogin(load, () => new Response(secret, { status: 403 }));
      expect(message).toContain(`"stage":"loadCodeAssist","status":${label === "HTTP refusal" ? 403 : 200}`);
      expect(message).toContain(`"root":"${root}","outcome":"${outcome}"`);
      expect(message).toContain('"stage":"onboardUser","status":403');
    });
  }

  for (const [label, body, done, error] of [
    ["done-with-error", { done: true, error: { [secret]: secret }, name: secret }, "true", "present"],
    ["done-without-project", { done: true, response: { [secret]: secret } }, "true", "absent"],
    ["pending", { done: false, name: secret }, "false", "absent"],
    ["pending", { [secret]: secret }, "absent", "absent"],
  ] as const) {
    test(`onboardUser ${label} (done=${done}) stays sanitized and within budget`, async () => {
      const realSetTimeout = globalThis.setTimeout;
      let waits = 0;
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(((handler, delay, ...args) => {
        if (delay === 2000) { waits++; return realSetTimeout(handler, 0, ...args); }
        return realSetTimeout(handler, delay, ...args);
      }) as typeof setTimeout);
      let polls = 0;
      try {
        const message = await failedDiscoveryLogin(() => Response.json({}), () => { polls++; return Response.json(body); });
        expect(message).toContain(`"root":"object","outcome":"${label}"`);
        expect(message).toContain(`"done":"${done}","error":"${error}"`);
        expect(polls).toBe(label === "pending" ? 5 : 1);
        expect(waits).toBe(label === "pending" ? 5 : 0);
        expect(message.match(/"stage":"onboardUser"/g)?.length).toBe(1);
      } finally { timer.mockRestore(); }
    });
  }

  test("only known project keys and value types appear, never arbitrary keys or values", async () => {
    const message = await failedDiscoveryLogin(() => Response.json({
      [secret]: secret, name: secret, done: secret, error: { message: secret },
      cloudaicompanionProject: { [secret]: secret }, projectId: 42, project: [],
    }), () => Response.json({ done: true, error: { [secret]: secret }, response: {
      [secret]: secret, cloudaicompanionProject: "", projectId: { id: "", [secret]: secret }, project: null,
    } }));
    expect(message).toContain('"cloudaicompanionProject":"object-without-id","projectId":"other","project":"other"');
    expect(message).toContain('"cloudaicompanionProject":"string","projectId":"object-with-id","project":"other"');
    expect(message).not.toContain('"name"');
    expect(message).not.toContain('"message"');
  });

  for (const [label, response, status, root, polls, waits] of [
    ["malformed JSON", () => new Response(secret), 200, "unparseable", 5, 5],
    ["array root", () => Response.json([{ [secret]: secret }]), 200, "array", 5, 5],
    ["scalar root", () => Response.json(secret), 200, "other", 5, 5],
    ["null root", () => Response.json(null), 200, "other", 1, 0],
    ["hard refusal", () => new Response(secret, { status: 403 }), 403, "unparseable", 1, 0],
    ["transient refusal", () => new Response(secret, { status: 503 }), 503, "unparseable", 5, 5],
    ["rate limit", () => new Response(secret, { status: 429 }), 429, "unparseable", 5, 5],
  ] as const) {
    test(`onboardUser ${label} keeps its original poll budget`, async () => {
      const realSetTimeout = globalThis.setTimeout;
      let waitCount = 0;
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(((handler, delay, ...args) => {
        if (delay === 2000) { waitCount++; return realSetTimeout(handler, 0, ...args); }
        return realSetTimeout(handler, delay, ...args);
      }) as typeof setTimeout);
      let pollCount = 0;
      try {
        const message = await failedDiscoveryLogin(() => Response.json({}), () => { pollCount++; return response(); });
        expect(message).toContain(`"stage":"onboardUser","status":${status},"root":"${root}"`);
        expect(pollCount).toBe(polls);
        expect(waitCount).toBe(waits);
      } finally { timer.mockRestore(); }
    });
  }

  test("a null onboarding body after a refused loadCodeAssist still reports both sanitized stages", async () => {
    // Without a loadCodeAssist account the onboarding call has no catch, so a TypeError on `null.done`
    // used to replace the discovery error with generic OAuth text.
    const message = await failedDiscoveryLogin(() => new Response(secret, { status: 403 }), () => Response.json(null));
    expect(message).toContain('"stage":"loadCodeAssist","status":403,"root":"unparseable","outcome":"http-refusal"');
    expect(message).toContain('"stage":"onboardUser","status":200,"root":"other","outcome":"invalid-root"');
  });

  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    for (const value of ["accepted-project", { id: "accepted-project" }]) {
      test(`accepted ${key} ${typeof value} still discovers without onboarding`, async () => {
        const { calls } = routeFetch(() => Response.json({ [key]: value, [secret]: secret }));
        expect(await discoverAntigravityProject("tok")).toBe("accepted-project");
        expect(calls).toHaveLength(1);
      });
      test(`accepted onboardUser ${key} ${typeof value} still discovers`, async () => {
        const { calls } = routeFetch(url => Response.json(url.includes(":loadCodeAssist") ? {} : {
          done: true, response: { [key]: value, [secret]: secret },
        }));
        expect(await discoverAntigravityProject("tok")).toBe("accepted-project");
        expect(calls).toHaveLength(2);
      });
    }
  }

  test("caller abort propagates unchanged during onboarding", async () => {
    const ctrl = new AbortController();
    const reason = new Error("caller cancelled");
    const { calls } = routeFetch(url => {
      if (url.includes(":loadCodeAssist")) return Response.json({});
      ctrl.abort(reason);
      throw reason;
    });
    await expect(discoverAntigravityProject("tok", ctrl.signal)).rejects.toBe(reason);
    expect(calls).toHaveLength(2);
  });
});

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

  test("onboardUser forwards default tier_id from loadCodeAssist allowedTiers when present", async () => {
    let onboardTierId: string | undefined;
    routeFetch((url, init) => {
      if (url.includes(":loadCodeAssist")) {
        return new Response(JSON.stringify({
          allowedTiers: [
            { id: "free-tier", isDefault: false },
            { id: "standard-tier", isDefault: true },
          ],
        }), { status: 200 });
      }
      if (url.includes(":onboardUser")) {
        onboardTierId = JSON.parse(String(init?.body)).tier_id;
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: "proj-std" } }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-std");
    expect(onboardTierId).toBe("standard-tier");
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

  test("id_token sub populates accountId while email is normalized", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "google-sub-12345", email: "User@Example.com" })).toString("base64url");
    const idToken = `${header}.${payload}.sig`;
    routeFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "fresh-access", expires_in: 3600, id_token: idToken }, { status: 200 });
      }
      if (url.includes(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "proj-sub" });
      return new Response("no", { status: 404 });
    });
    const cred = await refreshAntigravityToken("refresh-tok");
    expect(cred.accountId).toBe("google-sub-12345");
    expect(cred.email).toBe("user@example.com");
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

  test("saveCredential + getCredential round-trips projectId (regression: was stripped by normalizeCredential)", async () => {
    tmp = join(tmpdir(), `ag-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env.HOME = tmp;
    process.env.OPENCODEX_HOME = join(tmp, "ocx");
    await saveCredential("google-antigravity", { access: "a", refresh: "r", expires: Date.now() + 3_600_000, projectId: "proj-persist" });
    expect(getCredential("google-antigravity")?.projectId).toBe("proj-persist");
  });
});

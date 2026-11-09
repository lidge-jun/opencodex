import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { captureApiTarget, configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import { afterOAuthCancellation, cancelOAuthLogin } from "../src/oauth-cancellation-barrier";

const originalFetch = globalThis.fetch;
let win: Window;
let previous: Record<string, unknown>;

function target(base: string) {
  configureApiTargets(standaloneApiTargets(base));
}

beforeEach(() => {
  previous = Object.fromEntries(["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://127.0.0.1:4800/" });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  win.close();
  for (const [key, value] of Object.entries(previous)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

test("an old target's cancellation cannot cancel or block the new target's login", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => { calls.push(String(input)); return Response.json({ ok: true }); }) as typeof fetch;
  target("http://a.example");
  const captureA = captureApiTarget("shared");
  target("http://b.example");
  const captureB = captureApiTarget("shared");

  await cancelOAuthLogin(captureA, "provider");
  expect(calls).toEqual([]);
  let started = false;
  await afterOAuthCancellation(captureB, "provider", () => { started = true; });
  expect(started).toBe(true);
  await cancelOAuthLogin(captureB, "provider");
  expect(calls).toEqual(["http://b.example/api/oauth/login/cancel"]);
});

test("same-target cancellation orders the next login dispatch", async () => {
  const calls: string[] = [];
  let release!: (response: Response) => void;
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return await new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch;
  target("http://a.example");
  const capture = captureApiTarget("shared");
  const cancellation = cancelOAuthLogin(capture, "provider");
  let started = false;
  const next = afterOAuthCancellation(capture, "provider", () => { started = true; });
  await Promise.resolve();
  expect(started).toBe(false);
  release(Response.json({ ok: true }));
  await cancellation;
  await next;
  expect(started).toBe(true);
  expect(calls).toEqual(["http://a.example/api/oauth/login/cancel"]);
});

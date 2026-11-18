import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";
import { configureApiTargets, isApiTargetCaptureCurrent, targetFetch, type ApiTargetCapture } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import { useRenderTargetCapture } from "../src/use-render-target-capture";

/**
 * The capture a surface owns follows its props, not only the logical target key.
 *
 * A relay re-pair to the same hub keeps apiTargetIdentity's key (the hub origin) while the
 * request base and transport move from <machine>/api/machine/hub-relay to the hub itself.
 * Reusing the relay capture there leaves every targetFetch refused until the surface
 * remounts. The opposite must stay true: a module-level target change that has not
 * re-rendered the surface with new props must not retarget its next action.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let seen: ApiTargetCapture | null = null;
let calls: string[] = [];

const HUB = "http://hub-h.example";
const RELAY_BASE = "/same/api/machine/hub-relay";

function relay(apiBase: string, origin: string) {
  const base = standaloneApiTargets(apiBase);
  return {
    ...base,
    connected: true,
    shared: { ...base.shared, baseUrl: apiBase, serverOrigin: origin, transport: "relay" as const },
    apiKeyId: "fixture-key",
    relayTargetCheck: "expected-target-v1" as const,
  };
}

function direct(base: string, origin: string) {
  const targets = standaloneApiTargets(base);
  return {
    ...targets,
    connected: true,
    shared: { ...targets.shared, baseUrl: base, serverOrigin: origin, transport: "direct" as const },
  };
}

function Probe({ apiBase, targetKey }: { apiBase: string; targetKey: string }) {
  const capture = useRenderTargetCapture(apiBase, targetKey);
  useLayoutEffect(() => { seen = capture; });
  return null;
}

async function render(apiBase: string, targetKey: string) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(document.createElement("div"));
    root.render(<Probe apiBase={apiBase} targetKey={targetKey} />);
  });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  originalFetch = globalThis.fetch;
  calls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({});
    },
  });
  seen = null;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  configureApiTargets(standaloneApiTargets(""));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM?.close?.();
});

test("a relay that becomes direct on the same hub starts a new capture", async () => {
  configureApiTargets(relay(RELAY_BASE, HUB));
  await render(RELAY_BASE, HUB);
  expect(seen!.apiBase).toBe(RELAY_BASE);
  expect(seen!.transport).toBe("relay");

  // Same logical key (the hub origin); the request base and transport moved.
  configureApiTargets(direct(HUB, HUB));
  await render(HUB, HUB);

  expect(seen!.apiBase).toBe(HUB);
  expect(seen!.transport).toBe("direct");
  expect(isApiTargetCaptureCurrent(seen!)).toBe(true);
});

test("a module target change without a prop change keeps the old capture and sends nothing", async () => {
  configureApiTargets(relay(RELAY_BASE, HUB));
  await render(RELAY_BASE, HUB);
  const before = seen!;

  configureApiTargets(relay(RELAY_BASE, "http://hub-other.example"));
  await render(RELAY_BASE, HUB);

  expect(seen).toBe(before);
  const response = await targetFetch(seen!, `${RELAY_BASE}/api/codex-auth/active`);
  expect(response.status).toBe(409);
  expect(calls).toEqual([]);
});

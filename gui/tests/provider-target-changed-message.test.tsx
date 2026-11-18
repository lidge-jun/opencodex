import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import type { Root } from "react-dom/client";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import { errorMessageFrom, isTargetChangedError } from "../src/api-error";
import { useProviderAccountPools } from "../src/hooks/useProviderAccountPools";
import * as dialogs from "../src/action-dialogs";

/**
 * A 409 target_changed is a dashboard condition, not server prose. A caller that has already
 * parsed the body must show the localized copy, never the wire token, and must not report
 * the refused action as a success. The capture is current here: the relay answered the 409
 * itself (its legacy preflight found another hub), so the refusal is not a render gap.
 */

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let pools!: ReturnType<typeof useProviderAccountPools>;
let notices: { msg: string; ok?: boolean }[] = [];

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

function Harness() {
  const aliveRef = useRef(true);
  const controller = useProviderAccountPools({
    apiBase: "/same", targetKey: "hub-a", config: null, aliveRef, t: key => key, oauthStatus: {},
    notify: (msg, ok) => { notices.push({ msg, ok }); },
    fetchConfig: async () => {}, fetchOauth: async () => {}, fetchProviderQuotas: async () => {},
    codexActiveNeedsReauth: false,
  });
  useLayoutEffect(() => { pools = controller; });
  return null;
}

async function render() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(document.createElement("div"));
    root.render(<Harness />);
  });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  const win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  originalFetch = globalThis.fetch;
  notices = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET" && url.includes("/api/providers/keys")) {
        return Response.json({ error: "target_changed" }, { status: 409 });
      }
      return Response.json({});
    },
  });
  spyOn(dialogs, "requestTextValue").mockResolvedValue("alias");
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => { current.unmount(); });
  }
  configureApiTargets(standaloneApiTargets(""));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("error body mapping", () => {
  test("target_changed uses the localized copy", () => {
    expect(errorMessageFrom({ error: "target_changed" }, "fallback", "localized")).toBe("localized");
  });

  test("target_changed never leaks the wire token", () => {
    expect(errorMessageFrom({ error: "target_changed" }, "fallback")).toBe("fallback");
  });

  test("other string errors pass through", () => {
    expect(errorMessageFrom({ error: "provider_not_found" }, "fallback", "localized")).toBe("provider_not_found");
  });

  test("empty, missing or non-object bodies use the fallback", () => {
    expect(errorMessageFrom({}, "fallback", "localized")).toBe("fallback");
    expect(errorMessageFrom(null, "fallback", "localized")).toBe("fallback");
    expect(errorMessageFrom("nope", "fallback", "localized")).toBe("fallback");
  });

  test("only the wire token is recognised", () => {
    expect(isTargetChangedError({ error: "target_changed" })).toBe(true);
    expect(isTargetChangedError({ error: "other" })).toBe(false);
    expect(isTargetChangedError(null)).toBe(false);
  });
});

const actions = [
  { name: "addApiKeyValue", run: (p: typeof pools) => p.addApiKeyValue("p", "sk-new") },
  { name: "editCredentialAlias", run: (p: typeof pools) => p.editCredentialAlias("p", "api-key", "k1") },
  { name: "switchApiKey", run: (p: typeof pools) => p.switchApiKey("p", { id: "k1", masked: "sk-1", active: false } as never) },
];

describe("a current capture refused with target_changed", () => {
  for (const action of actions) {
    test(`${action.name} shows the localized copy and no success`, async () => {
      configureApiTargets(relay("/same", "hub-a"));
      await render();
      await act(async () => { await action.run(pools); });
      expect(notices).toEqual([{ msg: "prov.targetChanged", ok: false }]);
    });
  }
});

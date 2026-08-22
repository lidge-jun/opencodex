import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import http2 from "node:http2";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import { EmptyProviderHint } from "../src/pages/models-provider-hints";
import type { ProviderDiscoverySummary } from "../src/models-groups";
import { gatherRoutedModels as gatherRoutedModelsDirect } from "../../src/codex/catalog";
import { withStubbedProviderFetch } from "../../tests/helpers/catalog-provider-fetch";
import {
  clearModelCache,
  getProviderDiscoveryStatus,
  markProviderDiscoveryFailed,
  type ProviderModelDiscoveryStatus,
} from "../../src/codex/model-cache";
import { handleManagementAPI } from "../../src/server/management-api";

let previousLanguage: unknown;
const originalFetch = globalThis.fetch;

/**
 * Discovery runs on the pinned outbound transport, which does not read
 * `globalThis.fetch`. These tests stub that global, so every config gets the
 * caller-owned executor that hands control back to the stub.
 */
const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  clearClientResourceStoresForTests();
  globalThis.fetch = originalFetch;
  clearModelCache();
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

function renderHint(liveModels: boolean, discovery?: ProviderDiscoverySummary): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <EmptyProviderHint liveModels={liveModels} discovery={discovery} />
    </LanguageProvider>,
  );
}

async function providerDto(
  provider: string,
  adapter: "openai-chat" | "cursor" = "openai-chat",
  liveModels = true,
): Promise<Record<string, unknown>> {
  const requestUrl = new URL("http://127.0.0.1/api/providers");
  const response = await handleManagementAPI(
    new Request(requestUrl, { headers: { Host: requestUrl.host } }),
    requestUrl,
    {
      providers: {
        [provider]: {
          adapter,
          baseUrl: adapter === "cursor" ? "https://api2.cursor.sh" : "https://api.example.test/v1",
          liveModels,
          models: [],
        },
      },
    },
  );
  const providers = await response!.json() as Array<Record<string, unknown>>;
  return providers[0] ?? {};
}

test("Models page combines final visibility, atomic actions, discovery status, and serialized polling", async () => {
  const domGlobals = ["document", "window", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT", "setInterval", "clearInterval"] as const;
  const previousDescriptors = Object.fromEntries(
    domGlobals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  let root: Root | undefined;
  const polls: Array<() => void> = [];
  const recordPoll = (handler: () => void) => {
    polls.push(handler);
    return polls.length;
  };
  const poll = () => { for (const handler of polls) handler(); };
  Object.defineProperty(testWindow, "setInterval", {
    configurable: true,
    value: recordPoll,
  });

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    setInterval: { configurable: true, value: recordPoll },
    clearInterval: { configurable: true, value: () => {} },
  });
  testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));
  const provider = "fallback-provider";
  const ids = ["claude-opus", "claude-sonnet", "gemini-pro", "gemini-flash", "gpt-oss"];
  let selected = ["gemini-pro", "gemini-flash"];
  const disabled = new Set(["gpt-oss"]);
  const visibilityBodies: Array<{ scope: string; targets: Array<{ id: string }>; enabled: boolean }> = [];
  const contextBodies: Array<{
    contextWindow: number | null;
    modelContextWindows: Record<string, number | null>;
  }> = [];
  let providerContextWindow: number | undefined = 256_000;
  // `retired-model` is deliberately NOT in `ids` and not a configured model: it only exists as
  // an override. Without merging the override keys into the picker it would be invisible and
  // unclearable, and an assertion using `claude-opus` alone could not tell the difference.
  let providerModelContextWindows: Record<string, number> = {
    "claude-opus": 64_000,
    "retired-model": 72_000,
  };
  let failNext = false;
  let failCatalog = false;
  let modelFetches = 0;
  let resolveModels!: (response: Response) => void;
  const firstModels = new Promise<Response>(resolve => { resolveModels = resolve; });
  const rows = () => ids.map(id => ({ provider, id, namespaced: `${provider}/${id}`, disabled: disabled.has(id) }));
  testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
    models: rows(),
    providers: [{ name: provider, liveModels: true, models: ids }],
    selectedModels: { [provider]: selected },
    disabled: [...disabled],
    contextCaps: {},
    contextCapValue: 350_000,
  }));
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/models")) {
      modelFetches += 1;
      if (failCatalog) return Response.json({ error: "offline" }, { status: 503 });
      return modelFetches === 1 ? firstModels : Response.json(rows());
    }
    if (url.endsWith("/api/providers")) {
      return Response.json([{
        name: provider,
        liveModels: true,
        models: ids,
        contextWindow: providerContextWindow,
        modelContextWindows: providerModelContextWindows,
        discovery: { status: "failed", reason: "http", httpStatus: 401 },
      }]);
    }
    if (url.includes("/api/providers?name=") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as (typeof contextBodies)[number];
      contextBodies.push(body);
      if (body.contextWindow === null) providerContextWindow = undefined;
      else if (typeof body.contextWindow === "number") providerContextWindow = body.contextWindow;
      for (const [model, value] of Object.entries(body.modelContextWindows ?? {})) {
        if (value === null) delete providerModelContextWindows[model];
        else providerModelContextWindows = { ...providerModelContextWindows, [model]: value };
      }
      return Response.json({ success: true });
    }
    if (url.endsWith("/api/selected-models")) return Response.json({ selected: { [provider]: selected }, available: { [provider]: ids } });
    if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
    if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
    if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: true, model: `${provider}/gemini-pro` });
    if (url.endsWith("/api/model-visibility") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as (typeof visibilityBodies)[number];
      visibilityBodies.push(body);
      if (failNext) { failNext = false; return Response.json({ error: "failed" }, { status: 500 }); }
      if (body.scope === "provider") {
        if (body.enabled) { selected = []; disabled.clear(); }
        else for (const target of body.targets) disabled.add(target.id);
      } else for (const target of body.targets) {
        if (body.enabled) { if (selected.length > 0 && !selected.includes(target.id)) selected.push(target.id); disabled.delete(target.id); }
        else disabled.add(target.id);
      }
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <Models apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => {
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("fallback-provider");
    poll();
    expect(modelFetches).toBe(1);
    await act(async () => {
      resolveModels(Response.json(rows()));
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    const switchFor = (id: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${provider}/${id}"]`)!;
    const buttonText = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
    expect(container.textContent).toContain("2/5 visible");
    expect(switchFor("gemini-pro").getAttribute("aria-pressed")).toBe("true");
    expect(switchFor("claude-sonnet").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".badge.badge-amber")?.textContent).toContain("Discovery failed");
    expect(container.textContent).not.toContain("Not selected");

    await act(async () => buttonText("Custom windows").click());
    const contextDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Custom windows"]')!;
    const contextInputs = contextDialog.querySelectorAll<HTMLInputElement>("input");
    expect([...contextInputs].map(input => input.value)).toEqual(["256000", "64000"]);
    const setValue = Object.getOwnPropertyDescriptor(
      testWindow.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(contextInputs[0]!, "350000");
      contextInputs[0]!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
      setValue.call(contextInputs[1]!, "100000");
      contextInputs[1]!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    const pickContextModel = async (modelId: string, dialog: HTMLElement = contextDialog) => {
      await act(async () => {
        dialog.querySelector<HTMLButtonElement>('button.select-trigger[aria-label="Model"]')!.click();
      });
      const option = [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find(candidate => candidate.textContent === modelId)!;
      await act(async () => option.click());
    };
    await pickContextModel("claude-sonnet");
    expect(contextInputs[1]!.value).toBe("");
    await act(async () => {
      setValue.call(contextInputs[1]!, "80000");
      contextInputs[1]!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    await pickContextModel("claude-opus");
    expect(contextInputs[1]!.value).toBe("100000");
    await pickContextModel("claude-sonnet");
    expect(contextInputs[1]!.value).toBe("80000");
    // An override for a model that live discovery no longer returns must still be selectable,
    // or the user can neither see nor clear it.
    await pickContextModel("retired-model");
    expect(contextInputs[1]!.value).toBe("72000");
    await pickContextModel("claude-opus");
    const applyContext = [...contextDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Apply")!;
    await act(async () => {
      applyContext.click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    });
    // Both edits must survive. This assertion previously named only `claude-opus`, which
    // pinned the defect as correct behaviour: the user typed 80000 into claude-sonnet, moved
    // the picker to claude-opus, hit Apply, and the sonnet value vanished with no error.
    //
    // `gemini-pro` is absent because it was never typed into. The payload follows what the
    // user TOUCHED, not what differs from current state — a poll refreshing an untouched
    // model mid-modal must not make Apply revert it.
    expect(contextBodies.at(-1)).toEqual({
      contextWindow: 350_000,
      modelContextWindows: { "claude-opus": 100_000, "claude-sonnet": 80_000 },
    });
    expect(container.querySelector('[role="dialog"][aria-label="Custom windows"]')).toBeNull();

    await act(async () => buttonText("Custom windows").click());
    const refreshFailureDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Custom windows"]')!;
    failCatalog = true;
    // Make an actual edit. Apply now compares against the values the modal opened with, so a
    // reopened-and-untouched dialog sends nothing — which would leave this case asserting the
    // refresh behaviour of a request that never happened.
    const refreshFailureInput = refreshFailureDialog.querySelectorAll<HTMLInputElement>("input.input")[0]!;
    await act(async () => {
      setValue.call(refreshFailureInput, "360000");
      refreshFailureInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...refreshFailureDialog.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Apply")!
        .click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    });
    expect(contextBodies).toHaveLength(2);
    expect(contextBodies.at(-1)).toEqual({ contextWindow: 360_000 });
    expect(container.querySelector('[role="dialog"][aria-label="Custom windows"]')).toBeNull();
    expect(container.textContent).toContain("Context windows updated");
    failCatalog = false;

    // An edit that is typed and then restored is not a change — and neither is retyping the
    // same number in a different shape. Comparing raw text instead of parsed values would
    // treat "64,000" as an edit and stamp a stale number over whatever else moved.
    await act(async () => buttonText("Custom windows").click());
    const revertDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Custom windows"]')!;
    const revertInput = revertDialog.querySelectorAll<HTMLInputElement>("input.input")[0]!;
    const openingValue = revertInput.value;
    await act(async () => {
      setValue.call(revertInput, "999000");
      revertInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
      setValue.call(revertInput, openingValue);
      revertInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...revertDialog.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Apply")!
        .click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    });
    expect(contextBodies).toHaveLength(2);
    expect(container.querySelector('[role="dialog"][aria-label="Custom windows"]')).toBeNull();

    await act(async () => buttonText("Custom windows").click());
    const reformatDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Custom windows"]')!;
    const reformatInput = reformatDialog.querySelectorAll<HTMLInputElement>("input.input")[0]!;
    const commaFormatted = reformatInput.value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    await act(async () => {
      setValue.call(reformatInput, commaFormatted);
      reformatInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    // The per-model branch has its own comparison, so exercise it too: a raw-string mutant
    // reverted only there would otherwise slip past the provider-default case above.
    await pickContextModel("claude-opus", reformatDialog);
    const reformatModelInput = reformatDialog.querySelectorAll<HTMLInputElement>("input.input")[1]!;
    await act(async () => {
      setValue.call(
        reformatModelInput,
        reformatModelInput.value.replace(/\B(?=(\d{3})+(?!\d))/g, "_"),
      );
      reformatModelInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...reformatDialog.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Apply")!
        .click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    });
    expect(contextBodies).toHaveLength(2);

    // A value the user never touched must not ride along, even after a real poll refreshed it.
    // The poll has to actually run: mutating the mock alone leaves React's `groups` on the
    // opening values, and then comparing drafts against LIVE state — the defect — would look
    // identical to comparing against the snapshot.
    await act(async () => buttonText("Custom windows").click());
    const concurrentDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Custom windows"]')!;
    providerContextWindow = 300_000;
    providerModelContextWindows = { ...providerModelContextWindows, "claude-opus": 96_000 };
    await act(async () => { poll(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    // Edit ONLY claude-sonnet. The refreshed default and the refreshed claude-opus are both
    // untouched, so neither may appear in the payload.
    await pickContextModel("claude-sonnet", concurrentDialog);
    const concurrentModelInput = concurrentDialog.querySelectorAll<HTMLInputElement>("input.input")[1]!;
    await act(async () => {
      setValue.call(concurrentModelInput, "70000");
      concurrentModelInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...concurrentDialog.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Apply")!
        .click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    });
    expect(contextBodies).toHaveLength(3);
    expect(contextBodies.at(-1)).toEqual({ modelContextWindows: { "claude-sonnet": 70_000 } });

    // The precise mutant this defends: keep the `touched` guard but compare against the LIVE
    // `groups` instead of the opening snapshot. The cases above cannot see that swap, because
    // in each of them the user's value genuinely differs from both. This one does — the user
    // touches a field and puts it back, while the server moves underneath.
    await act(async () => buttonText("Custom windows").click());
    const staleDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Custom windows"]')!;
    const staleDefaultInput = staleDialog.querySelectorAll<HTMLInputElement>("input.input")[0]!;
    const staleOpeningDefault = staleDefaultInput.value;
    await act(async () => {
      setValue.call(staleDefaultInput, "111000");
      staleDefaultInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
      setValue.call(staleDefaultInput, staleOpeningDefault);
      staleDefaultInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    await pickContextModel("claude-opus", staleDialog);
    const staleModelInput = staleDialog.querySelectorAll<HTMLInputElement>("input.input")[1]!;
    const staleOpeningModel = staleModelInput.value;
    await act(async () => {
      setValue.call(staleModelInput, "123000");
      staleModelInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
      // Restored, and also reformatted — the value is unchanged either way.
      setValue.call(staleModelInput, staleOpeningModel.replace(/\B(?=(\d{3})+(?!\d))/g, "_"));
      staleModelInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    // Now the server moves both fields, and the poll lands while the modal is still open.
    providerContextWindow = 411_000;
    providerModelContextWindows = { ...providerModelContextWindows, "claude-opus": 88_000 };
    await act(async () => { poll(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    await act(async () => {
      [...staleDialog.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Apply")!
        .click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    });
    // Nothing was written: both fields are back at what the modal opened with. Comparing
    // against the refreshed `groups` would have called both dirty and reverted 411K and 88K.
    expect(contextBodies).toHaveLength(3);
    expect(container.textContent).toContain("No context window changes to save");

    // A default the user never touches must not block a per-model save, even when the stored
    // value is one the validator would reject. Validating it unconditionally would strand
    // anyone whose config was hand-edited before the safe-integer bound existed.
    providerContextWindow = 1e100;
    await act(async () => { poll(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    await act(async () => buttonText("Custom windows").click());
    const unsafeDefaultDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Custom windows"]')!;
    await pickContextModel("claude-sonnet", unsafeDefaultDialog);
    const unsafeSiblingInput = unsafeDefaultDialog.querySelectorAll<HTMLInputElement>("input.input")[1]!;
    await act(async () => {
      setValue.call(unsafeSiblingInput, "55000");
      unsafeSiblingInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...unsafeDefaultDialog.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Apply")!
        .click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    });
    expect(contextBodies.at(-1)).toEqual({ modelContextWindows: { "claude-sonnet": 55_000 } });

    // `Number.isInteger(1e100)` is true, and the server rejects it. Accepting it in the form
    // would turn a typo into a round-trip error instead of inline feedback.
    const patchesBeforeUnsafe = contextBodies.length;
    await act(async () => buttonText("Custom windows").click());
    const unsafeDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Custom windows"]')!;
    const unsafeInput = unsafeDialog.querySelectorAll<HTMLInputElement>("input.input")[0]!;
    await act(async () => {
      setValue.call(unsafeInput, "1e100");
      unsafeInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...unsafeDialog.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Apply")!
        .click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    });
    // Relative, not absolute: an absolute count silently re-targets whenever a case is added
    // above, and the property under test is "this Apply wrote nothing".
    expect(contextBodies).toHaveLength(patchesBeforeUnsafe);
    expect(container.querySelector('[role="dialog"][aria-label="Custom windows"]')).not.toBeNull();
    // The modal staying open is not the point — the user has to be TOLD why. Without this the
    // test passes on a silent no-op that looks identical to a hang.
    expect(unsafeDialog.textContent).toContain("Context windows must be positive whole numbers");
    await act(async () => {
      [...unsafeDialog.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Cancel")?.click();
    });

    await act(async () => container.querySelector<HTMLButtonElement>('button.select-trigger[aria-label="Shadow Call Intercept"]')?.click());
    // The workspace Select portals its listbox to document.body, so the options are not inside
    // `container`. Query the document instead of the mount node.
    const shadowOptions = [...testWindow.document.querySelectorAll('[role="option"]')].map(option => option.textContent);
    expect(shadowOptions).toContain(`${provider}/gemini-pro`);
    expect(shadowOptions).not.toContain(`${provider}/claude-opus`);

    await act(async () => { switchFor("claude-sonnet").click(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    expect(visibilityBodies.at(-1)).toMatchObject({ scope: "models", targets: [{ id: "claude-sonnet" }], enabled: true });
    expect(container.textContent).toContain("3/5 visible");

    failNext = true;
    await act(async () => { switchFor("claude-opus").click(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    expect(switchFor("claude-opus").getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("Save failed");

    await act(async () => { buttonText("All on").click(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    expect(visibilityBodies.at(-1)).toMatchObject({ scope: "provider", enabled: true });
    expect(container.textContent).toContain("5/5 visible");
    await act(async () => { buttonText("All off").click(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    expect(visibilityBodies.at(-1)).toMatchObject({ scope: "provider", enabled: false });
    expect(container.textContent).toContain("0/5 visible");

    // A failed poll must keep the catalog on screen but make the stale state visible.
    failCatalog = true;
    await act(async () => { poll(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("fallback-provider");
    expect(container.textContent).toContain("Failed to load models");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    testWindow.close();
    for (const key of domGlobals) {
      const descriptor = previousDescriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

async function withCursorDiscoveryServer<T>(
  status: number,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http2.createServer();
  server.on("stream", stream => {
    stream.respond({ ":status": status, "content-type": "application/proto" });
    stream.end();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP/2 fixture did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("empty live-discovery provider renders endpoint guidance and a settings link", () => {
  const html = renderHint(true, { status: "ok" });
  expect(html).toContain("No models were discovered");
  expect(html).toContain('class="link-btn"');
  expect(html).toContain("Open provider settings");
  expect(html).not.toContain("Discovery failed");
});

test("failed HTTP discovery renders an amber status badge and reason", () => {
  const html = renderHint(true, { status: "failed", reason: "http", httpStatus: 401 });
  expect(html).toContain("Discovery failed");
  expect(html).toContain("HTTP 401");
  expect(html).toContain('class="badge badge-amber"');
  expect(html).toContain('role="status"');
  expect(html).toContain('class="link-btn"');
});

test("failed discovery renders each server-owned reason without provider detail", () => {
  const cases: Array<[ProviderDiscoverySummary, string]> = [
    [{ status: "failed", reason: "blocked" }, "blocked by the destination policy"],
    [{ status: "failed", reason: "invalid_response" }, "returned an invalid response"],
    [{ status: "failed", reason: "network" }, "due to a network error"],
    [{ status: "failed", reason: "provider" }, "provider reported a model discovery error"],
  ];

  for (const [discovery, reason] of cases) {
    const html = renderHint(true, discovery);
    expect(html).toContain("Discovery failed");
    expect(html).toContain(reason);
    expect(html).toContain("Open provider settings");
  }
});

test("HTTP 401 discovery exposes HTTP status and badge", async () => {
  const provider = "activation-http-401";
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;

  await gatherRoutedModels({
    providers: {
      [provider]: {
        adapter: "openai-chat",
        baseUrl: "https://93.184.216.34/v1",
        apiKey: "sk-test",
      },
    },
  });

  const discovery = { status: "failed", reason: "http", httpStatus: 401 } as const;
  expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
  expect(await providerDto(provider)).toMatchObject({ discovery });
  const html = renderHint(true, discovery);
  expect(html).toContain("Discovery failed");
  expect(html).toContain("HTTP 401");
  expect(html).toContain('class="link-btn"');
});

test("destination-blocked discovery exposes blocked status and badge", async () => {
  const provider = "activation-blocked";
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ data: [] });
  }) as typeof fetch;

  const models = await gatherRoutedModels({
    providers: {
      [provider]: {
        adapter: "openai-chat",
        baseUrl: "http://198.18.0.1/v1",
        apiKey: "sk-test",
        models: ["static-fallback"],
      },
    },
  });

  const discovery = { status: "failed", reason: "blocked" } as const;
  expect(fetchCalls).toBe(0);
  expect(models.map(model => model.id)).toEqual(["static-fallback"]);
  expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
  expect(await providerDto(provider)).toMatchObject({ discovery });
  const html = renderHint(true, discovery);
  expect(html).toContain("Discovery failed");
  expect(html).toContain("blocked by the destination policy");
  expect(html).toContain('class="link-btn"');
});

test("invalid JSON or malformed model data exposes invalid-response status and badge", async () => {
  const fixtures = [
    { name: "invalid-json", body: "{not-json" },
    { name: "missing-data", body: JSON.stringify({ models: [] }) },
    { name: "malformed-data", body: JSON.stringify({ data: [{ id: 42 }] }) },
  ];

  for (const fixture of fixtures) {
    const provider = `activation-${fixture.name}`;
    globalThis.fetch = (async () => new Response(fixture.body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const models = await gatherRoutedModels({
      providers: {
        [provider]: {
          adapter: "openai-chat",
          baseUrl: "https://93.184.216.34/v1",
          apiKey: "sk-test",
          models: ["static-fallback"],
        },
      },
    });

    const discovery = { status: "failed", reason: "invalid_response" } as const;
    expect(models.map(model => model.id)).toEqual(["static-fallback"]);
    expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
    expect(await providerDto(provider)).toMatchObject({ discovery });
    const html = renderHint(true, discovery);
    expect(html).toContain("Discovery failed");
    expect(html).toContain("returned an invalid response");
    clearModelCache(provider);
  }
});

test("network discovery failure exposes sanitized network status and badge", async () => {
  const provider = "activation-network";
  const sentinel = "SENTINEL-PRIVATE-URL-https://secret.invalid/account";
  globalThis.fetch = (async () => {
    throw new TypeError(sentinel);
  }) as typeof fetch;

  await gatherRoutedModels({
    providers: {
      [provider]: {
        adapter: "openai-chat",
        baseUrl: "https://93.184.216.34/v1",
        apiKey: "sk-test",
      },
    },
  });

  const discovery = { status: "failed", reason: "network" } as const;
  expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
  const dto = await providerDto(provider);
  expect(dto).toMatchObject({ discovery });
  const html = renderHint(true, discovery);
  expect(html).toContain("Discovery failed");
  expect(html).toContain("due to a network error");
  expect(JSON.stringify(dto)).not.toContain(sentinel);
  expect(html).not.toContain(sentinel);
});

test("Cursor discovery failure exposes provider status and badge", async () => {
  const provider = "activation-cursor";
  const rawDetail = "HTTP 401";
  const models = await withCursorDiscoveryServer(401, baseUrl => gatherRoutedModels({
    providers: {
      [provider]: {
        adapter: "cursor",
        baseUrl,
        apiKey: "bad-token",
        models: ["auto"],
      },
    },
  }));

  const discovery = { status: "failed", reason: "provider" } as const;
  expect(models.map(model => model.id)).toEqual(["auto"]);
  expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
  const dto = await providerDto(provider, "cursor");
  expect(dto).toMatchObject({ discovery });
  const html = renderHint(true, discovery);
  expect(html).toContain("Discovery failed");
  expect(html).toContain("provider reported a model discovery error");
  expect(JSON.stringify(dto)).not.toContain(rawDetail);
  expect(html).not.toContain(rawDetail);
});

test("successful discovery clears every prior failure reason", async () => {
  const provider = "activation-reset";
  const failures: Array<Extract<ProviderModelDiscoveryStatus, { status: "failed" }>> = [
    { status: "failed", reason: "blocked" },
    { status: "failed", reason: "http", httpStatus: 401 },
    { status: "failed", reason: "invalid_response" },
    { status: "failed", reason: "network" },
    { status: "failed", reason: "provider" },
  ];
  globalThis.fetch = (async () => Response.json({ data: [] })) as typeof fetch;

  for (const { status: _status, ...failure } of failures) {
    markProviderDiscoveryFailed(provider, failure);
    await gatherRoutedModels({
      modelCacheTtlMs: 0,
      providers: {
        [provider]: {
          adapter: "openai-chat",
          baseUrl: "https://93.184.216.34/v1",
          apiKey: "sk-test",
        },
      },
    });

    const discovery = { status: "ok" } as const;
    expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
    expect(await providerDto(provider)).toMatchObject({ discovery });
    const html = renderHint(true, discovery);
    expect(html).toContain("No models were discovered");
    expect(html).not.toContain("Discovery failed");
  }

  clearModelCache(provider);
  expect(getProviderDiscoveryStatus(provider)).toBeUndefined();
  expect(await providerDto(provider)).not.toHaveProperty("discovery");
});

test("static catalog paths clear stale discovery failures and omit them from the API", async () => {
  for (const adapter of ["openai-chat", "cursor"] as const) {
    const provider = `static-${adapter}`;
    markProviderDiscoveryFailed(provider, { reason: "http", httpStatus: 401 });
    expect(await providerDto(provider, adapter, false)).not.toHaveProperty("discovery");

    const models = await gatherRoutedModels({
      modelCacheTtlMs: 0,
      providers: {
        [provider]: {
          adapter,
          baseUrl: adapter === "cursor" ? "https://api2.cursor.sh" : "https://api.example.test/v1",
          liveModels: false,
          models: ["configured-fallback"],
        },
      },
    });

    expect(models.map(model => model.id)).toEqual(["configured-fallback"]);
    expect(getProviderDiscoveryStatus(provider)).toBeUndefined();
    expect(await providerDto(provider, adapter, false)).not.toHaveProperty("discovery");
  }
});

test("empty static provider explains that live discovery is disabled", () => {
  const html = renderHint(false);
  expect(html).toContain("Live model discovery is off");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("Discovery failed");
});

// The generation guard only matters when a poll that started BEFORE a forced refresh finishes
// AFTER it. The single-flight test above never reaches that ordering, so a regression in
// shouldApplyLoadGeneration() would still pass. Drive the real order here: initial load settles,
// a poll fetch is held pending, a toggle's forced refresh completes, and only then does the stale
// poll resolve with outdated rows.
test("a poll that resolves after a forced refresh cannot overwrite newer models", async () => {
  // Snapshot the globals this test swaps out: leaking a torn-down happy-dom document breaks every
  // later DOM test in the suite.
  const priorGlobals = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
    actEnv: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
    setInterval: Object.getOwnPropertyDescriptor(globalThis, "setInterval"),
    clearInterval: Object.getOwnPropertyDescriptor(globalThis, "clearInterval"),
  };
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  let root: Root | undefined;
  const polls: Array<() => void> = [];
  const recordPoll = (handler: () => void) => {
    polls.push(handler);
    return polls.length;
  };
  const poll = () => { for (const handler of polls) handler(); };
  Object.defineProperty(testWindow, "setInterval", {
    configurable: true,
    value: recordPoll,
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    setInterval: { configurable: true, value: recordPoll },
    clearInterval: { configurable: true, value: () => {} },
  });
  testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));

  const provider = "gen-provider";
  const staleIds = ["stale-a", "stale-b"];
  const freshIds = ["fresh-a", "fresh-b", "fresh-c"];
  const rowsFor = (ids: string[]) => ids.map(id => ({ provider, id, namespaced: `${provider}/${id}`, disabled: false }));
  let modelFetches = 0;
  let releaseStalePoll!: () => void;
  const stalePollBody = new Promise<void>(resolve => { releaseStalePoll = resolve; });

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/models")) {
      modelFetches += 1;
      // 1st: initial load. 2nd: the poll we hold open. 3rd+: the forced refresh after the toggle.
      if (modelFetches === 2) {
        await stalePollBody;
        return Response.json(rowsFor(staleIds));
      }
      return Response.json(rowsFor(modelFetches === 1 ? staleIds : freshIds));
    }
    if (url.endsWith("/api/providers")) return Response.json([{ name: provider, liveModels: false, models: freshIds }]);
    if (url.endsWith("/api/selected-models")) {
      const ids = modelFetches <= 1 ? staleIds : freshIds;
      return Response.json({ selected: { [provider]: ids }, available: { [provider]: ids } });
    }
    if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
    if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
    if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
    if (url.endsWith("/api/model-visibility") && init?.method === "PUT") return Response.json({ ok: true });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <Models apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); await Promise.resolve(); });
    expect(container.textContent).toContain("stale-a");

    // Start the poll and leave its /api/models response pending.
    await act(async () => { poll(); await Promise.resolve(); });
    expect(modelFetches).toBe(2);

    // A forced refresh finishes while that poll is still in flight and brings the newer catalog.
    const toggle = container.querySelector<HTMLButtonElement>(`button[aria-label="${provider}/stale-a"]`);
    await act(async () => { toggle?.click(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("fresh-a");

    // Now let the stale poll land. Its generation is older, so it must be discarded.
    await act(async () => {
      releaseStalePoll();
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("fresh-a");
    expect(container.textContent).not.toContain("stale-b");
  } finally {
    await act(async () => { root?.unmount(); });
    container.remove();
    for (const [key, descriptor] of [
      ["document", priorGlobals.document],
      ["window", priorGlobals.window],
      ["localStorage", priorGlobals.localStorage],
      ["sessionStorage", priorGlobals.sessionStorage],
      ["IS_REACT_ACT_ENVIRONMENT", priorGlobals.actEnv],
      ["setInterval", priorGlobals.setInterval],
      ["clearInterval", priorGlobals.clearInterval],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

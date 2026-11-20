import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { ProvidersPageModals } from "../src/pages/providers-page-modals";

/**
 * #8849: the Add Provider modal listens for Escape on window. Dialogs the providers page opens on top
 * of it (the OAuth risk warning from an Accounts-tab login, the Codex login, the remove and
 * unsaved-changes confirmations) are owned by the page, so the modal's guard could not see them and
 * one Escape closed both layers. Escape must unwind one layer at a time.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
const calls = { closeAdd: 0, cancelTos: 0, closeCodex: 0, cancelRemove: 0, cancelJsonLeave: 0 };

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: [] });
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: [] });
      if (url.pathname === "/api/usage") return Response.json({ providers: [] });
      return Response.json({});
    },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

type Overlays = {
  oauthTosPending?: { provider: string; addAccount: boolean } | null;
  codexLoginOpen?: boolean;
  removeConfirmName?: string | null;
  jsonLeaveOpen?: boolean;
};

function page(overlays: Overlays) {
  return (
    <LanguageProvider>
      <ProvidersPageModals
        apiBase=""
        config={{ providers: { existing: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } } as never}
        adding
        addIntent={null}
        busy={null}
        addModalAccountRows={[]}
        accountLoginStatus={{}}
        removeConfirmName={overlays.removeConfirmName ?? null}
        removeDefaultProvider={null}
        codexLoginOpen={overlays.codexLoginOpen ?? false}
        jsonLeaveOpen={overlays.jsonLeaveOpen ?? false}
        jsonSaving={false}
        oauthTosPending={overlays.oauthTosPending ?? null}
        onCloseAdd={() => { calls.closeAdd += 1; }}
        onAdded={() => {}}
        onAccountLogin={() => {}}
        onAccountCancelLogin={() => {}}
        onAccountLogout={() => {}}
        onOpenAdd={() => {}}
        onCloseCodexLogin={() => { calls.closeCodex += 1; }}
        onCodexAdded={() => {}}
        onCancelRemove={() => { calls.cancelRemove += 1; }}
        onConfirmRemove={() => {}}
        onCancelJsonLeave={() => { calls.cancelJsonLeave += 1; }}
        onDiscardJson={() => {}}
        onSaveJson={() => {}}
        onCancelOauthTos={() => { calls.cancelTos += 1; }}
        onContinueOauthTos={() => {}}
      />
    </LanguageProvider>
  );
}

async function render(overlays: Overlays) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(page(overlays));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

/** What a browser does on Escape: the topmost native dialog gets "cancel", and the keydown reaches window. */
async function pressEscape() {
  await act(async () => {
    const dialogs = [...win.document.querySelectorAll("dialog")].filter(dialog => (dialog as unknown as HTMLDialogElement).open);
    const top = dialogs.at(-1);
    top?.dispatchEvent(new win.Event("cancel", { cancelable: true }));
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

test("Escape on the OAuth risk warning closes only the warning", async () => {
  await render({ oauthTosPending: { provider: "anthropic", addAccount: false } });
  await pressEscape();
  expect(calls.cancelTos).toBe(1);
  expect(calls.closeAdd).toBe(0);
  // The page drops the warning; the next Escape closes Add Provider.
  await render({});
  await pressEscape();
  expect(calls.closeAdd).toBe(1);
});

test("Escape on the Codex login closes only the Codex login", async () => {
  await render({ codexLoginOpen: true });
  await pressEscape();
  expect(calls.closeCodex).toBe(1);
  expect(calls.closeAdd).toBe(0);
});

for (const overlay of [{ removeConfirmName: "existing" }, { jsonLeaveOpen: true }] as const) {
  test(`Add Provider stays open under ${Object.keys(overlay)[0]}`, async () => {
    await render(overlay);
    await pressEscape();
    expect(calls.closeAdd).toBe(0);
  });
}

test("with no page overlay, Escape closes Add Provider", async () => {
  await render({});
  await pressEscape();
  expect(calls.closeAdd).toBe(1);
});

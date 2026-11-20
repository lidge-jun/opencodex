import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { ProvidersPageModals } from "../src/pages/providers-page-modals";
import { UnsavedLeaveDialog } from "../src/components/provider-workspace/ProviderDialogs";

/**
 * #8849: the Add Provider modal listens for Escape on window. Dialogs the providers page opens on top
 * of it (the OAuth risk warning from an Accounts-tab login, the Codex login, the remove and
 * unsaved-changes confirmations) are owned by the page, so the modal's guard could not see them and
 * one Escape closed both layers. Escape must unwind one layer at a time: the top dialog first, then
 * Add Provider.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

type Overlay = "oauthTos" | "codexLogin" | "removeConfirm" | "jsonLeave" | null;
const events: string[] = [];

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
  events.length = 0;
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

/** The providers page's own state for these layers: every cancel really closes its overlay. */
function Page({ initial, saving = false }: { initial: Overlay; saving?: boolean }) {
  const [adding, setAdding] = useState(true);
  const [overlay, setOverlay] = useState<Overlay>(initial);
  const close = (name: string) => () => { events.push(name); setOverlay(null); };
  return (
    <LanguageProvider>
      <ProvidersPageModals
        apiBase=""
        config={{ providers: { existing: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } } as never}
        adding={adding}
        addIntent={null}
        busy={null}
        addModalAccountRows={[]}
        accountLoginStatus={{}}
        removeConfirmName={overlay === "removeConfirm" ? "existing" : null}
        removeDefaultProvider={null}
        codexLoginOpen={overlay === "codexLogin"}
        jsonLeaveOpen={overlay === "jsonLeave"}
        jsonSaving={saving}
        oauthTosPending={overlay === "oauthTos" ? { provider: "anthropic", addAccount: false } : null}
        onCloseAdd={() => { events.push("closeAdd"); setAdding(false); }}
        onAdded={() => {}}
        onAccountLogin={() => {}}
        onAccountCancelLogin={() => {}}
        onAccountLogout={() => {}}
        onOpenAdd={() => {}}
        onCloseCodexLogin={close("closeCodexLogin")}
        onCodexAdded={() => {}}
        onCancelRemove={close("cancelRemove")}
        onConfirmRemove={() => {}}
        onCancelJsonLeave={() => { if (!saving) close("cancelJsonLeave")(); }}
        onDiscardJson={() => {}}
        onSaveJson={() => {}}
        onCancelOauthTos={close("cancelOauthTos")}
        onContinueOauthTos={() => {}}
      />
    </LanguageProvider>
  );
}

async function render(initial: Overlay, saving = false) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Page initial={initial} saving={saving} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

/**
 * Escape in browser order: the keydown reaches the focused element and bubbles to window first;
 * unless a handler prevented it, the topmost open native <dialog> then receives "cancel".
 */
async function pressEscape() {
  await act(async () => {
    const target = (win.document.activeElement ?? win.document.body) as unknown as EventTarget;
    const keydown = new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    target.dispatchEvent(keydown as never);
    if (!keydown.defaultPrevented) {
      const open = [...win.document.querySelectorAll("dialog")].filter(dialog => (dialog as unknown as HTMLDialogElement).open);
      open.at(-1)?.dispatchEvent(new win.Event("cancel", { cancelable: true }));
    }
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function addProviderOpen(): boolean {
  return [...host.querySelectorAll(".modal-overlay")].some(el => el.tagName === "DIV");
}

for (const [overlay, cancel] of [
  ["oauthTos", "cancelOauthTos"],
  ["codexLogin", "closeCodexLogin"],
  ["removeConfirm", "cancelRemove"],
  ["jsonLeave", "cancelJsonLeave"],
] as const) {
  test(`Escape over ${overlay} closes that dialog first, then Add Provider`, async () => {
    await render(overlay);
    await pressEscape();
    expect(events).toEqual([cancel]);
    expect(addProviderOpen()).toBe(true);
    await pressEscape();
    expect(events).toEqual([cancel, "closeAdd"]);
    expect(addProviderOpen()).toBe(false);
  });
}

test("Escape cannot abandon the unsaved-changes dialog while its save is in flight", async () => {
  await render("jsonLeave", true);
  await pressEscape();
  expect(events).toEqual([]);
  expect(addProviderOpen()).toBe(true);
});

test("with no page overlay, Escape closes Add Provider", async () => {
  await render(null);
  await pressEscape();
  expect(events).toEqual(["closeAdd"]);
});

/**
 * Layers owned by different parts of the page at once: the workspace Settings tab's unsaved-changes
 * confirmation (mounted in the page body, beneath the modals) stays open while Add Provider opens,
 * optionally with the OAuth warning above it. Each Escape belongs to the topmost layer only.
 */
function Workspace({ warning }: { warning: boolean }) {
  const [settingsLeave, setSettingsLeave] = useState(true);
  const [adding, setAdding] = useState(true);
  const [tos, setTos] = useState(warning);
  return (
    <LanguageProvider>
      {settingsLeave && (
        <UnsavedLeaveDialog
          onSave={() => {}}
          onDiscard={() => {}}
          onCancel={() => { events.push("cancelSettingsLeave"); setSettingsLeave(false); }}
        />
      )}
      <ProvidersPageModals
        apiBase=""
        config={{ providers: { existing: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } } as never}
        adding={adding}
        addIntent={null}
        busy={null}
        addModalAccountRows={[]}
        accountLoginStatus={{}}
        removeConfirmName={null}
        removeDefaultProvider={null}
        codexLoginOpen={false}
        oauthTosPending={tos ? { provider: "anthropic", addAccount: false } : null}
        onCloseAdd={() => { events.push("closeAdd"); setAdding(false); }}
        onAdded={() => {}}
        onAccountLogin={() => {}}
        onAccountCancelLogin={() => {}}
        onAccountLogout={() => {}}
        onOpenAdd={() => {}}
        onCloseCodexLogin={() => {}}
        onCodexAdded={() => {}}
        onCancelRemove={() => {}}
        onConfirmRemove={() => {}}
        onCancelOauthTos={() => { events.push("cancelOauthTos"); setTos(false); }}
        onContinueOauthTos={() => {}}
      />
    </LanguageProvider>
  );
}

async function renderWorkspace(warning: boolean) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Workspace warning={warning} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

test("a Settings confirmation beneath Add Provider keeps its Escape until it is on top", async () => {
  await renderWorkspace(false);
  await pressEscape();
  expect(events).toEqual(["closeAdd"]);
  await pressEscape();
  expect(events).toEqual(["closeAdd", "cancelSettingsLeave"]);
});

test("with the OAuth warning on top of both, Escape unwinds warning, Add Provider, then the confirmation", async () => {
  await renderWorkspace(true);
  await pressEscape();
  expect(events).toEqual(["cancelOauthTos"]);
  await pressEscape();
  expect(events).toEqual(["cancelOauthTos", "closeAdd"]);
  await pressEscape();
  expect(events).toEqual(["cancelOauthTos", "closeAdd", "cancelSettingsLeave"]);
});

test("a confirmation stacked visually above Add Provider by z-index owns Escape", async () => {
  await renderWorkspace(false);
  // The real stylesheet puts .dialog-backdrop at z-index 900 and .modal-overlay at --z-modal (50);
  // happy-dom loads no CSS, so mirror those values on the rendered layers.
  await act(async () => {
    (host.querySelector(".dialog-backdrop") as HTMLElement).style.zIndex = "900";
    (host.querySelector("div.modal-overlay") as HTMLElement).style.zIndex = "50";
  });
  await pressEscape();
  expect(events).toEqual(["cancelSettingsLeave"]);
  await pressEscape();
  expect(events).toEqual(["cancelSettingsLeave", "closeAdd"]);
});

test("an Escape another layer already took does not also close Add Provider", async () => {
  // A layer whose own listener handled the key and prevented it, then left the DOM before Add
  // Provider's listener ran (React can flush its removal first in a real browser).
  const taker = (event: KeyboardEvent) => { if (event.key === "Escape") event.preventDefault(); };
  win.addEventListener("keydown", taker as never);
  try {
    await render(null);
    await pressEscape();
    expect(events).toEqual([]);
  } finally {
    win.removeEventListener("keydown", taker as never);
  }
});

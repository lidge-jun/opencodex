import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useLayoutEffect, useState } from "react";
import type { Root } from "react-dom/client";
import ProviderJsonEditor from "../src/components/provider-workspace/ProviderJsonEditor";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import Providers from "../src/pages/Providers";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import { useJsonConfigEditor, type Config } from "../src/hooks/useJsonConfigEditor";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { createProviderDraftStore } from "../src/provider-workspace/target-drafts";
import { captureApiTarget, configureApiTargets, TARGET_PREFLIGHT_LEGACY_EVENT } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import type { ApiTargetCapture } from "../src/api";
import * as dialogs from "../src/action-dialogs";
import { chooseOption, selectTrigger } from "./helpers/custom-select";
import { useProvidersCrud } from "../src/pages/use-providers-crud";
import AddProviderModal from "../src/components/AddProviderModal";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let win: Window;
let root: Root | undefined;
let host: HTMLElement;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    HTMLElement: win.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  globalThis.fetch = originalFetch;
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
});

async function render(node: React.ReactNode): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  if (!root) {
    root = createRoot(host);
    await act(async () => { root!.render(<LanguageProvider>{node}</LanguageProvider>); });
    return;
  }
  await act(async () => { root!.render(<LanguageProvider>{node}</LanguageProvider>); });
}

function item(target: "a" | "b", note: string): WorkspaceItem {
  return {
    name: "shared-provider",
    adapter: "openai-chat",
    baseUrl: `https://${target}.example.test/v1`,
    hasApiKey: true,
    authMode: "key",
    note,
  } as WorkspaceItem;
}

function relayTargets(apiBase: string, origin: string) {
  const base = standaloneApiTargets(apiBase);
  return {
    ...base,
    connected: true,
    shared: { ...base.shared, baseUrl: apiBase, serverOrigin: origin, transport: "relay" as const },
    apiKeyId: "fixture-key",
    relayTargetCheck: "expected-target-v1" as const,
  };
}

function noteField(): HTMLTextAreaElement {
  const field = host.querySelector<HTMLTextAreaElement>(".pwi-settings-textarea");
  expect(field).toBeTruthy();
  return field!;
}

async function typeNote(value: string): Promise<void> {
  const field = noteField();
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent === label);
}

function saveButton(): HTMLButtonElement {
  const save = host.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary");
  expect(save).toBeTruthy();
  return save!;
}

describe("Provider Settings drafts are scoped to their dashboard target", () => {
  test("a same-name provider on another target neither inherits nor loses the first target's draft", async () => {
    const store = createProviderDraftStore();
    const update = async () => ({ ok: true });
    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={update} />);
    await typeNote("draft for A");
    expect(host.textContent).toContain("unsaved changes");

    await render(<ProviderSettings item={item("b", "saved B")} targetKey="/b" draftStore={store} onUpdateProvider={update} />);
    expect(noteField().value).toBe("saved B");
    expect(host.textContent).not.toContain("unsaved changes");

    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={update} />);
    expect(noteField().value).toBe("draft for A");
    expect(host.textContent).toContain("unsaved changes");
  });

  test("a changed saved baseline is a conflict that needs an explicit choice", async () => {
    const store = createProviderDraftStore();
    const update = async () => ({ ok: true });
    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={update} />);
    await typeNote("my draft");
    await render(<ProviderSettings item={item("b", "saved B")} targetKey="/b" draftStore={store} onUpdateProvider={update} />);
    await render(<ProviderSettings item={item("a", "changed on A")} targetKey="/a" draftStore={store} onUpdateProvider={update} />);

    expect(host.textContent).toContain("saved settings changed");
    expect(saveButton().disabled).toBe(true);
    await act(async () => { button("Use saved values")!.click(); });
    expect(noteField().value).toBe("changed on A");
    expect(host.textContent).not.toContain("saved settings changed");
    expect(host.textContent).not.toContain("unsaved changes");
  });

  test("keeping the draft rebases the baseline and saves only to the originating target", async () => {
    const store = createProviderDraftStore();
    const requests: Array<{ target: string; name: string; patch: ProviderUpdatePatch }> = [];
    const updateFor = (target: string) => async (name: string, patch: ProviderUpdatePatch) => {
      requests.push({ target, name, patch });
      return { ok: true };
    };
    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={updateFor("a")} />);
    await typeNote("my draft");
    await render(<ProviderSettings item={item("b", "saved B")} targetKey="/b" draftStore={store} onUpdateProvider={updateFor("b")} />);
    await render(<ProviderSettings item={item("a", "changed on A")} targetKey="/a" draftStore={store} onUpdateProvider={updateFor("a")} />);

    await act(async () => { button("Keep my draft")!.click(); });
    expect(noteField().value).toBe("my draft");
    expect(saveButton().disabled).toBe(false);
    await act(async () => { saveButton().click(); await Promise.resolve(); });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.target).toBe("a");
    expect(requests[0]!.patch.note).toBe("my draft");
  });

  test("a save that lands after the target changes is not announced or applied on the new target", async () => {
    const store = createProviderDraftStore();
    let finishA!: (result: { ok: boolean }) => void;
    const calls: string[] = [];
    const updateA = async () => { calls.push("a"); return await new Promise<{ ok: boolean }>(resolve => { finishA = resolve; }); };
    const updateB = async () => { calls.push("b"); return { ok: true }; };
    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={updateA} />);
    await typeNote("draft for A");
    await act(async () => { saveButton().click(); await Promise.resolve(); });
    await render(<ProviderSettings item={item("b", "saved B")} targetKey="/b" draftStore={store} onUpdateProvider={updateB} />);
    await act(async () => { finishA({ ok: true }); await Promise.resolve(); });

    expect(calls).toEqual(["a"]);
    expect(noteField().value).toBe("saved B");
    expect(host.textContent).not.toContain("Settings saved.");
    expect(store.read("/a", "shared-provider")?.draft.note).toBe("draft for A");
  });

  test("typing while a save is in flight keeps the newer draft", async () => {
    const store = createProviderDraftStore();
    let finish!: (result: { ok: boolean }) => void;
    const update = async () => await new Promise<{ ok: boolean }>(resolve => { finish = resolve; });
    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={update} />);
    await typeNote("first edit");
    await act(async () => { saveButton().click(); await Promise.resolve(); });
    await typeNote("second edit");
    await act(async () => { finish({ ok: true }); await Promise.resolve(); });

    expect(noteField().value).toBe("second edit");
    expect(host.textContent).toContain("unsaved changes");
    expect(store.read("/a", "shared-provider")?.draft.note).toBe("second edit");
  });

  test("keeping a note draft does not revert an externally changed base URL", async () => {
    const store = createProviderDraftStore();
    const patches: ProviderUpdatePatch[] = [];
    const update = async (_name: string, patch: ProviderUpdatePatch) => { patches.push(patch); return { ok: true }; };
    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={update} />);
    await typeNote("my draft");
    await render(
      <ProviderSettings
        item={{ ...item("a", "saved A"), baseUrl: "https://changed.example.test/v1" }}
        targetKey="/a"
        draftStore={store}
        onUpdateProvider={update}
      />,
    );
    await act(async () => { button("Keep my draft")!.click(); });
    await act(async () => { saveButton().click(); await Promise.resolve(); });

    expect(patches).toEqual([{ note: "my draft" }]);
  });

  test("a completion after a target switch keeps edits typed after the submitted version", async () => {
    const store = createProviderDraftStore();
    let finish!: (result: { ok: boolean }) => void;
    const updateA = async () => await new Promise<{ ok: boolean }>(resolve => { finish = resolve; });
    const updateB = async () => ({ ok: true });
    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={updateA} />);
    await typeNote("first edit");
    await act(async () => { saveButton().click(); await Promise.resolve(); });
    await typeNote("second edit");
    await render(<ProviderSettings item={item("b", "saved B")} targetKey="/b" draftStore={store} onUpdateProvider={updateB} />);
    await act(async () => { finish({ ok: true }); await Promise.resolve(); });
    expect(store.read("/a", "shared-provider")?.draft.note).toBe("second edit");

    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={updateA} />);
    expect(noteField().value).toBe("second edit");
  });

  test("a removal while a save is in flight does not resurrect the draft", async () => {
    const store = createProviderDraftStore();
    let finish!: (result: { ok: boolean }) => void;
    const update = async () => await new Promise<{ ok: boolean }>(resolve => { finish = resolve; });
    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={update} />);
    await typeNote("draft before removal");
    await act(async () => { saveButton().click(); await Promise.resolve(); });
    store.clear("/a", "shared-provider");
    await act(async () => { finish({ ok: true }); await Promise.resolve(); });

    expect(store.read("/a", "shared-provider")).toBeUndefined();
  });

  test("discarding from the leave dialog clears the parked Settings draft", async () => {
    const store = createProviderDraftStore();
    await render(
      <ProviderDetails
        item={item("a", "saved A")}
        targetKey="/a"
        draftStore={store}
        availableModels={[]}
        hasLiveModels={false}
        selectedModels={[]}
        modelRows={[]}
        modelRevision="r1"
        modelRowsReady
        onOpenModels={() => undefined}
        onDeselect={() => undefined}
        apiBase=""
      />,
    );
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); });
    await typeNote("discarded draft");
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-overview")!.click(); });
    const dialog = host.querySelector('[role="alertdialog"]')!;
    const discard = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent === "Discard")!;
    await act(async () => { discard.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); });

    expect(noteField().value).toBe("saved A");
    expect(store.read("/a", "shared-provider")?.draft.note).toBe("saved A");
  });

  test("deselecting through the leave dialog also clears the parked draft", async () => {
    const store = createProviderDraftStore();
    function Host() {
      const [open, setOpen] = useState(true);
      return open ? (
        <ProviderDetails
          item={item("a", "saved A")}
          targetKey="/a"
          draftStore={store}
          availableModels={[]}
          hasLiveModels={false}
          selectedModels={[]}
          modelRows={[]}
          modelRevision="r1"
          modelRowsReady
          onOpenModels={() => undefined}
          onDeselect={() => setOpen(false)}
          apiBase=""
        />
      ) : <button type="button" onClick={() => setOpen(true)}>reopen</button>;
    }
    await render(<Host />);
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); });
    await typeNote("discarded draft");
    await act(async () => { host.querySelector<HTMLButtonElement>(".pws-detail-back-link")!.click(); });
    const dialog = host.querySelector('[role="alertdialog"]')!;
    const discard = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent === "Discard")!;
    await act(async () => { discard.click(); });
    await act(async () => { button("reopen")!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); });

    expect(noteField().value).toBe("saved A");
    expect(store.read("/a", "shared-provider")?.draft.note).toBe("saved A");
  });

  test("a clean saved refresh settles in one pass and shows the new saved values", async () => {
    const store = createProviderDraftStore();
    const update = async () => ({ ok: true });
    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} onUpdateProvider={update} />);
    expect(noteField().value).toBe("saved A");

    // A clean form follows the saved item in the commit that delivers it. A reset that
    // re-adopts on its own render would hit React's update-depth guard right here.
    await render(<ProviderSettings item={item("a", "saved A2")} targetKey="/a" draftStore={store} onUpdateProvider={update} />);
    expect(noteField().value).toBe("saved A2");
    expect(host.textContent).not.toContain("unsaved changes");

    // An equal refresh (new object, same saved values) leaves the form alone.
    await render(<ProviderSettings item={item("a", "saved A2")} targetKey="/a" draftStore={store} onUpdateProvider={update} />);
    expect(noteField().value).toBe("saved A2");
    expect(host.textContent).not.toContain("unsaved changes");
    expect(host.textContent).not.toContain("saved settings changed");
  });

  test("a dirty draft survives the preset endpoint choices arriving", async () => {
    const store = createProviderDraftStore();
    let finishPresets!: (response: Response) => void;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/a/api/provider-presets") return await new Promise<Response>(resolve => { finishPresets = resolve; });
      if (path === "/a/api/provider-request-pacing") return Response.json({ enabled: false, queued: 0, nextSlotInMs: 0 });
      return Response.json({});
    }) as typeof fetch;
    const update = async () => ({ ok: true });
    await render(<ProviderSettings item={item("a", "saved A")} targetKey="/a" draftStore={store} apiBase="/a" onUpdateProvider={update} />);
    await typeNote("typed before presets");

    await act(async () => {
      finishPresets(Response.json({ providers: [{ id: "shared-provider", baseUrlChoices: [
        { id: "a", label: "A", baseUrl: "https://a.example.test/v1" },
        { id: "b", label: "B", baseUrl: "https://b.example.test/v1" },
      ] }] }));
      await Promise.resolve();
    });

    expect(noteField().value).toBe("typed before presets");
    expect(host.textContent).toContain("unsaved changes");
    expect(store.read("/a", "shared-provider")?.draft.note).toBe("typed before presets");
  });
});

type Editor = ReturnType<typeof useJsonConfigEditor>;
let latestEditor: Editor | null = null;

function config(target: "a" | "b", note: string): Config {
  return {
    port: 0,
    defaultProvider: "shared-provider",
    providers: { "shared-provider": { adapter: "openai-chat", baseUrl: `https://${target}.example.test/v1`, note } },
  } as Config;
}

function EditorHarness({ apiBase, targetKey, value, notifications }: {
  apiBase: string;
  targetKey?: string;
  value: Config;
  notifications: Array<{ message: string; ok?: boolean }>;
}) {
  useEffect(() => { configureApiTargets(standaloneApiTargets(apiBase)); }, [apiBase]);
  const editor = useJsonConfigEditor({
    apiBase,
    targetKey,
    config: value,
    notify: (message, ok) => { notifications.push({ message, ok }); },
    fetchConfig: async () => {},
    fetchProviderQuotas: async () => {},
    onSaved: () => {},
    t: key => key,
  });
  useEffect(() => { latestEditor = editor; }, [editor]);
  return (
    <ProviderJsonEditor
      editor={{
        open: editor.jsonEditorOpen,
        draft: editor.draft,
        isDirty: editor.jsonIsDirty,
        onDraftChange: editor.setDraft,
        onSave: editor.saveConfig,
        onClose: editor.requestCloseJsonEditor,
        onRestore: editor.restoreJsonEditor,
        conflict: editor.jsonConflict,
        onUseSaved: editor.useSavedJsonValues,
        onKeepDraft: editor.keepJsonDraft,
      }}
      providerName="Providers"
      saving={editor.jsonSaving}
      onSave={() => { void editor.saveConfig(); }}
    />
  );
}

describe("Provider JSON drafts are scoped to their dashboard target", () => {
  test("switching targets shows the new target's baseline and restores the old draft on return", async () => {
    const notifications: Array<{ message: string; ok?: boolean }> = [];
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
      return Response.json({ success: true });
    }) as typeof fetch;

    await render(<EditorHarness apiBase="/a" value={config("a", "saved A")} notifications={notifications} />);
    await act(async () => { latestEditor!.openJsonEditor(); });
    const draftA = JSON.parse(latestEditor!.draft);
    draftA.providers["shared-provider"].note = "draft for A";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(draftA, null, 2)); });

    await render(<EditorHarness apiBase="/b" value={config("b", "saved B")} notifications={notifications} />);
    expect(latestEditor!.jsonEditorOpen).toBe(false);
    expect(JSON.parse(latestEditor!.draft).providers["shared-provider"].note).toBe("saved B");

    await render(<EditorHarness apiBase="/a" value={config("a", "saved A")} notifications={notifications} />);
    expect(latestEditor!.jsonEditorOpen).toBe(true);
    expect(JSON.parse(latestEditor!.draft).providers["shared-provider"].note).toBe("draft for A");
    await act(async () => { expect(await latestEditor!.saveConfig()).toBe(true); });
    expect(requests.map(request => request.url)).toEqual(["/a/api/providers"]);
    expect(notifications.at(-1)).toEqual({ message: "prov.saved", ok: true });
  });

  test("a changed saved baseline is a conflict with explicit resolution", async () => {
    const notifications: Array<{ message: string; ok?: boolean }> = [];
    globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch;
    await render(<EditorHarness apiBase="/a" value={config("a", "saved A")} notifications={notifications} />);
    await act(async () => { latestEditor!.openJsonEditor(); });
    const draft = JSON.parse(latestEditor!.draft);
    draft.providers["shared-provider"].note = "my draft";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(draft, null, 2)); });
    const changedElsewhere = config("a", "saved A");
    changedElsewhere.providers["shared-provider"]!.baseUrl = "https://changed.example.test/v1";
    await render(<EditorHarness apiBase="/a" value={changedElsewhere} notifications={notifications} />);

    expect(latestEditor!.jsonConflict).toBe(true);
    expect(host.textContent).toContain("saved settings changed");
    const save = button("Save");
    expect(save?.disabled).toBe(true);
    await act(async () => { button("Keep my draft")!.click(); });
    expect(latestEditor!.jsonConflict).toBe(false);
    expect(JSON.parse(latestEditor!.draft).providers["shared-provider"].note).toBe("my draft");
    expect(button("Save")?.disabled).toBe(false);
  });

  test("a save that lands after the target changes does not close or announce on the new target", async () => {
    const notifications: Array<{ message: string; ok?: boolean }> = [];
    let finish!: (response: Response) => void;
    globalThis.fetch = (async () => await new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    await render(<EditorHarness apiBase="/a" value={config("a", "saved A")} notifications={notifications} />);
    await act(async () => { latestEditor!.openJsonEditor(); });
    const draft = JSON.parse(latestEditor!.draft);
    draft.providers["shared-provider"].note = "draft for A";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(draft, null, 2)); });
    await act(async () => { void latestEditor!.saveConfig(); await Promise.resolve(); });
    await render(<EditorHarness apiBase="/b" value={config("b", "saved B")} notifications={notifications} />);
    await act(async () => { finish(Response.json({ success: true })); await Promise.resolve(); });

    expect(notifications).toHaveLength(0);
    expect(latestEditor!.jsonEditorOpen).toBe(false);
    expect(JSON.parse(latestEditor!.draft).providers["shared-provider"].note).toBe("saved B");
  });

  test("edits typed while a JSON save is in flight stay open on the new baseline", async () => {
    const notifications: Array<{ message: string; ok?: boolean }> = [];
    let finish!: (response: Response) => void;
    let lastSaved: Config | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { next: Config } : null;
      if (body) lastSaved = body.next;
      return await new Promise<Response>(resolve => { finish = resolve; });
    }) as typeof fetch;
    function StatefulHarness() {
      const [value, setValue] = useState(config("a", "saved A"));
      const editor = useJsonConfigEditor({
        apiBase: "/a",
        config: value,
        notify: (message, ok) => { notifications.push({ message, ok }); },
        fetchConfig: async () => { if (lastSaved) setValue(lastSaved); },
        fetchProviderQuotas: async () => {},
        onSaved: () => {},
        t: key => key,
      });
      useEffect(() => { latestEditor = editor; }, [editor]);
      return (
        <ProviderJsonEditor
          editor={{
            open: editor.jsonEditorOpen, draft: editor.draft, isDirty: editor.jsonIsDirty,
            onDraftChange: editor.setDraft, onSave: editor.saveConfig, onClose: editor.requestCloseJsonEditor,
            conflict: editor.jsonConflict, onUseSaved: editor.useSavedJsonValues, onKeepDraft: editor.keepJsonDraft,
          }}
          providerName="Providers" saving={editor.jsonSaving} onSave={() => { void editor.saveConfig(); }}
        />
      );
    }
    configureApiTargets(standaloneApiTargets("/a"));
    await render(<StatefulHarness />);
    await act(async () => { latestEditor!.openJsonEditor(); });
    const first = JSON.parse(latestEditor!.draft);
    first.providers["shared-provider"].note = "first JSON edit";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(first, null, 2)); });
    await act(async () => { void latestEditor!.saveConfig(); await Promise.resolve(); });
    const second = structuredClone(first);
    second.providers["shared-provider"].note = "second JSON edit";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(second, null, 2)); });
    await act(async () => { finish(Response.json({ success: true })); await Promise.resolve(); await Promise.resolve(); });

    expect(latestEditor!.jsonEditorOpen).toBe(true);
    expect(JSON.parse(latestEditor!.draft).providers["shared-provider"].note).toBe("second JSON edit");
    expect(latestEditor!.jsonConflict).toBe(false);
  });

  test("Keep my draft applies only the user delta to the latest saved config", async () => {
    const notifications: Array<{ message: string; ok?: boolean }> = [];
    const requests: Array<{ body: { baseline: unknown; next: unknown } }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)) as { baseline: unknown; next: unknown } });
      return Response.json({ success: true });
    }) as typeof fetch;
    await render(<EditorHarness apiBase="/a" value={config("a", "saved A")} notifications={notifications} />);
    await act(async () => { latestEditor!.openJsonEditor(); });
    const draft = JSON.parse(latestEditor!.draft);
    draft.providers["shared-provider"].note = "my draft";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(draft, null, 2)); });

    const latest = config("a", "saved A");
    latest.providers["shared-provider"]!.baseUrl = "https://changed.example.test/v1";
    latest.providers["added-elsewhere"] = { adapter: "openai-chat", baseUrl: "https://q.example.test/v1" };
    await render(<EditorHarness apiBase="/a" value={latest} notifications={notifications} />);
    await act(async () => { button("Keep my draft")!.click(); });

    const rebased = JSON.parse(latestEditor!.draft);
    expect(rebased.providers["shared-provider"].note).toBe("my draft");
    expect(rebased.providers["shared-provider"].baseUrl).toBe("https://changed.example.test/v1");
    expect(rebased.providers["added-elsewhere"]).toEqual({ adapter: "openai-chat", baseUrl: "https://q.example.test/v1" });
    expect(latestEditor!.jsonConflict).toBe(false);

    await act(async () => { expect(await latestEditor!.saveConfig()).toBe(true); });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.baseline).toEqual(JSON.parse(latestEditor!.jsonBaseline));
    expect(requests[0]!.body.next).toEqual(rebased);
  });

  test("a same-field edit on both sides is an explicit conflict, not a silent overwrite", async () => {
    const notifications: Array<{ message: string; ok?: boolean }> = [];
    globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch;
    await render(<EditorHarness apiBase="/a" value={config("a", "saved A")} notifications={notifications} />);
    await act(async () => { latestEditor!.openJsonEditor(); });
    const draft = JSON.parse(latestEditor!.draft);
    draft.providers["shared-provider"].note = "my draft";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(draft, null, 2)); });
    const external = config("a", "external edit");
    await render(<EditorHarness apiBase="/a" value={external} notifications={notifications} />);
    await act(async () => { button("Keep my draft")!.click(); });

    expect(latestEditor!.jsonConflicts).toEqual(["providers.shared-provider.note"]);
    expect(JSON.parse(latestEditor!.draft).providers["shared-provider"].note).toBe("my draft");
    expect(button("Save")?.disabled).toBe(true);
    const resolved = JSON.parse(latestEditor!.draft);
    resolved.providers["shared-provider"].note = "external edit";
    resolved.providers["shared-provider"].baseUrl = "https://resolved.example.test/v1";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(resolved, null, 2)); });
    expect(latestEditor!.jsonConflicts).toEqual([]);
    expect(button("Save")?.disabled).toBe(false);
  });

  test("Restore during a conflict restores the latest saved values", async () => {
    const notifications: Array<{ message: string; ok?: boolean }> = [];
    globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch;
    await render(<EditorHarness apiBase="/a" value={config("a", "saved A")} notifications={notifications} />);
    await act(async () => { latestEditor!.openJsonEditor(); });
    const draft = JSON.parse(latestEditor!.draft);
    draft.providers["shared-provider"].note = "my draft";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(draft, null, 2)); });
    const external = config("a", "external edit");
    await render(<EditorHarness apiBase="/a" value={external} notifications={notifications} />);
    await act(async () => { button("Restore")!.click(); });

    expect(JSON.parse(latestEditor!.draft).providers["shared-provider"].note).toBe("external edit");
    expect(latestEditor!.jsonConflict).toBe(false);
  });

  test("Save from the leave dialog still refuses a conflicted draft", async () => {
    const notifications: Array<{ message: string; ok?: boolean }> = [];
    let puts = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") puts += 1;
      return Response.json({ success: true });
    }) as typeof fetch;
    await render(<EditorHarness apiBase="/a" value={config("a", "saved A")} notifications={notifications} />);
    await act(async () => { latestEditor!.openJsonEditor(); });
    const draft = JSON.parse(latestEditor!.draft);
    draft.providers["shared-provider"].note = "my draft";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(draft, null, 2)); });
    await render(<EditorHarness apiBase="/a" value={config("a", "external edit")} notifications={notifications} />);
    await act(async () => { latestEditor!.requestCloseJsonEditor(); });
    expect(latestEditor!.jsonLeaveOpen).toBe(true);
    let saved = true;
    await act(async () => { saved = await latestEditor!.saveConfig(); });

    expect(saved).toBe(false);
    expect(puts).toBe(0);
    expect(notifications.at(-1)).toEqual({ message: "pws.draftConflictResolveFirst", ok: false });
  });

  test("a fixed relay remap cannot save the old editor baseline to the new hub", async () => {
    const notifications: Array<{ message: string; ok?: boolean }> = [];
    let puts = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") puts += 1;
      return Response.json({ success: true });
    }) as typeof fetch;
    configureApiTargets(standaloneApiTargets("/same"));
    const targetA = captureApiTarget("shared").targetKey;
    await render(<EditorHarness apiBase="/same" targetKey={targetA} value={config("a", "saved A")} notifications={notifications} />);
    await act(async () => { latestEditor!.openJsonEditor(); });
    const draft = JSON.parse(latestEditor!.draft);
    draft.providers["shared-provider"].note = "A draft";
    await act(async () => { latestEditor!.setDraft(JSON.stringify(draft, null, 2)); });

    const base = standaloneApiTargets("/same");
    configureApiTargets({
      ...base,
      connected: true,
      shared: { ...base.shared, baseUrl: "/same", serverOrigin: "https://hub-b.example", transport: "relay" },
      apiKeyId: "fixture-key",
      relayTargetCheck: "expected-target-v1",
    });
    let saved = true;
    await act(async () => { saved = await latestEditor!.saveConfig(); });
    expect(saved).toBe(false);
    expect(puts).toBe(0);
    expect(notifications.at(-1)?.message).toBe("prov.targetChanged");
  });
});

describe("Provider drafts follow the logical dashboard target", () => {
  test("a logical target change refetches config even when the relay apiBase is unchanged", async () => {
    let configReads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/same/api/config") {
        configReads += 1;
        const name = configReads === 1 ? "provider-a" : "provider-b";
        return Response.json({ port: 0, defaultProvider: name, providers: {
          [name]: { adapter: "openai-chat", baseUrl: "https://example.test/v1", hasApiKey: true },
        } });
      }
      if (path.endsWith("/api/oauth/providers") || path.endsWith("/api/provider-presets")) return Response.json({ providers: [] });
      if (path.endsWith("/api/selected-models")) return Response.json({ selected: {}, available: {}, liveModelCounts: {} });
      if (path.endsWith("/api/models")) return Response.json([]);
      if (path.endsWith("/api/provider-quotas")) return Response.json({ reports: [] });
      if (path.endsWith("/api/usage")) return Response.json({ providers: [], models: [] });
      if (path.endsWith("/api/codex-auth/accounts")) return Response.json({ accounts: [] });
      return Response.json({});
    }) as typeof fetch;

    configureApiTargets(relayTargets("/same", "hub-a"));
    await render(<Providers apiBase="/same" targetKey="hub-a" />);
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });
    expect(host.textContent).toContain("Provider A");
    configureApiTargets(relayTargets("/same", "hub-b"));
    await render(<Providers apiBase="/same" targetKey="hub-b" />);
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });
    expect(host.textContent).toContain("Provider B");
    expect(host.textContent).not.toContain("Provider A");
  });

  test("an old target's save completion cannot supersede the new target's config read", async () => {
    let finishPatch!: (response: Response) => void;
    let finishNewConfig!: (response: Response) => void;
    const configA = { port: 0, defaultProvider: "provider-a", providers: {
      "provider-a": { adapter: "openai-chat", baseUrl: "https://a.example.test/v1", hasApiKey: true },
    } };
    const configB = { port: 0, defaultProvider: "provider-b", providers: {
      "provider-b": { adapter: "openai-chat", baseUrl: "https://b.example.test/v1", hasApiKey: true },
    } };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/a/api/config") return Response.json(configA);
      if (path === "/b/api/config") return await new Promise<Response>(resolve => { finishNewConfig = resolve; });
      if (path === "/a/api/providers" && init?.method === "PATCH") {
        return await new Promise<Response>(resolve => { finishPatch = resolve; });
      }
      if (path.endsWith("/api/oauth/providers") || path.endsWith("/api/provider-presets")) return Response.json({ providers: [] });
      if (path.endsWith("/api/selected-models")) return Response.json({ selected: {}, available: {}, liveModelCounts: {} });
      if (path.endsWith("/api/models")) return Response.json([]);
      if (path.endsWith("/api/provider-quotas")) return Response.json({ reports: [] });
      if (path.endsWith("/api/usage")) return Response.json({ providers: [], models: [] });
      if (path.endsWith("/api/codex-auth/accounts")) return Response.json({ accounts: [] });
      return Response.json({});
    }) as typeof fetch;

    configureApiTargets(relayTargets("/a", "hub-a"));
    await render(<Providers apiBase="/a" targetKey="hub-a" />);
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="option"]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); });
    await typeNote("draft A note");
    await act(async () => { saveButton().click(); await Promise.resolve(); });

    configureApiTargets(relayTargets("/b", "hub-b"));
    await render(<Providers apiBase="/b" targetKey="hub-b" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { finishPatch(Response.json({ success: true })); await Promise.resolve(); });
    await act(async () => { finishNewConfig(Response.json(configB)); await Promise.resolve(); });
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });

    expect(host.textContent).toContain("Provider B");
    expect(host.textContent).not.toContain("Loading…");
  });

  test("the legacy preflight notice is shown on the current logical target", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/same/api/config") return Response.json({ port: 0, defaultProvider: "provider-a", providers: {
        "provider-a": { adapter: "openai-chat", baseUrl: "https://a.example.test/v1", hasApiKey: true },
      } });
      if (path.endsWith("/api/oauth/providers") || path.endsWith("/api/provider-presets")) return Response.json({ providers: [] });
      if (path.endsWith("/api/selected-models")) return Response.json({ selected: {}, available: {}, liveModelCounts: {} });
      if (path.endsWith("/api/models")) return Response.json([]);
      if (path.endsWith("/api/provider-quotas")) return Response.json({ reports: [] });
      if (path.endsWith("/api/usage")) return Response.json({ providers: [], models: [] });
      if (path.endsWith("/api/codex-auth/accounts")) return Response.json({ accounts: [] });
      return Response.json({});
    }) as typeof fetch;

    configureApiTargets(relayTargets("/same", "hub-a"));
    await render(<Providers apiBase="/same" targetKey="hub-a" />);
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });
    await act(async () => {
      window.dispatchEvent(new win.CustomEvent(TARGET_PREFLIGHT_LEGACY_EVENT, { detail: { targetKey: "hub-a" } }));
    });
    expect(document.body.textContent).toContain("This proxy checks the save target before sending");
  });
});

describe("a render gap cannot retarget a provider mutation", () => {
  function relayConfig() {
    return { port: 0, defaultProvider: "provider-a", providers: {
      "provider-a": { adapter: "openai-chat", baseUrl: "https://a.example.test/v1", hasApiKey: true },
    } };
  }

  function relayOnlyFetch(onMutation: (expected: string | null) => Response) {
    let currentHub = "hub-a";
    return {
      setHub(hub: string) { currentHub = hub; },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/same/api/config") return Response.json(relayConfig());
        if (path === "/same/api/providers" && init?.method === "PATCH") {
          return onMutation(new Headers(init.headers).get("x-opencodex-expected-target"));
        }
        if (path.endsWith("/api/oauth/providers") || path.endsWith("/api/provider-presets")) return Response.json({ providers: [] });
        if (path.endsWith("/api/selected-models")) return Response.json({ selected: {}, available: {}, liveModelCounts: {} });
        if (path.endsWith("/api/models")) return Response.json([]);
        if (path.endsWith("/api/provider-quotas")) return Response.json({ reports: [] });
        if (path.endsWith("/api/usage")) return Response.json({ providers: [], models: [] });
        if (path.endsWith("/api/codex-auth/accounts")) return Response.json({ accounts: [] });
        return Response.json({});
      }) as typeof fetch,
      current: () => currentHub,
    };
  }

  test("a Settings note save from a stale render is refused before fetch, not written to the new hub", async () => {
    const attempts: Array<string | null> = [];
    const hubWrites: string[] = [];
    const relay = relayOnlyFetch(expected => {
      attempts.push(expected);
      // The relay compares the forwarded snapshot, exactly as the real handler does.
      if (expected !== relay.current()) return Response.json({ error: "target_changed" }, { status: 409 });
      hubWrites.push(relay.current());
      return Response.json({ success: true });
    });
    globalThis.fetch = relay.fetch;
    configureApiTargets(relayTargets("/same", "hub-a"));
    await render(<Providers apiBase="/same" targetKey="hub-a" />);
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="option"]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); });
    await typeNote("draft A note");
    // The module target moves before React re-renders the page.
    configureApiTargets(relayTargets("/same", "hub-b"));
    relay.setHub("hub-b");
    await act(async () => { saveButton().click(); await new Promise(resolve => win.setTimeout(resolve, 20)); });
    // The stale form capture is refused before authentication or fetch: nothing reaches
    // the relay, and nothing is written to the new hub.
    expect(attempts).toEqual([]);
    expect(hubWrites).toEqual([]);
  });

  test("an account-mode change captures the form target before the confirmation", async () => {
    const calls: Array<{ patch: ProviderUpdatePatch; capture?: ApiTargetCapture }> = [];
    const confirm = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
    try {
      configureApiTargets(relayTargets("/same", "hub-a"));
      await render(
        <ProviderSettings
          item={{
            name: "openai",
            adapter: "openai-responses",
            authMode: "forward",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            hasApiKey: true,
            codexAccountMode: "pool",
          } as WorkspaceItem}
          apiBase="/same"
          targetKey="hub-a"
          onUpdateProvider={async (_name, patch, capture) => { calls.push({ patch, capture }); return { ok: true }; }}
        />,
      );
      // The module target moves before React re-renders the form.
      configureApiTargets(relayTargets("/same", "hub-b"));
      await chooseOption(selectTrigger(host, '[role="combobox"][aria-label="OpenAI account mode"]'), "direct");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.patch).toEqual({ codexAccountMode: "direct" });
      // The capture was taken before the dialog, so it still names the form's target.
      expect(calls[0]!.capture?.origin).toBe("hub-a");
    } finally {
      confirm.mockRestore();
    }
  });

  test("a stale CRUD closure updates the target it rendered under", async () => {
    const expected: Array<string | null> = [];
    let crud!: ReturnType<typeof useProvidersCrud>;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/same/api/providers" && init?.method === "PATCH") {
        expected.push(new Headers(init.headers).get("x-opencodex-expected-target"));
        return Response.json({ success: true });
      }
      return Response.json({});
    }) as typeof fetch;
    function Harness() {
      const controller = useProvidersCrud({
        apiBase: "/same", targetKey: "hub-a", t: key => key,
        removeBusyRef: { current: false } as React.MutableRefObject<boolean>,
        workspaceSelected: null, setWorkspaceSelected: () => {}, setRemoveConfirmName: () => {},
        notify: () => {}, fetchConfig: async () => {}, fetchOauth: async () => {}, fetchProviderQuotas: async () => {},
      });
      // Publish after commit: the compiler rejects a render-phase write of a hook result
      // into a module binding, and the test body only reads it after act().
      useLayoutEffect(() => { crud = controller; });
      return null;
    }
    configureApiTargets(relayTargets("/same", "hub-a"));
    await render(<Harness />);
    configureApiTargets(relayTargets("/same", "hub-b"));
    await act(async () => { await crud.updateProvider("provider-a", { note: "x" }); });
    // The stale render capture is refused before fetch.
    expect(expected).toEqual([]);
  });

  test("updateProvider forwards the caller's capture and refuses a stale one", async () => {
    let calls = 0;
    let crud!: ReturnType<typeof useProvidersCrud>;
    globalThis.fetch = (async () => { calls += 1; return Response.json({ success: true }); }) as typeof fetch;
    function Harness({ target }: { target: string }) {
      const controller = useProvidersCrud({
        apiBase: "/same", targetKey: target, t: key => key,
        removeBusyRef: { current: false } as React.MutableRefObject<boolean>,
        workspaceSelected: null, setWorkspaceSelected: () => {}, setRemoveConfirmName: () => {},
        notify: () => {}, fetchConfig: async () => {}, fetchOauth: async () => {}, fetchProviderQuotas: async () => {},
      });
      useLayoutEffect(() => { crud = controller; });
      return null;
    }
    configureApiTargets(relayTargets("/same", "hub-a"));
    const captureA = captureApiTarget("shared");
    configureApiTargets(relayTargets("/same", "hub-b"));
    await render(<Harness target="hub-b" />);
    // The hook's own render capture is B; the caller's capture is the stale A. The
    // callback must forward A and refuse, not silently substitute the live B.
    const result = await crud.updateProvider("provider-a", { note: "x" }, captureA);
    expect(result).toEqual({ ok: false, error: "prov.targetChanged" });
    expect(calls).toBe(0);
  });

  test("the detail pane forwards a caller capture instead of replacing it", async () => {
    // The wrapper must accept the third argument; replacing a form capture here was the
    // e207 gap. The behavior is exercised through the Settings save above; this pins the
    // forwarding contract itself.
    const source = await Bun.file(new URL("../src/components/provider-workspace/ProviderDetails.tsx", import.meta.url)).text();
    expect(source).toContain("capture ?? updateCapture");
  });

  test("a remove confirmation opened on one target cannot delete on another, including A-B-A", async () => {
    const deletes: string[] = [];
    let crud!: ReturnType<typeof useProvidersCrud>;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (init?.method === "DELETE") {
        deletes.push(path);
        return Response.json({ success: true });
      }
      return Response.json({});
    }) as typeof fetch;
    function Harness({ base = "/same", target = "hub-a" }: { base?: string; target?: string }) {
      const controller = useProvidersCrud({
        apiBase: base, targetKey: target, t: label => label,
        removeBusyRef: { current: false } as React.MutableRefObject<boolean>,
        workspaceSelected: null, setWorkspaceSelected: () => {}, setRemoveConfirmName: () => {},
        notify: () => {}, fetchConfig: async () => {}, fetchOauth: async () => {}, fetchProviderQuotas: async () => {},
      });
      useLayoutEffect(() => { crud = controller; });
      return null;
    }
    configureApiTargets(relayTargets("/same", "hub-a"));
    await render(<Harness />);
    await act(async () => { await crud.removeProvider("provider-a"); });
    // The dialog is open on A; the page re-renders on B before the user confirms.
    configureApiTargets(relayTargets("/same", "hub-b"));
    await render(<Harness target="hub-b" />);
    await act(async () => { await crud.confirmRemoveProvider("provider-a"); });
    // Back on A, the same confirmation is older than the current generation.
    configureApiTargets(relayTargets("/same", "hub-a"));
    await render(<Harness target="hub-a" />);
    await act(async () => { await crud.confirmRemoveProvider("provider-a"); });
    expect(deletes).toEqual([]);
  });

  test("an Add Provider POST accepted on the old target does not select on the new target", async () => {
    let release!: (response: Response) => void;
    const added: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/same/api/providers" && init?.method === "POST") {
        return new Promise<Response>(resolve => { release = resolve; });
      }
      if (path.endsWith("/api/oauth/providers") || path.endsWith("/api/provider-presets")) return Response.json({ providers: [] });
      if (path.endsWith("/api/usage")) return Response.json({ providers: [] });
      return Response.json({});
    }) as typeof fetch;
    configureApiTargets(relayTargets("/same", "hub-a"));
    await render(
      <AddProviderModal apiBase="/same" targetKey="hub-a" existingNames={[]} initialCustom
        onClose={() => {}} onAdded={name => added.push(name)} />,
    );
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 30)); });
    const inputs = host.querySelectorAll<HTMLInputElement>(".modal-card input");
    const setValue = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    };
    await act(async () => { setValue(inputs[0]!, "added-on-a"); setValue(inputs[1]!, "https://a.example.test/v1"); });
    await act(async () => { host.querySelector<HTMLButtonElement>(".modal-card .btn-primary")!.click(); await Promise.resolve(); });
    // The module target moves before the modal re-renders.
    configureApiTargets(relayTargets("/same", "hub-b"));
    await act(async () => { release(Response.json({ ok: true })); await new Promise(resolve => win.setTimeout(resolve, 20)); });
    expect(added).toEqual([]);
  });
});

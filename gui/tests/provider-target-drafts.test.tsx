import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import ProviderJsonEditor from "../src/components/provider-workspace/ProviderJsonEditor";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import { useJsonConfigEditor, type Config } from "../src/hooks/useJsonConfigEditor";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { createProviderDraftStore } from "../src/provider-workspace/target-drafts";

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
    expect(store.read("/a", "shared-provider")).toBeUndefined();
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

function EditorHarness({ apiBase, value, notifications }: {
  apiBase: string;
  value: Config;
  notifications: Array<{ message: string; ok?: boolean }>;
}) {
  const editor = useJsonConfigEditor({
    apiBase,
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
    await render(<EditorHarness apiBase="/a" value={config("a", "changed on A")} notifications={notifications} />);

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
});

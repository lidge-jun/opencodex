import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
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

    await render(<Providers apiBase="/same" targetKey="hub-a" />);
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });
    expect(host.textContent).toContain("Provider A");
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

    await render(<Providers apiBase="/a" targetKey="hub-a" />);
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="option"]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>("#pws-tab-settings")!.click(); });
    await typeNote("draft A note");
    await act(async () => { saveButton().click(); await Promise.resolve(); });

    await render(<Providers apiBase="/b" targetKey="hub-b" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { finishPatch(Response.json({ success: true })); await Promise.resolve(); });
    await act(async () => { finishNewConfig(Response.json(configB)); await Promise.resolve(); });
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 40)); });

    expect(host.textContent).toContain("Provider B");
    expect(host.textContent).not.toContain("Loading…");
  });
});

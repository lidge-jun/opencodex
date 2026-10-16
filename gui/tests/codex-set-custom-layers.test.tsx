/**
 * Custom layers and the compatibility linter (devlog 050 + the rule table in 060).
 *
 * Case 12 re-asserts ask item 6 from the custom side: adding delete to one row
 * family must not leak it into the other.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import CodexSetPrompt from "../src/pages/codex-set-prompt";
import { LAYER_INVENTORY } from "../../src/codex/prompt-layers";
import { lintPromptLayer } from "../src/components/codex-set/prompt-lint";
import { moveLayer, normalizeBody, validateDraft } from "../src/components/codex-set/custom-layer-state";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
const INVENTORY = LAYER_INVENTORY.map(d => ({ ...d }));

function layer(over: Record<string, unknown> = {}) {
  return { id: "aaaaaa", title: "House rules", body: "Be brief.", enabled: true, ...over };
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    configPath: "/tmp/config.toml",
    storePath: "/tmp/opencodex-prompt.json",
    configExists: true,
    readable: true,
    developerInstructionsOwned: true,
    developerInstructionsState: "owned" as const,
    drift: null,
    revision: "sha256:one",
    inventory: INVENTORY,
    toggles: INVENTORY.filter(d => d.class === "config-toggle").map(d => ({
      id: d.id, key: d.key as string, userFileValue: null, defaultedUserValue: true, default: true,
    })),
    extensionLayersEnumerable: false,
    custom: [],
    modelInstructionsFile: null,
    baseVariants: [],
    baseSelection: { kind: "default" as const },
    maxBaseVariants: 2,
    ...over,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#codex-set/prompt" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/**
 * The request body, typed rather than `any`.
 *
 * Every assertion below reads `body.layers[].id`, so `any` bought nothing and
 * cost the repository's lint gate. `revision` is optional because only the
 * write calls carry one.
 */
interface CallBody { layers?: { id: string; title: string; body: string }[]; revision?: string; enabled?: boolean }
interface Call { url: string; method: string; body: CallBody }
function stubRoutes(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function mount(): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><CodexSetPrompt apiBase="" /></LanguageProvider>);
  });
  return { root, container };
}

function dialog(): HTMLElement { return document.querySelector("dialog.modal-overlay") as HTMLElement; }
/**
 * WP6 turned + into a picker whose blank option is the first item, and the menu is
 * collapsed until the trigger is pressed. These tests are about the custom-layer
 * flow rather than the menu, so this opens it and returns the blank entry.
 *
 * When the trigger is disabled the menu never opens, which is exactly what the
 * limit and unreadable cases assert - so this returns the TRIGGER in that case and
 * lets them check `disabled` on the control the user actually reaches.
 */
function addTrigger(c: HTMLElement): HTMLButtonElement | null {
  return c.querySelector(".codex-set-custom__add") as HTMLButtonElement | null;
}

/** Opens the picker and returns its blank entry, the shortest path to an editor. */
async function addButton(c: HTMLElement): Promise<HTMLButtonElement> {
  await act(async () => { addTrigger(c)!.click(); });
  return c.querySelector(".codex-set-preset__item") as HTMLButtonElement;
}
function customRow(c: HTMLElement, id: string) { return c.querySelector("[data-custom-id=\"" + id + "\"]"); }

/**
 * React tracks the previous value on the DOM node, so assigning `.value` directly
 * makes it skip the change as a no-op. The native setter is what a real keystroke
 * goes through.
 */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof testWindow.HTMLTextAreaElement
    ? testWindow.HTMLTextAreaElement.prototype
    : testWindow.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  el.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
}

test("1. + opens an empty editor", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const blank = await addButton(container);
  await act(async () => { blank.click(); });
  const input = dialog().querySelector("input[type=\"text\"]") as HTMLInputElement;
  const textarea = dialog().querySelector("textarea") as HTMLTextAreaElement;
  expect(input.value).toBe("");
  expect(textarea.value).toBe("");
  await act(async () => { root.unmount(); });
});

test("2. Save PUTs the full list with the new layer appended", async () => {
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot({ custom: [layer()] }) });
    // An EXISTING layer, so a write that replaced the list instead of appending to
    // it would be caught. Starting from empty made the two indistinguishable.
    return json(snapshot({ custom: [layer({ id: "zzzzzz", title: "Already here" })] }));
  });
  const { container, root } = await mount();
  const blank = await addButton(container);
  await act(async () => { blank.click(); });
  const input = dialog().querySelector("input[type=\"text\"]") as HTMLInputElement;
  const textarea = dialog().querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    typeInto(input, "House rules");
    typeInto(textarea, "Be brief.");
  });
  const save = [...dialog().querySelectorAll("button")].find(b => (b.textContent ?? "").includes("Save"))!;
  await act(async () => { save.click(); });
  const put = calls.find(c => c.method === "PUT")!;
  expect(put.url).toBe("/api/codex-prompt/custom");
  expect(put.body.layers).toHaveLength(2);
  expect(put.body.layers[0].id).toBe("zzzzzz");
  expect(put.body.layers[1].title).toBe("House rules");
  expect(put.body.layers[1].body).toBe("Be brief.");
  expect(put.body.layers[1].id).toMatch(/^[a-z0-9]{6}$/);
  expect(put.body.revision).toBe("sha256:one");
  await act(async () => { root.unmount(); });
});

test("3. editing changes title and body but keeps the id", async () => {
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot({ custom: [layer({ title: "Renamed" })] }) });
    return json(snapshot({ custom: [layer(), layer({ id: "zzzzzz", title: "Untouched" })] }));
  });
  const { container, root } = await mount();
  await act(async () => { (customRow(container, "aaaaaa")!.querySelector("button") as HTMLButtonElement).click(); });
  const input = dialog().querySelector("input[type=\"text\"]") as HTMLInputElement;
  expect(input.value).toBe("House rules");
  await act(async () => {
    typeInto(input, "Renamed");
    typeInto(dialog().querySelector("textarea") as HTMLTextAreaElement, "Different body.");
  });
  const save = [...dialog().querySelectorAll("button")].find(b => (b.textContent ?? "").includes("Save"))!;
  await act(async () => { save.click(); });
  const put = calls.find(c => c.method === "PUT")!;
  expect(put.body.layers[0].id).toBe("aaaaaa");
  expect(put.body.layers[0].title).toBe("Renamed");
  expect(put.body.layers[0].body).toBe("Different body.");
  // The sibling survives untouched: an edit must not rewrite its neighbours.
  expect(put.body.layers[1]).toEqual({ id: "zzzzzz", title: "Untouched", body: "Be brief.", enabled: true });
  await act(async () => { root.unmount(); });
});

test("4. toggling a custom layer PUTs with enabled flipped", async () => {
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot({ custom: [layer({ enabled: false })] }) });
    return json(snapshot({ custom: [layer()] }));
  });
  const { container, root } = await mount();
  const sw = customRow(container, "aaaaaa")!.querySelector("button[role=\"switch\"]") as HTMLInputElement;
  await act(async () => { sw.click(); });
  const put = calls.find(c => c.method === "PUT")!;
  expect(put.body.layers[0].enabled).toBe(false);
  expect(put.body.layers[0].id).toBe("aaaaaa");
  await act(async () => { root.unmount(); });
});

test("5. delete confirms first, then PUTs without the row", async () => {
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot({ custom: [] }) });
    // Two rows: deleting the sole row could not distinguish "removed this one"
    // from "cleared everything".
    return json(snapshot({ custom: [layer(), layer({ id: "bbbbbb", title: "Keeper" })] }));
  });
  const { container, root } = await mount();
  const del = customRow(container, "aaaaaa")!.querySelector(".codex-set-custom__delete") as HTMLButtonElement;
  await act(async () => { del.click(); });
  // A body can be long and there is no undo, so nothing is written yet.
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(0);
  const confirm = container.querySelector(".codex-set-custom__confirm .btn-danger") as HTMLButtonElement;
  await act(async () => { confirm.click(); });
  const remaining = calls.find(c => c.method === "PUT")!.body.layers;
  expect(remaining).toHaveLength(1);
  expect(remaining[0].id).toBe("bbbbbb");
  await act(async () => { root.unmount(); });
});

test("6+7. reorder PUTs the new order and works from the keyboard", async () => {
  const two = [layer(), layer({ id: "bbbbbb", title: "Second", body: "Then this." })];
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot({ custom: [two[1]!, two[0]!] }) });
    return json(snapshot({ custom: two }));
  });
  const { container, root } = await mount();
  // Buttons, not a drag handle: a drag-only affordance is not reachable.
  const up = customRow(container, "bbbbbb")!.querySelectorAll(".codex-set-custom__reorder button")[0] as HTMLButtonElement;
  expect(up.disabled).toBe(false);
  await act(async () => { up.click(); });
  const put = calls.find(c => c.method === "PUT")!;
  expect(put.body.layers.map(l => l.id)).toEqual(["bbbbbb", "aaaaaa"]);
  await act(async () => { root.unmount(); });
});

test("8+9. Escape asks when dirty and closes immediately when clean", async () => {
  stubRoutes(() => json(snapshot({ custom: [layer()] })));
  const { container, root } = await mount();
  await act(async () => { (customRow(container, "aaaaaa")!.querySelector("button") as HTMLButtonElement).click(); });
  // Clean: closes at once.
  await act(async () => { dialog().dispatchEvent(new testWindow.Event("cancel", { cancelable: true })); });
  expect(document.querySelector("dialog.modal-overlay")).toBeNull();

  await act(async () => { (customRow(container, "aaaaaa")!.querySelector("button") as HTMLButtonElement).click(); });
  const textarea = dialog().querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    typeInto(textarea, "Changed.");
  });
  await act(async () => { dialog().dispatchEvent(new testWindow.Event("cancel", { cancelable: true })); });
  // Dirty: still open, asking. A textarea someone typed into is not a glance.
  expect(document.querySelector("dialog.modal-overlay")).not.toBeNull();
  expect(dialog().querySelector(".codex-set-custom-dialog__discard")).not.toBeNull();
  await act(async () => { root.unmount(); });
});

test("10. each validation rule disables Save with its message", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const blank = await addButton(container);
  await act(async () => { blank.click(); });
  const input = dialog().querySelector("input[type=\"text\"]") as HTMLInputElement;
  const textarea = dialog().querySelector("textarea") as HTMLTextAreaElement;
  const save = () => [...dialog().querySelectorAll("button")].find(b => (b.textContent ?? "").includes("Save")) as HTMLButtonElement;
  // Empty title.
  expect(save().disabled).toBe(true);
  // Every blocking rule, each with the message that names it - a generic alert
  // check would pass while telling the user the wrong thing.
  const cases: Array<[string, string, string]> = [
    ["x".repeat(81), "ok", "81"],
    ["fine", "a\u0007b", "1"],
    ["fine", "y".repeat(64 * 1024 + 1), "65537"],
  ];
  for (const [title, body, needle] of cases) {
    await act(async () => {
      typeInto(input, title);
      typeInto(textarea, body);
    });
    expect(save().disabled, needle).toBe(true);
    const alert = dialog().querySelector("[role=\"alert\"]");
    expect(alert, needle).not.toBeNull();
    expect(alert!.textContent, needle).toContain(needle);
  }
  // And a valid draft re-enables Save, so the disabled state tracks the problem
  // rather than being stuck on.
  await act(async () => {
    typeInto(input, "fine");
    typeInto(textarea, "Be brief.");
  });
  expect(save().disabled).toBe(false);
  await act(async () => { root.unmount(); });
});

test("11. a rejected PUT restores the previous list", async () => {
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: false, code: "developer_instructions_not_owned", message: "refused" }, 409);
    return json(snapshot({ custom: [layer()] }));
  });
  const { container, root } = await mount();
  const sw = customRow(container, "aaaaaa")!.querySelector("button[role=\"switch\"]") as HTMLInputElement;
  await act(async () => { sw.click(); });
  expect(container.querySelector("[role=\"alert\"]")).not.toBeNull();
  const after = customRow(container, "aaaaaa")!.querySelector("button[role=\"switch\"]") as HTMLInputElement;
  expect(after.getAttribute("aria-checked")).toBe("true");
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
  await act(async () => { root.unmount(); });
});

test("12. built-in rows still have no delete control", async () => {
  // Ask item 6 from the custom side: adding delete to one row family must not
  // leak it into the other.
  stubRoutes(() => json(snapshot({ custom: [layer()] })));
  const { container, root } = await mount();
  for (const d of INVENTORY) {
    const el = container.querySelector("[data-layer-id=\"" + d.id + "\"]");
    if (!el) continue;
    expect(el.querySelector(".codex-set-custom__delete"), d.id).toBeNull();
  }
  expect(customRow(container, "aaaaaa")!.querySelector(".codex-set-custom__delete")).not.toBeNull();
  await act(async () => { root.unmount(); });
});

test("14+15+16. an unowned key hides + and offers a previewed Adopt", async () => {
  const calls = stubRoutes(call => {
    if (call.url.includes("/adopt")) {
      if (call.body?.confirm === true) {
        return json({ ok: true, changed: true, snapshot: snapshot({ custom: [layer({ title: "Imported from config.toml" })] }) });
      }
      return json({ ok: true, changed: false, preview: { rawLine: "developer_instructions = \"Answer in Korean.\"", decodedBody: "Answer in Korean." } });
    }
    return json(snapshot({ developerInstructionsOwned: false, developerInstructionsState: "external" }));
  });
  const { container, root } = await mount();
  expect(addTrigger(container)).toBeNull();
  const adopt = container.querySelector(".codex-set-custom__adopt button") as HTMLButtonElement;
  await act(async () => { adopt.click(); });
  // Preview writes nothing and shows the user their own text first.
  expect(container.querySelector(".codex-set-custom__adopt-preview")!.textContent).toBe("Answer in Korean.");
  expect(calls.filter(c => c.body?.confirm === true)).toHaveLength(0);
  const confirm = container.querySelector(".codex-set-custom__adopt .btn-primary") as HTMLButtonElement;
  await act(async () => { confirm.click(); });
  expect(calls.filter(c => c.body?.confirm === true)).toHaveLength(1);
  await act(async () => { root.unmount(); });
});

test("17+18+19. bodies round-trip, tabs and CRLF normalize, control chars are refused", async () => {
  expect(normalizeBody("a\tb\r\nc")).toBe("a    b\nc");
  expect(normalizeBody("quote \" and back\\slash")).toBe("quote \" and back\\slash");
  const bad = validateDraft({ id: null, title: "t", body: "ok\u0007bad", enabled: true }, []);
  expect(bad).toEqual({ kind: "invalid-character", position: 2 });
  expect(validateDraft({ id: null, title: "t", body: "fine", enabled: true }, [])).toBeNull();
});

test("13. a stale revision re-reads instead of retrying blindly", async () => {
  let gets = 0;
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: false, code: "stale_revision" }, 409);
    gets += 1;
    return json(snapshot({ custom: [layer()], revision: gets > 1 ? "sha256:fresh" : "sha256:one" }));
  });
  const { container, root } = await mount();
  await act(async () => { (customRow(container, "aaaaaa")!.querySelector("button[role=\"switch\"]") as HTMLInputElement).click(); });
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
  // The refreshed revision must be INSTALLED: the next write has to carry it.
  await act(async () => { (customRow(container, "aaaaaa")!.querySelector("button[role=\"switch\"]") as HTMLInputElement).click(); });
  const puts = calls.filter(c => c.method === "PUT");
  expect(puts).toHaveLength(2);
  expect(puts[1]!.body.revision).toBe("sha256:fresh");
  await act(async () => { root.unmount(); });
});

test("21+22+23. the linter flags each rule, spans the right text, and stays quiet on clean prose", async () => {
  const identity = lintPromptLayer("You are Claude, a helpful assistant.");
  expect(identity.map(f => f.rule)).toContain("identity");
  // The span covers the matched phrase itself, "You are Claude" - 14 characters,
  // not the sentence - so highlighting points at the claim rather than the line.
  expect(identity[0]!.span).toEqual([0, 14]);
  expect("You are Claude, a helpful assistant.".slice(0, 14)).toBe("You are Claude");

  expect(lintPromptLayer("Use the Read tool first.").map(f => f.rule)).toContain("foreign-tool");
  expect(lintPromptLayer("Run ${{ tools.by_kind.edit }} now.").map(f => f.rule)).toContain("placeholder");
  expect(lintPromptLayer("apply_patch must be used for edits.").map(f => f.rule)).toContain("apply-patch");
  expect(lintPromptLayer("Use acceptEdits when unsure.").map(f => f.rule)).toContain("approval-vocab");
  expect(lintPromptLayer("Your cwd is /tmp.").map(f => f.rule)).toContain("environment");

  // Behavioral text - the shape every preset takes - produces nothing.
  expect(lintPromptLayer("Answer in Korean. Keep replies short and state the plan first.")).toEqual([]);

  // Every content rule is a WARNING, not an error: the level is what keeps the
  // linter advisory, and a rule promoted to blocking would change behaviour
  // silently.
  for (const sample of [
    "You are Claude.",
    "Use the Read tool.",
    "Run ${{ x }}.",
    "apply_patch must be used.",
    "Use acceptEdits.",
    "Your cwd is /tmp.",
  ]) {
    const found = lintPromptLayer(sample);
    expect(found.length, sample).toBeGreaterThan(0);
    for (const finding of found) expect(finding.level, sample).toBe("warn");
  }

  // Advisory, never a warning: the 8 KB cap is opencodex policy, not an upstream limit.
  const big = lintPromptLayer("x".repeat(8 * 1024 + 1));
  expect(big).toHaveLength(1);
  expect(big[0]!.level).toBe("info");
});

test("24. no rule throws on empty, whitespace, or a 64 KiB body", () => {
  expect(() => lintPromptLayer("")).not.toThrow();
  expect(() => lintPromptLayer("   \n\n  ")).not.toThrow();
  expect(() => lintPromptLayer("y".repeat(64 * 1024))).not.toThrow();
  // A second lint of the same text must find the same things: a shared /g regex
  // carries lastIndex between calls and would miss the first match.
  const once = lintPromptLayer("You are Claude.");
  const twice = lintPromptLayer("You are Claude.");
  expect(twice).toEqual(once);
});

test("moveLayer reorders without mutating its input", () => {
  const layers = [layer(), layer({ id: "bbbbbb" }), layer({ id: "cccccc" })];
  const moved = moveLayer(layers, "cccccc", -1);
  expect(moved.map(l => l.id)).toEqual(["aaaaaa", "cccccc", "bbbbbb"]);
  expect(layers.map(l => l.id)).toEqual(["aaaaaa", "bbbbbb", "cccccc"]);
  // Edges are no-ops rather than errors.
  expect(moveLayer(layers, "aaaaaa", -1).map(l => l.id)).toEqual(["aaaaaa", "bbbbbb", "cccccc"]);
});

test("a first run can create its first layer", async () => {
  // developerInstructionsOwned is false both when the key is ABSENT and when it is
  // EXTERNAL. Treating both as external hid + from every new user and offered them
  // an Adopt that answers nothing_to_adopt - the feature was unreachable on a fresh
  // machine, which is the state most users start from.
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: true, changed: true, snapshot: snapshot({ custom: [layer()] }) });
    return json(snapshot({
      developerInstructionsOwned: false,
      developerInstructionsState: "absent",
      configExists: false,
      custom: [],
    }));
  });
  const { container, root } = await mount();
  expect(addTrigger(container)).not.toBeNull();
  expect(container.querySelector(".codex-set-custom__adopt")).toBeNull();

  const blank = await addButton(container);
  await act(async () => { blank.click(); });
  const input = dialog().querySelector("input[type=\"text\"]") as HTMLInputElement;
  const textarea = dialog().querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    typeInto(input, "House rules");
    typeInto(textarea, "Be brief.");
  });
  const save = [...dialog().querySelectorAll("button")].find(b => (b.textContent ?? "").includes("Save"))!;
  await act(async () => { save.click(); });
  expect(calls.find(c => c.method === "PUT")!.body.layers).toHaveLength(1);
  await act(async () => { root.unmount(); });
});

test("a refused save keeps the editor open with the text still in it", async () => {
  // Closing first threw the draft away on every rejection, and the re-read that
  // follows restores the file but not text that no longer exists anywhere.
  stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: false, code: "stale_revision" }, 409);
    return json(snapshot());
  });
  const { container, root } = await mount();
  const blank = await addButton(container);
  await act(async () => { blank.click(); });
  const input = dialog().querySelector("input[type=\"text\"]") as HTMLInputElement;
  const textarea = dialog().querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    typeInto(input, "Worth keeping");
    typeInto(textarea, "Please do not lose this.");
  });
  const save = [...dialog().querySelectorAll("button")].find(b => (b.textContent ?? "").includes("Save"))!;
  await act(async () => { save.click(); });

  expect(document.querySelector("dialog.modal-overlay")).not.toBeNull();
  expect((dialog().querySelector("input[type=\"text\"]") as HTMLInputElement).value).toBe("Worth keeping");
  expect((dialog().querySelector("textarea") as HTMLTextAreaElement).value).toBe("Please do not lose this.");
  await act(async () => { root.unmount(); });
});

test("the delete confirmation names the layer it will remove", async () => {
  stubRoutes(() => json(snapshot({ custom: [layer(), layer({ id: "bbbbbb", title: "Second rules" })] })));
  const { container, root } = await mount();
  const del = customRow(container, "bbbbbb")!.querySelector(".codex-set-custom__delete") as HTMLButtonElement;
  await act(async () => { del.click(); });
  expect(container.querySelector(".codex-set-custom__confirm")!.textContent).toContain("Second rules");
  await act(async () => { root.unmount(); });
});

test("Save cannot be pressed twice while a write is in flight", async () => {
  // Keeping the editor open so a refusal cannot discard a draft also left Save
  // reachable mid-write. Two full-replacement PUTs would leave with the same
  // revision: one lands, the other returns stale, and the user is shown an error
  // for work that actually succeeded.
  let release: (() => void) | null = null;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.method === "PUT") {
      await new Promise<void>(resolve => { release = resolve; });
      return json({ ok: true, changed: true, snapshot: snapshot({ custom: [layer()] }) });
    }
    return json(snapshot());
  }) as typeof fetch;

  const { container, root } = await mount();
  const blank = await addButton(container);
  await act(async () => { blank.click(); });
  const input = dialog().querySelector("input[type=\"text\"]") as HTMLInputElement;
  const textarea = dialog().querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    typeInto(input, "House rules");
    typeInto(textarea, "Be brief.");
  });
  const save = () => [...dialog().querySelectorAll("button")].find(b => (b.textContent ?? "").includes("Save")) as HTMLButtonElement;
  await act(async () => { save().click(); });

  expect(save().disabled).toBe(true);
  await act(async () => { save().click(); });
  expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);

  await act(async () => { release!(); await new Promise(r => setTimeout(r, 0)); });
  await act(async () => { root.unmount(); });
});

test("an unreadable config refuses custom writes too, not only built-in switches", async () => {
  // Offering an editor over a file we cannot read trades a disabled control for a
  // server rejection after the user has typed.
  stubRoutes(() => json(snapshot({ readable: false, custom: [layer()] })));
  const { container, root } = await mount();
  expect(addTrigger(container)!.disabled).toBe(true);
  const row = customRow(container, "aaaaaa")!;
  expect((row.querySelector("button[role=\"switch\"]") as HTMLInputElement).disabled).toBe(true);
  expect((row.querySelector(".codex-set-custom__delete") as HTMLButtonElement).disabled).toBe(true);
  for (const button of row.querySelectorAll(".codex-set-custom__reorder button")) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  await act(async () => { root.unmount(); });
});

test("the undo window suspends while its restore write is in flight", async () => {
  // Clicking Undo near the deadline must not have the offer expire underneath a
  // pending request: the window freezes for the write and restarts on failure.
  const { setUndoWindowMsForTests } = await import("../src/components/codex-set/custom-layer-state");
  setUndoWindowMsForTests(120);
  try {
    const both = [layer(), layer({ id: "bbbbbb", title: "Keeper" })];
    let current = both;
    let releaseRestore: (() => void) | null = null;
    let restoreFails = false;
    stubRoutes(call => {
      if (call.method !== "PUT") return json(snapshot({ custom: current }));
      // The restore PUT carries the full list back; the delete PUT drops a row.
      const layers = call.body.layers ?? [];
      if (layers.length >= 2) {
        return new Promise<Response>(resolve => {
          releaseRestore = () => resolve(restoreFails
            ? json({ ok: false, code: "stale_revision", message: "moved" }, 409)
            : json({ ok: true, changed: true, snapshot: snapshot({ custom: current = both }) }));
        });
      }
      current = layers as typeof both;
      return json({ ok: true, changed: true, snapshot: snapshot({ custom: current }) });
    });
    const { container, root } = await mount();
    const deletedNotice = () => container.querySelector(".codex-set-custom__deleted");
    const sleep = (ms: number) => act(async () => { await Bun.sleep(ms); });

    await act(async () => {
      (customRow(container, "aaaaaa")!.querySelector(".codex-set-custom__delete") as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector(".codex-set-custom__confirm .btn-danger") as HTMLButtonElement).click();
    });
    expect(deletedNotice()).not.toBeNull();

    // ~40ms in, well inside the 120ms window: click Undo and hold the response
    // past the ORIGINAL deadline.
    await sleep(40);
    restoreFails = true;
    await act(async () => {
      (deletedNotice()!.querySelector("button") as HTMLButtonElement).click();
    });
    await sleep(140); // past 40+120 - a live timer would have fired already
    expect(deletedNotice()).not.toBeNull();

    // The failed restore keeps the offer and RESTARTS the window rather than
    // silently dropping it - it expires a full window after the refusal.
    await act(async () => { releaseRestore!(); });
    await sleep(40);
    expect(deletedNotice()).not.toBeNull();
    await sleep(140);
    expect(deletedNotice()).toBeNull();

    // And a restore that lands closes the notice itself, not the timer. The
    // first row is restored in a fresh two-layer snapshot for this attempt.
    current = both;
    const { setClientResourceData } = await import("../src/client-resource");
    await act(async () => { setClientResourceData("codex-prompt:", snapshot({ custom: both })); });
    await act(async () => {
      (customRow(container, "aaaaaa")!.querySelector(".codex-set-custom__delete") as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector(".codex-set-custom__confirm .btn-danger") as HTMLButtonElement).click();
    });
    expect(deletedNotice()).not.toBeNull();
    restoreFails = false;
    await act(async () => {
      (deletedNotice()!.querySelector("button") as HTMLButtonElement).click();
    });
    await sleep(140); // the successful response is still held past the original deadline
    expect(deletedNotice()).not.toBeNull();
    expect(customRow(container, "aaaaaa")).toBeNull();
    await act(async () => { releaseRestore!(); await new Promise(r => setTimeout(r, 0)); });
    expect(deletedNotice()).toBeNull();
    await act(async () => { root.unmount(); });
  } finally {
    setUndoWindowMsForTests(null);
  }
});

test("a lone surrogate is refused client-side, like the server refuses it", () => {
  // Not a Unicode scalar value, so it has no UTF-8 encoding at all. Accepting it
  // here left Save enabled on text that could only fail after submission.
  const lone = "ok" + String.fromCharCode(0xd800) + "bad";
  expect(validateDraft({ id: null, title: "t", body: lone, enabled: true }, []))
    .toEqual({ kind: "invalid-character", position: 2 });
  // A PAIRED surrogate is an ordinary character and must still be accepted.
  expect(validateDraft({ id: null, title: "t", body: "emoji \u{1f600} fine", enabled: true }, [])).toBeNull();
});

test("lint findings never disable Save", () => {
  // The whole point of warn-not-block: a user who means to override Codex may.
  const body = "You are Claude. Use the Read tool. Your cwd is /tmp.";
  expect(lintPromptLayer(body).length).toBeGreaterThan(2);
  expect(validateDraft({ id: null, title: "Override", body, enabled: true }, [])).toBeNull();
});

test("composed overflow and the 32-layer ceiling are both refused", async () => {
  // The two limits case 10 could not reach through the editor: one depends on the
  // OTHER enabled layers, the other on how many rows already exist.
  const bulky = { id: "zzzzzz", title: "Bulky", body: "y".repeat(70 * 1024), enabled: true };
  const draft = { id: null, title: "Another", body: "z".repeat(60 * 1024), enabled: true };
  // Each body is under the 64 KiB per-layer cap; together they exceed 128 KiB.
  expect(validateDraft(draft, [bulky])).toEqual({ kind: "composed-too-large", bytes: 133122 });
  // A disabled neighbour does not count toward the projection.
  expect(validateDraft(draft, [{ ...bulky, enabled: false }])).toBeNull();

  const full = Array.from({ length: 32 }, (_, i) => layer({ id: String(i).padStart(6, "a").slice(-6) }));
  stubRoutes(() => json(snapshot({ custom: full })));
  const { container, root } = await mount();
  expect(addTrigger(container)!.disabled).toBe(true);
  expect(container.textContent).toContain("32");
  await act(async () => { root.unmount(); });
});


test("20. every drift state renders a Repair action instead of self-healing", async () => {
  // Two of the four branches rewrite content the user authored, so nothing is
  // repaired silently: the state is named and the action is explicit.
  for (const drift of ["journal-present", "projection-stale", "store-missing", "owned-malformed"] as const) {
    clearClientResourceStoresForTests();
    const calls = stubRoutes(call => {
      if (call.url.includes("/repair")) return json({ ok: true, changed: true, snapshot: snapshot({ drift: null }) });
      return json(snapshot({ drift }));
    });
    const { container, root } = await mount();
    const banner = container.querySelector("[data-drift]");
    expect(banner, drift).not.toBeNull();
    expect(banner!.getAttribute("data-drift")).toBe(drift);
    // The message describes THIS state, not a generic "something is wrong".
    expect((banner!.textContent ?? "").length, drift).toBeGreaterThan(30);

    await act(async () => { (banner!.querySelector("button") as HTMLButtonElement).click(); });
    // Every drift — journal-present included — goes through /repair. The route
    // replays the journal as a locked recovery-only operation; a layers PUT
    // would have projected the empty custom list over a surviving projection.
    const repair = calls.find(c => c.url.includes("/repair"))!;
    expect(repair, drift).toBeDefined();
    expect(repair.body.confirm, drift).toBe(true);
    expect(repair.body.revision, drift).toBe("sha256:one");
    expect(calls.some(c => c.method === "PUT" && c.url.endsWith("/api/codex-prompt/custom")), drift).toBe(false);
    await act(async () => { root.unmount(); });
  }
});

test("16. an unsupported adopt names the file and line to move by hand", async () => {
  // "Could not be imported" leaves the user with nothing to act on. The path and
  // line are what let them find the text.
  stubRoutes(call => {
    if (call.url.includes("/adopt")) {
      return json({
        ok: false,
        code: "adopt_unsupported_form",
        message: "only a single-line basic string can be decoded safely",
        path: "/tmp/config.toml",
        line: 7,
        rawLine: "developer_instructions = '''multi",
      }, 409);
    }
    return json(snapshot({ developerInstructionsOwned: false, developerInstructionsState: "external" }));
  });
  const { container, root } = await mount();
  await act(async () => { (container.querySelector(".codex-set-custom__adopt button") as HTMLButtonElement).click(); });
  const refusal = container.querySelector(".codex-set-custom__adopt-refusal");
  expect(refusal).not.toBeNull();
  expect(refusal!.textContent).toContain("/tmp/config.toml");
  expect(refusal!.textContent).toContain("7");
  await act(async () => { root.unmount(); });
});

test("Repair refreshes a stale revision before the next explicit attempt", async () => {
  let revision = "sha256:one";
  const calls = stubRoutes(call => {
    if (call.url.endsWith("/repair")) {
      if (call.body.revision === "sha256:one") {
        revision = "sha256:two";
        return json({ ok: false, code: "stale_revision", message: "moved" }, 409);
      }
      return json({ ok: true, snapshot: snapshot({ revision, drift: null }) });
    }
    return json(snapshot({ revision, drift: "journal-present" }));
  });
  const { root, container } = await mount();
  try {
    const repair = () => container.querySelector(".codex-set-prompt__drift button") as HTMLButtonElement;
    await act(async () => { repair().click(); });
    await act(async () => { repair().click(); });
    expect(calls.filter(c => c.url.endsWith("/repair")).map(c => c.body.revision))
      .toEqual(["sha256:one", "sha256:two"]);
    expect(container.querySelector(".codex-set-prompt__drift")).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
  }
});

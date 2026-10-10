/**
 * The base-prompt variant picker (devlog 020, amended by 021).
 *
 * Three properties matter and each would be wrong alone: the default is unreachable by
 * an editor, the ring moves by swipe AND by keyboard, and the external state refuses to
 * act rather than retargeting a key somebody else set.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import CodexSetPrompt from "../src/pages/codex-set-prompt";
import { LAYER_INVENTORY } from "../../src/codex/prompt-layers";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
const INVENTORY = LAYER_INVENTORY.map(d => ({ ...d }));

const VARIANTS = [
  { id: "aaa111", title: "Terse", body: "Be brief.", bytes: 20 },
  { id: "bbb222", title: "Formal", body: "Answer formally.", bytes: 26 },
];

function snapshot(over: Record<string, unknown> = {}) {
  return {
    configPath: "/tmp/config.toml",
    storePath: "/tmp/opencodex-prompt.json",
    configExists: true,
    readable: true,
    developerInstructionsOwned: false,
    developerInstructionsState: "absent" as const,
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

interface Call { url: string; method: string; body: Record<string, unknown> | undefined }
function stubRoutes(handler: (call: Call) => Response) {
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

function baseRow(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-layer-id="base-instructions"]') as HTMLElement;
}

async function openBaseDialog(container: HTMLElement): Promise<HTMLElement> {
  await act(async () => {
    (baseRow(container).querySelector(".codex-set-prompt__name") as HTMLButtonElement).click();
  });
  return document.querySelector("dialog.codex-set-base-dialog") as HTMLElement;
}

function position(dlg: HTMLElement): string {
  return (dlg.querySelector(".codex-set-base-dialog__pos")?.textContent ?? "").trim();
}

function slotKind(dlg: HTMLElement): string | null {
  return dlg.querySelector(".codex-set-base-dialog__pos")?.getAttribute("data-slot-kind") ?? null;
}

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

function actionButton(dlg: HTMLElement, needle: string): HTMLButtonElement {
  return [...dlg.querySelectorAll(".modal-actions button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes(needle)) as HTMLButtonElement;
}
test("the base row carries a switch that reads on for the default", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const sw = baseRow(container).querySelector('button[role="switch"]') as HTMLButtonElement;
  // A real switch, not a disabled placeholder: base now has an off-position.
  expect(sw).not.toBeNull();
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(sw.disabled).toBe(false);
  await act(async () => { root.unmount(); });
});

test("the default slot has no editor and no Save, and says why", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: VARIANTS })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);

  expect(slotKind(dlg)).toBe("default");
  // Read-only by construction. Asserting the ABSENCE of the inputs is the point: a
  // disabled textarea would still tell the user a body exists to edit.
  expect(dlg.querySelector("textarea")).toBeNull();
  expect(dlg.querySelector("input")).toBeNull();
  const labels = [...dlg.querySelectorAll("button")].map(b => (b.textContent ?? "").toLowerCase());
  expect(labels.some(l => l.includes("save"))).toBe(false);
  expect(labels.some(l => l.includes("delete"))).toBe(false);
  // And it explains itself rather than just withholding controls.
  expect(dlg.textContent ?? "").toContain("model_instructions_file");
  await act(async () => { root.unmount(); });
});

test("the arrow buttons step the ring and it wraps at both ends", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: VARIANTS })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  // Default + two variants; the new slot is absent because the cap is reached.
  expect(position(dlg)).toBe("1 / 3");

  const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
  const prev = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[0] as HTMLButtonElement;
  await act(async () => { next.click(); });
  expect(position(dlg)).toBe("2 / 3");
  expect(slotKind(dlg)).toBe("variant");
  // The editor follows the slot.
  expect((dlg.querySelector("input") as HTMLInputElement).value).toBe("Terse");

  await act(async () => { next.click(); });
  expect((dlg.querySelector("input") as HTMLInputElement).value).toBe("Formal");

  // Wrap forward, then wrap backward: a three-slot ring must not dead-end.
  await act(async () => { next.click(); });
  expect(position(dlg)).toBe("1 / 3");
  await act(async () => { prev.click(); });
  expect(position(dlg)).toBe("3 / 3");
  await act(async () => { root.unmount(); });
});

test("ArrowRight and ArrowLeft step the ring, but not while typing", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: VARIANTS })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);

  const key = (target: EventTarget, k: string) => {
    const event = new testWindow.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(event as unknown as Event);
  };

  await act(async () => { key(dlg, "ArrowRight"); });
  expect(position(dlg)).toBe("2 / 3");
  await act(async () => { key(dlg, "ArrowLeft"); });
  expect(position(dlg)).toBe("1 / 3");

  // A textarea is where the prompt is written, so an arrow key there is cursor
  // movement. Navigating on it would move the user off the text they are editing.
  await act(async () => { key(dlg, "ArrowRight"); });
  const textarea = dlg.querySelector("textarea")!;
  const before = position(dlg);
  await act(async () => { key(textarea, "ArrowRight"); });
  expect(position(dlg)).toBe(before);
  await act(async () => { root.unmount(); });
});

test("a horizontal swipe steps the ring; a vertical drag does not", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: VARIANTS })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);

  const pointer = (type: string, x: number, y: number) => {
    const event = new testWindow.Event(type, { bubbles: true, cancelable: true }) as unknown as PointerEvent;
    Object.defineProperty(event, "clientX", { value: x });
    Object.defineProperty(event, "clientY", { value: y });
    dlg.dispatchEvent(event as unknown as Event);
  };

  // Left-to-right past the threshold moves backward, which wraps to the last slot.
  await act(async () => { pointer("pointerdown", 200, 100); pointer("pointerup", 20, 104); });
  expect(position(dlg)).toBe("2 / 3");

  // Mostly VERTICAL travel is a scroll, even though its horizontal component clears
  // the threshold. Without the dominance check, reading a long prompt throws the
  // user onto another variant mid-scroll.
  const held = position(dlg);
  await act(async () => { pointer("pointerdown", 200, 100); pointer("pointerup", 130, 600); });
  expect(position(dlg)).toBe(held);

  // And a small horizontal jitter is not a swipe either.
  await act(async () => { pointer("pointerdown", 200, 100); pointer("pointerup", 180, 100); });
  expect(position(dlg)).toBe(held);
  await act(async () => { root.unmount(); });
});

test("choosing a variant PUTs the selection with the current revision", async () => {
  const calls = stubRoutes(call => (call.method === "PUT"
    ? json({ ok: true, snapshot: snapshot({ baseVariants: VARIANTS, baseSelection: { kind: "variant", id: "aaa111" }, revision: "sha256:two" }) })
    : json(snapshot({ baseVariants: VARIANTS }))));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
  await act(async () => { next.click(); });

  const use = [...dlg.querySelectorAll(".modal-actions button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("use")) as HTMLButtonElement;
  await act(async () => { use.click(); });

  const put = calls.find(c => c.method === "PUT")!;
  expect(put.url).toContain("/api/codex-prompt/base/select");
  expect(put.body).toMatchObject({ kind: "variant", id: "aaa111", revision: "sha256:one" });
  await act(async () => { root.unmount(); });
});

test("the external state blocks the picker instead of retargeting the key", async () => {
  const calls = stubRoutes(() => json(snapshot({
    baseVariants: VARIANTS,
    baseSelection: { kind: "external", path: "/etc/somebody-elses.md" },
  })));
  const { container, root } = await mount();

  // The switch cannot claim Codex own prompt is in force when it is not.
  const sw = baseRow(container).querySelector('button[role="switch"]') as HTMLButtonElement;
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(sw.disabled).toBe(true);

  const dlg = await openBaseDialog(container);
  expect(dlg.querySelector(".notice-err")).not.toBeNull();
  expect(dlg.textContent ?? "").toContain("/etc/somebody-elses.md");

  // Every action is inert, and nothing was written on the way to finding out.
  const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
  await act(async () => { next.click(); });
  for (const button of [...dlg.querySelectorAll(".modal-actions button")] as HTMLButtonElement[]) {
    const label = (button.textContent ?? "").toLowerCase();
    if (label.includes("close")) continue;
    expect(button.disabled, label).toBe(true);
  }
  expect(calls.every(c => c.method === "GET")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("the new slot appears only while there is room under the cap", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: [VARIANTS[0]!] })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  // Default + one variant + one empty slot: adding is the same gesture as choosing.
  expect(position(dlg)).toBe("1 / 3");
  const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
  await act(async () => { next.click(); });
  await act(async () => { next.click(); });
  expect(slotKind(dlg)).toBe("new");
  // An empty slot has an editor but nothing to delete or select yet.
  expect(dlg.querySelector("textarea")).not.toBeNull();
  const labels = [...dlg.querySelectorAll(".modal-actions button")].map(b => (b.textContent ?? "").toLowerCase());
  expect(labels.some(l => l.includes("delete"))).toBe(false);
  await act(async () => { root.unmount(); });
});

test("the dot indicator renders one dot per slot and marks the active one", async () => {
  stubRoutes(() => json(snapshot({ baseVariants: [VARIANTS[0]!] })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  // Default + one variant + one empty slot = 3 dots
  const dots = dlg.querySelectorAll(".codex-set-base-dialog__dot");
  expect(dots.length).toBe(3);
  expect(dots[0]!.classList.contains("active")).toBe(true);
  expect(dots[1]!.classList.contains("active")).toBe(false);
  // Step forward and the active dot moves
  const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
  await act(async () => { next.click(); });
  const dotsAfter = dlg.querySelectorAll(".codex-set-base-dialog__dot");
  expect(dotsAfter[0]!.classList.contains("active")).toBe(false);
  expect(dotsAfter[1]!.classList.contains("active")).toBe(true);
  await act(async () => { root.unmount(); });
});

test("a failed delete keeps the parked draft for the variant that survived", async () => {
  // The write was refused, so nothing was deleted. Reconciling drafts against
  // the destination text cannot tell that from a real delete, so the check is
  // the variant id: if the id is still in the snapshot, its draft stays.
  stubRoutes(call => {
    if (call.method === "PUT" && call.url.endsWith("/api/codex-prompt/base")) {
      return json({ ok: false, code: "stale_revision", message: "moved" }, 409);
    }
    // The refresh after a stale revision returns the variant list intact.
    return json(snapshot({ baseVariants: VARIANTS }));
  });
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  const nav = dlg.querySelectorAll(".codex-set-base-dialog__nav button");
  const prev = nav[0] as HTMLButtonElement;
  const next = nav[1] as HTMLButtonElement;

  await act(async () => { next.click(); }); // -> aaa111
  const input = dlg.querySelector("input") as HTMLInputElement;
  const textarea = dlg.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    typeInto(input, "Edited title");
    typeInto(textarea, "Edited body.");
  });
  await act(async () => { actionButton(dlg, "delete").click(); });
  expect(slotKind(dlg)).toBe("variant"); // still on aaa111, not deleted

  // Park the draft by leaving, then come back. The draft rides the id, not the
  // text, so it survives the failed delete round trip.
  await act(async () => { next.click(); }); // -> bbb222
  await act(async () => { prev.click(); }); // -> aaa111
  expect(input.value).toBe("Edited title");
  expect(textarea.value).toBe("Edited body.");
  await act(async () => { root.unmount(); });
});

test("a draft identical to the DESTINATION text is still parked on its own id", async () => {
  // Editing aaa111 into a byte copy of bbb222 must not trick the reconciliation
  // into calling it a landed save - nothing was ever submitted.
  stubRoutes(() => json(snapshot({ baseVariants: VARIANTS })));
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  const nav = dlg.querySelectorAll(".codex-set-base-dialog__nav button");
  const prev = nav[0] as HTMLButtonElement;
  const next = nav[1] as HTMLButtonElement;

  await act(async () => { next.click(); }); // -> aaa111
  const input = dlg.querySelector("input") as HTMLInputElement;
  const textarea = dlg.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    typeInto(input, "Formal");
    typeInto(textarea, "Answer formally.");
  });
  await act(async () => { next.click(); }); // -> bbb222, parks the aaa111 draft
  await act(async () => { prev.click(); }); // -> aaa111
  expect(input.value).toBe("Formal");
  expect(textarea.value).toBe("Answer formally.");

  // And the dialog knows the slot is dirty: closing asks before throwing it away.
  await act(async () => { actionButton(dlg, "close").click(); });
  expect(dlg.querySelector(".codex-set-custom-dialog__discard")).not.toBeNull();
  await act(async () => { root.unmount(); });
});

test("discard-others-and-save clears parked drafts on success, keeps them on failure", async () => {
  let putOk = false;
  const calls = stubRoutes(call => {
    if (call.method === "PUT" && call.url.endsWith("/api/codex-prompt/base")) {
      if (!putOk) return json({ ok: false, code: "stale_revision", message: "moved" }, 409);
      return json({ ok: true, snapshot: snapshot({
        baseVariants: [VARIANTS[0]!, { id: "bbb222", title: "Renamed B", body: "Edited B body." }],
        revision: "sha256:two",
      }) });
    }
    return json(snapshot({ baseVariants: VARIANTS }));
  });
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  const nav = dlg.querySelectorAll(".codex-set-base-dialog__nav button");
  const prev = nav[0] as HTMLButtonElement;
  const next = nav[1] as HTMLButtonElement;

  // Edit slot A, park it, then edit slot B: the two drafts are the discarded ones.
  await act(async () => { next.click(); }); // -> aaa111
  const input = dlg.querySelector("input") as HTMLInputElement;
  const textarea = dlg.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    typeInto(input, "Draft A");
    typeInto(textarea, "Draft A body.");
  });
  await act(async () => { next.click(); }); // -> bbb222
  await act(async () => {
    typeInto(input, "Renamed B");
    typeInto(textarea, "Edited B body.");
  });

  // Saving with a parked draft needs the confirmation.
  await act(async () => { actionButton(dlg, "save").click(); });
  const confirm = dlg.querySelector(".codex-set-custom-dialog__discard");
  expect(confirm).not.toBeNull();
  const confirmSave = [...confirm!.querySelectorAll("button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("save")) as HTMLButtonElement;

  // Refused: the confirmation stays open and BOTH drafts survive. "Keep editing"
  // backs out of the prompt without discarding anything.
  await act(async () => { confirmSave.click(); });
  expect(dlg.querySelector(".codex-set-custom-dialog__discard")).not.toBeNull();
  await act(async () => {
    [...dlg.querySelectorAll(".codex-set-custom-dialog__discard button")]
      .find(b => (b.textContent ?? "").toLowerCase().includes("keep editing"))!.click();
  });
  await act(async () => { prev.click(); }); // -> aaa111
  expect(input.value).toBe("Draft A");
  expect(textarea.value).toBe("Draft A body.");
  await act(async () => { next.click(); }); // -> bbb222
  expect(input.value).toBe("Renamed B");

  // Accepted this time: the confirmation dismisses and the parked draft for
  // aaa111 is gone - going back shows the STORED values, not the draft.
  putOk = true;
  await act(async () => { actionButton(dlg, "save").click(); });
  await act(async () => { [...dlg.querySelectorAll(".codex-set-custom-dialog__discard button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("save"))!.click(); });
  expect(dlg.querySelector(".codex-set-custom-dialog__discard")).toBeNull();
  const put = calls.find(c => c.method === "PUT")!;
  expect(put.body).toMatchObject({ id: "bbb222", title: "Renamed B", body: "Edited B body." });
  await act(async () => { prev.click(); }); // -> aaa111 shows stored values
  expect(input.value).toBe("Terse");
  expect(textarea.value).toBe("Be brief.");
  await act(async () => { root.unmount(); });
});

for (const mutation of ["delete", "create"] as const) {
  test(`a successful ${mutation} leaves no outgoing draft to discard`, async () => {
    let variants = [VARIANTS[0]!];
    stubRoutes(call => {
      if (call.method === "PUT") {
        variants = mutation === "delete" ? [] : [...variants, {
          id: "ccc333", title: String(call.body?.title), body: String(call.body?.body), bytes: 20,
        }];
        return json({ ok: true, snapshot: snapshot({ baseVariants: variants }) });
      }
      return json(snapshot({ baseVariants: variants }));
    });
    const { container, root } = await mount();
    try {
      const dlg = await openBaseDialog(container);
      const next = dlg.querySelectorAll(".codex-set-base-dialog__nav button")[1] as HTMLButtonElement;
      await act(async () => { next.click(); });
      if (mutation === "create") await act(async () => { next.click(); });
      await act(async () => {
        typeInto(dlg.querySelector("input") as HTMLInputElement, "New title");
        typeInto(dlg.querySelector("textarea") as HTMLTextAreaElement, "New body.");
      });
      await act(async () => { actionButton(dlg, mutation === "delete" ? "delete" : "save").click(); });
      await act(async () => { actionButton(dlg, "close").click(); });
      expect(document.querySelector("dialog.codex-set-base-dialog") === null).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
}

/**
 * The external state is a dead end no longer: the same preview-then-confirm
 * shape the developer_instructions adopt flow uses, so the refusal in the
 * picker stays a refusal to act SILENTLY - not a refusal to adopt.
 */
const SHA = "a".repeat(64);
const PREVIEW = {
  rawPath: "/etc/somebody-elses.md",
  resolvedPath: "/etc/somebody-elses.md",
  serialized: "# somebody-elses\nImported base.",
  serializedBytes: 36,
  bodyBytes: 14,
  suggestedTitle: "somebody-elses",
  effectiveTitle: "somebody-elses",
  previewSha256: SHA,
};

test("an external selection offers a serialized preview before anything is written", async () => {
  const calls = stubRoutes(call => {
    if (call.url.includes("/api/codex-prompt/base/import")) {
      if (call.body?.confirm === true) {
        return json({
          ok: true,
          snapshot: snapshot({
            revision: "sha256:two",
            baseVariants: [...VARIANTS, { id: "ccc333", title: "somebody-elses", body: "Imported base.", bytes: 14 }],
            baseSelection: { kind: "variant", id: "ccc333" },
          }),
        });
      }
      return json({ ok: true, changed: false, preview: PREVIEW });
    }
    return json(snapshot({
      baseVariants: VARIANTS,
      baseSelection: { kind: "external", path: "/etc/somebody-elses.md" },
    }));
  });
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);

  // The offer sits beside the existing refusal notice.
  const offer = [...dlg.querySelectorAll("button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("import")) as HTMLButtonElement;
  expect(offer).not.toBeUndefined();
  await act(async () => { offer.click(); });

  // The preview shows the SERIALIZED file — heading line included — before any write.
  const pre = dlg.querySelector("pre")!;
  expect(pre.textContent).toBe("# somebody-elses\nImported base.");
  expect(calls.filter(c => c.url.includes("/import")).every(c => c.body?.confirm !== true)).toBe(true);

  const confirm = [...dlg.querySelectorAll(".modal-actions button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("import")) as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  await act(async () => { confirm.click(); });

  const written = calls.filter(c => c.url.includes("/import"));
  expect(written).toHaveLength(2);
  // The confirmation echoes the preview hash AND the title it was bound to,
  // so the route can refuse a file — or a title — that moved between them.
  expect(written[1]!.body).toMatchObject({
    confirm: true, revision: "sha256:one", title: "somebody-elses", previewSha256: SHA,
  });
  await act(async () => { root.unmount(); });
});

test("a preview that lands after the dialog closed cannot resurrect itself", async () => {
  let release: ((r: Response) => void) | null = null;
  stubRoutes(call => {
    if (call.url.includes("/api/codex-prompt/base/import")) {
      return new Promise<Response>(resolve => { release = resolve; });
    }
    return json(snapshot({ baseSelection: { kind: "external", path: "/etc/somebody-elses.md" } }));
  });
  const { container, root } = await mount();
  let dlg = await openBaseDialog(container);
  const offer = [...dlg.querySelectorAll("button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("import")) as HTMLButtonElement;
  await act(async () => { offer.click(); });

  // Close while the preview is still in flight, then let it land.
  const close = [...dlg.querySelectorAll(".modal-actions button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("close")) as HTMLButtonElement;
  await act(async () => { close.click(); });
  await act(async () => {
    release!(json({ ok: true, changed: false, preview: PREVIEW }));
    await Bun.sleep(0);
  });

  // Reopen: the stale preview must not reappear — only a fresh offer.
  dlg = await openBaseDialog(container);
  expect(dlg.querySelector("pre")).toBeNull();
  const offer2 = [...dlg.querySelectorAll("button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("import")) as HTMLButtonElement;
  expect(offer2).not.toBeUndefined();
  await act(async () => { root.unmount(); });
});

test("a lost confirm response reconciles against the file, not the stale preview", async () => {
  let imported = false;
  const calls = stubRoutes(call => {
    if (call.url.includes("/api/codex-prompt/base/import")) {
      if (call.body?.confirm === true) {
        // The write landed server-side but the success never reaches the page.
        imported = true;
        return Promise.reject(new Error("network dropped"));
      }
      return json({ ok: true, changed: false, preview: PREVIEW });
    }
    return json(snapshot(imported
      ? {
          baseSelection: { kind: "variant", id: "ccc333" },
          baseVariants: [{ id: "ccc333", title: "somebody-elses", body: "Imported base.", bytes: 14 }],
        }
      : { baseSelection: { kind: "external", path: "/etc/somebody-elses.md" } }));
  });
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  const offer = [...dlg.querySelectorAll("button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("import")) as HTMLButtonElement;
  await act(async () => { offer.click(); });
  const confirm = [...dlg.querySelectorAll(".modal-actions button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("import")) as HTMLButtonElement;
  const getsBefore = calls.filter(c => c.method === "GET").length;
  await act(async () => { confirm.click(); });
  // Uncertain outcome → the panel re-reads the snapshot rather than trusting
  // the preview it still holds.
  expect(calls.filter(c => c.method === "GET").length).toBeGreaterThan(getsBefore);
  await act(async () => { root.unmount(); });
});

test("a refused import lands beside the affordance rather than the page notice", async () => {
  stubRoutes(call => {
    if (call.url.includes("/api/codex-prompt/base/import")) {
      return json({ ok: false, code: "variant_slots_full", message: "at most 2 base variants" }, 409);
    }
    return json(snapshot({ baseSelection: { kind: "external", path: "/etc/somebody-elses.md" } }));
  });
  const { container, root } = await mount();
  const dlg = await openBaseDialog(container);
  const offer = [...dlg.querySelectorAll("button")]
    .find(b => (b.textContent ?? "").toLowerCase().includes("import")) as HTMLButtonElement;
  await act(async () => { offer.click(); });
  expect(dlg.textContent ?? "").toContain("at most 2 base variants");
  await act(async () => { root.unmount(); });
});

function importButton(dlg: HTMLElement): HTMLButtonElement {
  return [...dlg.querySelectorAll("button")].find(b => (b.textContent ?? "").toLowerCase().includes("import")) as HTMLButtonElement;
}
function editImportTitle(dlg: HTMLElement, title: string): void {
  const input = dlg.querySelector("input") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, title);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}
const EXTERNAL = { baseSelection: { kind: "external", path: PREVIEW.rawPath } };
const IMPORTED = {
  revision: "sha256:two", baseSelection: { kind: "variant", id: "ccc333" },
  baseVariants: [{ id: "ccc333", title: PREVIEW.effectiveTitle, body: "Imported base.", bytes: 14 }],
};

for (const outcome of ["success", "lost-response"] as const) {
  test(`a confirm ${outcome} after Close reconciles after the earlier GET`, async () => {
    let imported = false;
    let release: (() => void) | undefined;
    const calls = stubRoutes(call => {
      if (call.url.endsWith("/import")) {
        if (call.body?.confirm) return new Promise<Response>((resolve, reject) => {
          release = () => {
            imported = true;
            if (outcome === "success") resolve(json({ ok: true, snapshot: snapshot(IMPORTED) }));
            else reject(new Error("lost response"));
          };
        });
        return json({ ok: true, preview: PREVIEW });
      }
      return json(snapshot(imported ? IMPORTED : EXTERNAL));
    });
    const { container, root } = await mount();
    try {
      const dlg = await openBaseDialog(container);
      await act(async () => { importButton(dlg).click(); });
      await act(async () => { importButton(dlg).click(); });
      await act(async () => {
        [...dlg.querySelectorAll(".modal-actions button")]
          .find(b => (b.textContent ?? "").toLowerCase().includes("close"))!.click();
      });
      // The close's GET has already returned the pre-write external selection.
      expect(calls.filter(c => c.url === "/api/codex-prompt").length).toBeGreaterThan(1);
      await act(async () => { release!(); });
      const reopened = await openBaseDialog(container);
      expect(reopened.querySelector(".notice-err") === null).toBe(true);
      expect((baseRow(container).querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(false);
    } finally { await act(async () => { root.unmount(); }); }
  });
}

test("a pending title debounce cannot supersede a confirm", async () => {
  let release: (() => void) | undefined;
  const calls = stubRoutes(call => {
    if (call.url.endsWith("/import")) {
      if (call.body?.confirm) return new Promise<Response>(resolve => {
        release = () => resolve(json({ ok: true, snapshot: snapshot(IMPORTED) }));
      });
      return json({ ok: true, preview: PREVIEW });
    }
    return json(snapshot(EXTERNAL));
  });
  const { container, root } = await mount();
  try {
    const dlg = await openBaseDialog(container);
    await act(async () => { importButton(dlg).click(); });
    await act(async () => { editImportTitle(dlg, "Edited"); });
    await act(async () => { editImportTitle(dlg, PREVIEW.effectiveTitle); });
    await act(async () => { importButton(dlg).click(); });
    await act(async () => { await Bun.sleep(420); });
    expect(calls.filter(c => c.url.endsWith("/import") && !c.body?.confirm)).toHaveLength(1);
    await act(async () => { release!(); });
    expect(dlg.querySelector(".notice-err") === null).toBe(true);
  } finally { await act(async () => { root.unmount(); }); }
});

test("a blank title preview refusal preserves the editable title", async () => {
  stubRoutes(call => {
    if (call.url.endsWith("/import")) {
      if (call.body?.title === "") return json({ ok: false, code: "invalid_title", message: "title required" }, 400);
      const title = String(call.body?.title ?? PREVIEW.effectiveTitle);
      return json({ ok: true, preview: { ...PREVIEW, effectiveTitle: title, serialized: `# ${title}\nImported base.` } });
    }
    return json(snapshot(EXTERNAL));
  });
  const { container, root } = await mount();
  try {
    const dlg = await openBaseDialog(container);
    await act(async () => { importButton(dlg).click(); });
    await act(async () => { editImportTitle(dlg, ""); });
    await act(async () => { await Bun.sleep(420); });
    const input = dlg.querySelector("input") as HTMLInputElement;
    expect(input !== null).toBe(true);
    expect(input.value).toBe("");
    expect(importButton(dlg).disabled).toBe(true);
    await act(async () => { editImportTitle(dlg, "Corrected"); });
    await act(async () => { await Bun.sleep(420); });
    expect(importButton(dlg).disabled).toBe(false);
    expect(input.value).toBe("Corrected");
  } finally { await act(async () => { root.unmount(); }); }
});

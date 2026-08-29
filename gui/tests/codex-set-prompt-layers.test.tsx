/**
 * The full prompt-layer taxonomy (devlog 260802_codex_set_prompt_composer/040).
 *
 * Case 2 is ask item 9 at the rendering layer; the route test proves the same
 * guarantee at the API boundary. Both are required - one without the other is a
 * UI that merely looks safe, or an API nobody exercises.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
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

/**
 * The SHIPPED inventory, imported rather than copied. A hand-written fixture
 * drifts silently: a layer added to WP1 would simply not be covered, which is
 * exactly the gap these tests exist to close.
 */
const INVENTORY = LAYER_INVENTORY.map(d => ({ ...d }));

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

function stubRoutes(handler: (call: { url: string; method: string; body: unknown }) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
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

function row(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector("[data-layer-id=\"" + id + "\"]");
}

test("1. every inventory entry renders a row, state layers before transition notices", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const rendered = [...container.querySelectorAll("[data-layer-id]")].map(el => el.getAttribute("data-layer-id"));
  // Two groups, each in assembly order: state layers first, then the notices that
  // only fire on a change. Every layer appears exactly once - a split that drops
  // one is worse than no split.
  const transition = ["realtime", "model-switch"];
  const state = INVENTORY.map(d => d.id).filter(id => !transition.includes(id));
  expect(rendered.slice(0, state.length)).toEqual(state);
  expect(rendered.slice(state.length).slice().sort()).toEqual(transition.slice().sort());
  expect(new Set(rendered).size).toBe(rendered.length);
  await act(async () => { root.unmount(); });
});

test("2. every layer Codex cannot suppress renders NO switch element at all", async () => {
  // Ask item 9. Not a disabled checkbox and not a greyed toggle: a disabled
  // control claims the capability exists and is temporarily unavailable, which
  // is false. Table-driven over the inventory, so a new upstream layer is
  // covered the day WP1 lists it.
  //
  // `base` is no longer in this set. It used to be, correctly: there was no way to
  // substitute the base prompt, so a control would have been a lie. Now there is one,
  // so the rule is satisfied by giving it a REAL switch rather than by relaxing the
  // rule - which is the same reasoning that keeps every row below bare.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const locked = INVENTORY.filter(d => d.class !== "config-toggle" && d.class !== "base");
  expect(locked.length).toBeGreaterThan(0);
  for (const descriptor of locked) {
    const el = row(container, descriptor.id);
    expect(el, descriptor.id).not.toBeNull();
    expect(el!.querySelector("input"), descriptor.id).toBeNull();
    expect(el!.querySelector("[role=\"switch\"]"), descriptor.id).toBeNull();
  }
  // And every config-toggle DOES get one, or the assertion above proves nothing.
  for (const descriptor of INVENTORY.filter(d => d.class === "config-toggle")) {
    expect(row(container, descriptor.id)!.querySelector("button[role=\"switch\"]"), descriptor.id).not.toBeNull();
  }
  // Base carries one too, and it starts ON: a fresh fixture is on the default, which
  // means Codex's own base prompt is in force.
  const baseSwitch = row(container, "base-instructions")!.querySelector("button[role=\"switch\"]");
  expect(baseSwitch).not.toBeNull();
  expect(baseSwitch!.getAttribute("aria-checked")).toBe("true");
  await act(async () => { root.unmount(); });
});

test("3. a feature-gated row names its governing key and is not called always-on", async () => {
  // These layers ARE disableable - through [features], not from this page.
  // Calling them always-on would tell a user a setting does not exist.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  // Every feature-gated row, not one hand-picked example: these layers ARE
  // disableable, so labelling any of them always-on is the specific falsehood.
  for (const d of INVENTORY.filter(x => x.class === "feature-gated")) {
    const el = row(container, d.id)!;
    expect(el.textContent, d.id).toContain(d.key!);
    expect(el.querySelector(".codex-set-prompt__note--locked"), d.id).toBeNull();
    // The destination, not the tag: it is a `link-btn` button that routes through
    // navigateHash, because nothing in the document carries an
    // `id="integrations/codex"` for a bare fragment href to find.
    expect(el.querySelector(".link-btn"), d.id).not.toBeNull();
  }
  // And every row that genuinely has no off-switch anywhere does carry the label.
  // `base` is excluded now: after the variant work it has a real off-position, so it
  // gets a switch instead of a locked label. Every runtime-conditional row still has
  // no off-switch anywhere in Codex.
  for (const d of INVENTORY.filter(x => x.class === "runtime-conditional")) {
    expect(row(container, d.id)!.querySelector(".codex-set-prompt__note--locked"), d.id).not.toBeNull();
  }
  await act(async () => { root.unmount(); });
});

test("5. extension layers render as a statement, never as rows", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  expect(container.querySelector(".codex-set-prompt__extensions")).not.toBeNull();
  expect(container.querySelector("[data-layer-class=\"extension-unknown\"]")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("6. a rejected PUT reverts the row to server truth", async () => {
  // The server keeps apps OFF throughout. An optimistic UI would show the switch
  // the user clicked; reverting to server truth means showing what the FILE says,
  // which is why the fixture disagrees with both the click and the initial render.
  let gets = 0;
  const calls = stubRoutes(call => {
    if (call.method === "PUT") return json({ ok: false, code: "config_unreadable", message: "nope" }, 409);
    gets += 1;
    return json(snapshot({
      toggles: INVENTORY.filter(d => d.class === "config-toggle").map(d => ({
        id: d.id, key: d.key as string,
        userFileValue: d.id === "apps" && gets > 1 ? false : null,
        defaultedUserValue: !(d.id === "apps" && gets > 1),
        default: true,
      })),
    }));
  });
  const { container, root } = await mount();
  // The switch is a button with aria-checked, not a checkbox: reading `.checked`
  // off it returned undefined, so this guard asserted nothing about the revert.
  const apps = row(container, "apps")!.querySelector("button[role=\"switch\"]") as HTMLButtonElement;
  expect(apps.getAttribute("aria-checked")).toBe("true");
  await act(async () => { apps.click(); });
  // The refreshed snapshot says false, so the row must read false. Counting GETs
  // would pass even if the response were discarded and the row stayed true.
  const after = row(container, "apps")!.querySelector("button[role=\"switch\"]") as HTMLButtonElement;
  expect(after.getAttribute("aria-checked")).toBe("false");
  expect(container.querySelector("[role=\"alert\"]")).not.toBeNull();
  expect(calls.filter(c => c.method === "GET").length).toBeGreaterThan(1);
  await act(async () => { root.unmount(); });
});

test("7. the dialog opens read-only: no textarea, no save", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const trigger = row(container, "permissions")!.querySelector("button") as HTMLButtonElement;
  await act(async () => { trigger.click(); });
  const dialog = document.querySelector("dialog.modal-overlay");
  expect(dialog).not.toBeNull();
  expect(dialog!.querySelector("textarea")).toBeNull();
  expect(dialog!.querySelector("input")).toBeNull();
  // The test is named "no save", so assert it: a Save control appearing later is
  // exactly the regression a textarea check alone would miss.
  const actionLabels = [...dialog!.querySelectorAll("button")].map(b => (b.textContent ?? "").toLowerCase());
  expect(actionLabels.some(l => l.includes("save"))).toBe(false);
  expect(dialog!.textContent).toContain("include_permissions_instructions");
  await act(async () => { root.unmount(); });
});

test("9. the dialog names WHY text is missing rather than omitting it silently", async () => {
  // Codex is open source and `codex debug prompt-input` renders the model-visible
  // input list, so the old "no API exists" claim was wrong. What remains true is
  // that a body can still be absent - unread, unrendered on this turn, or carried
  // outside the printable list - and each case has its own sentence.
  //
  // Driven through `personality` rather than `base-instructions`: base now opens the
  // variant picker instead of the read-only dialog, and both are absent from the
  // probe's tag map, so the case under test is unchanged.
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  await act(async () => {
    (row(container, "personality")!.querySelector("button") as HTMLButtonElement).click();
  });
  const dialog = document.querySelector("dialog.modal-overlay")!;
  const notice = dialog.querySelector(".codex-set-layer-dialog__no-text");
  expect(notice).not.toBeNull();
  // The element existing is not the contract; saying so is. An empty div would
  // satisfy a presence check while telling the reader nothing.
  expect((notice!.textContent ?? "").length).toBeGreaterThan(40);
  // The probe is not stubbed here, so this asserts the shape of the answer rather
  // than one branch: a reason is always given, and it is a sentence.
  expect(notice!.textContent).toMatch(/could not be read|sent nothing|travels outside/);
  await act(async () => { root.unmount(); });
});

test("the prompt-text request is aborted when the panel unmounts", async () => {
  let textSignal: AbortSignal | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/codex-prompt/text")) {
      textSignal = init?.signal as AbortSignal | null ?? null;
      return await new Promise<Response>((_resolve, reject) => {
        textSignal?.addEventListener("abort", () => reject(textSignal?.reason), { once: true });
      });
    }
    return json(snapshot());
  }) as typeof fetch;

  const { root } = await mount();
  expect(textSignal).not.toBeNull();
  expect(textSignal!.aborted).toBe(false);

  await act(async () => { root.unmount(); });

  expect(textSignal!.aborted).toBe(true);
});

test("4. a runtime-conditional row states the condition that emits it", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  await act(async () => {
    (row(container, "agents-md")!.querySelector("button") as HTMLButtonElement).click();
  });
  const dialog = document.querySelector("dialog.modal-overlay")!;
  // The about text already contains "AGENTS.md" and is long, so asserting either
  // would pass with the condition paragraph deleted. Query the condition copy
  // itself, and prove the SAME dialog omits it for a non-conditional layer.
  const conditional = dialog.textContent ?? "";
  expect(conditional).toContain("working directory");
  await act(async () => {
    (document.querySelector("dialog.modal-overlay button") as HTMLButtonElement).click();
  });
  await act(async () => {
    (row(container, "permissions")!.querySelector("button") as HTMLButtonElement).click();
  });
  expect(document.querySelector("dialog.modal-overlay")!.textContent).not.toContain("working directory");
  await act(async () => { root.unmount(); });
});

test("8. Escape closes the dialog and returns focus to the row", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();
  const trigger = row(container, "apps")!.querySelector("button") as HTMLButtonElement;
  // A real browser focuses a button when it is clicked; happy-dom does not, so the
  // focus is set explicitly to model the state the dialog actually opens from.
  await act(async () => { trigger.focus(); trigger.click(); });
  expect(document.querySelector("dialog.modal-overlay")).not.toBeNull();
  const dialog = document.querySelector("dialog.modal-overlay") as HTMLDialogElement;
  await act(async () => {
    dialog.dispatchEvent(new testWindow.Event("cancel", { cancelable: true }));
  });
  expect(document.querySelector("dialog.modal-overlay")).toBeNull();
  // Closing without returning focus strands a keyboard user at the document root.
  expect(document.activeElement).toBe(trigger);
  await act(async () => { root.unmount(); });
});

test("11. a cold load shows the skeleton; a refresh keeps the rows visible", async () => {
  // The two states the loading contract exists to separate. A refresh that blanked
  // the list would read as "everything disappeared" rather than "checking again".
  // The first read is held open, so the cold state is actually observed rather than
  // skipped past by an immediately-resolving stub.
  let release: (() => void) | null = null;
  // The panel now makes TWO requests on mount: the snapshot and the size probe.
  // Only the snapshot is held open; the probe answers immediately so this measures
  // the cold snapshot state rather than deadlocking on the probe.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/text")) return json({ ok: true, layers: {} });
    await new Promise<void>(resolve => { release = resolve; });
    return json(snapshot());
  }) as typeof fetch;
  const { container, root } = await mount();
  expect(container.querySelector(".data-surface-skeleton")).not.toBeNull();
  expect(container.querySelectorAll("[data-layer-id]").length).toBe(0);

  await act(async () => {
    release!();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(container.querySelector(".data-surface-skeleton")).toBeNull();
  expect(container.querySelectorAll("[data-layer-id]").length).toBe(INVENTORY.length);

  // A second surface on the same key renders from cache with no skeleton: that is
  // the revalidation path, and it must never blank rows the user is reading.
  const second = await mount();
  expect(second.container.querySelector(".data-surface-skeleton")).toBeNull();
  expect(second.container.querySelectorAll("[data-layer-id]").length).toBe(INVENTORY.length);
  await act(async () => { second.root.unmount(); });
  await act(async () => { root.unmount(); });
});
test("10. an unreadable config refuses writes on every switch", async () => {
  stubRoutes(() => json(snapshot({ readable: false })));
  const { container, root } = await mount();
  const switches = [...container.querySelectorAll("button[role=\"switch\"]")] as HTMLButtonElement[];
  // Five config toggles plus the base-prompt switch. Counted rather than sampled,
  // because a refusal that misses one control is the whole failure mode here.
  expect(switches).toHaveLength(6);
  for (const input of switches) expect(input.disabled).toBe(true);
  await act(async () => { root.unmount(); });
});

test("a layer this build has no copy for is named, never blank", async () => {
  // The wire response is cast, not validated, so a newer Codex runtime CAN list a
  // layer the dashboard has no strings for. Rendering it blank would look like a
  // bug in our own page rather than a version gap.
  const unknown = { id: "future-layer", class: "runtime-conditional", key: null, default: null, order: 99 };
  stubRoutes(() => json(snapshot({ inventory: [...INVENTORY, unknown] })));
  const { container, root } = await mount();
  const el = row(container, "future-layer");
  expect(el).not.toBeNull();
  expect(el!.textContent).toContain("future-layer");
  expect(el!.querySelector("input")).toBeNull();

  await act(async () => { (el!.querySelector("button") as HTMLButtonElement).click(); });
  const dialog = document.querySelector("dialog.modal-overlay")!;
  // Title falls back to the id, and the body says why there is nothing to describe.
  expect(dialog.querySelector("h3")!.textContent).toBe("future-layer");
  expect((dialog.querySelector("p")!.textContent ?? "").length).toBeGreaterThan(20);
  await act(async () => { root.unmount(); });
});

/**
 * The dialog body must WRAP, not scroll sideways.
 *
 * `.api-code` in styles.css sets `white-space: pre`, and both it and the
 * dialog rule are single-class selectors - a specificity tie that source order
 * decides. styles.css loads later, so `pre` won and a 307-byte permissions body
 * rendered as two clipped lines with a horizontal scrollbar. Asserting on the
 * stylesheet is the only honest check here: happy-dom applies no cascade, so a
 * computed-style assertion would pass against the broken rule too.
 */
test("the layer-text rule outranks .api-code so long bodies wrap", () => {
  const css = readFileSync(new URL("../src/styles-codex-set.css", import.meta.url), "utf8");
  const rule = /\.codex-set-layer-dialog__text\.api-code\s*\{([^}]*)\}/.exec(css);
  // Chained with .api-code: the unchained selector loses the tie to styles.css.
  expect(rule).not.toBeNull();
  expect(rule![1]).toContain("white-space: pre-wrap");
  expect(rule![1]).toContain("overflow-wrap: anywhere");
  expect(rule![1]).toContain("overflow-x: hidden");
});

/**
 * The layer `ext/git-attribution` contributes.
 *
 * Three things have to be true at once, and each would be wrong on its own: it appears
 * at all, it has NO switch, and it does not claim to be "always on". The last is the
 * one a reader is most likely to get wrong - the account can turn attribution off, and
 * when it does Codex sends the opposite instruction rather than sending nothing, so
 * neither "always on" nor "sometimes absent" describes it.
 */
test("git-attribution renders as a conditional row with no switch", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();

  const el = row(container, "git-attribution");
  expect(el).not.toBeNull();
  // No switch anywhere in the row: not a disabled one either, which would claim a
  // capability Codex does not expose.
  expect(el!.querySelector("[role=\"switch\"]")).toBeNull();
  // The locked note, not the feature-gated one - there is no [features] key to link to.
  expect(el!.querySelector(".codex-set-prompt__note--locked")).not.toBeNull();
  // No [features] link INSIDE the note. Querying `.link-btn` across the whole row would
  // always find one: the row's own name is a link-btn button that opens the dialog.
  expect(el!.querySelector(".codex-set-prompt__note .link-btn")).toBeNull();
  // No key chip: the descriptor carries key: null because enablement is account-derived.
  expect(el!.querySelector(".codex-set-prompt__key")).toBeNull();

  // A registration-order layer sorts after every fixed position rather than to the top,
  // and shows the neutral marker instead of inventing a number.
  //
  // Scoped to the STATE list: the transition notices render in their own list below, so
  // "last in the document" would be a claim about the split rather than about ordering.
  const stateList = container.querySelectorAll(".codex-set-prompt__rows")[0]!;
  const stateIds = [...stateList.querySelectorAll("[data-layer-id]")].map(n => n.getAttribute("data-layer-id"));
  expect(stateIds[stateIds.length - 1]).toBe("git-attribution");
  // And specifically NOT first, which is where a null order collapsing to 0 would put it.
  expect(stateIds[0]).toBe("base-instructions");
  expect(el!.querySelector(".codex-set-prompt__pos")!.textContent).toBe("\u00b7");

  // The dialog states the real condition.
  await act(async () => {
    (el!.querySelector("button") as HTMLButtonElement).click();
  });
  const dialog = document.querySelector("dialog.modal-overlay")!;
  expect(dialog.textContent ?? "").toContain("attribution policy");
  await act(async () => { root.unmount(); });
});

/**
 * A conditional row must not claim to be unconditional.
 *
 * Caught by rendering the real page in a browser rather than by a unit test: the DOM
 * showed `git-attribution` and `plugins` both labelled "Always on" while their dialogs
 * described a condition. The condition map existed and only the dialog read it, so the
 * two surfaces disagreed about the same layer.
 *
 * Table-driven over every layer that HAS a condition, so the next one added is covered
 * without a new test - and the negative half proves the assertion is not vacuous.
 */
test("a row with a condition shows it instead of \"Always on\"", async () => {
  stubRoutes(() => json(snapshot()));
  const { container, root } = await mount();

  // Conditions live on runtime-conditional layers; the transition notices are excluded
  // because "it fires on a change" is their own distinct wording.
  const conditional = ["plugins", "agents-md", "git-attribution"];
  for (const id of conditional) {
    const note = row(container, id)!.querySelector(".codex-set-prompt__note--locked")!;
    expect(note.textContent, id).not.toBe("Always on");
    expect((note.textContent ?? "").length, id).toBeGreaterThan(0);
  }

  // The negative half, so the loop above cannot pass by labelling everything with a
  // condition. `environments-instructions` is feature-gated: no condition line, and it
  // is not called always-on either, because it IS disableable through [features].
  const gated = row(container, "environments-instructions")!;
  expect(gated.querySelector(".codex-set-prompt__note--locked")).toBeNull();
  expect(gated.textContent).toContain("features.deferred_executor");

  await act(async () => { root.unmount(); });
});

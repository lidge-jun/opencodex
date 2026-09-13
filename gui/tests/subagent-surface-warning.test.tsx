import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS, LOCALES } from "../src/i18n/shared";
import SubagentSurfaceWarningModal from "../src/components/SubagentSurfaceWarningModal";
import { SUBAGENT_SURFACE_GUIDE_URL, readSubagentSurfaceAdvisory, subagentSurfaceLabel } from "../src/subagent-surface";

const KEYS = [
  "subagentSurface.selectionTitle",
  "subagentSurface.selectionBody",
  "subagentSurface.advisoryTitle",
  "subagentSurface.advisoryBody",
  "subagentSurface.continue",
  "subagentSurface.switchToV1",
  "subagentSurface.learnMore",
];

/**
 * The GUI keeps its own copy of the guide URL as a fallback for a runtime that predates the
 * advisory. Two copies of a URL is exactly the thing that rots, so pin them to each other.
 */
test("the fallback guide URL matches the runtime constant", async () => {
  const runtime = await Bun.file(new URL("../../src/config/multi-agent-surface.ts", import.meta.url)).text();

  expect(runtime).toContain(`SUBAGENT_SURFACE_GUIDE_URL = "${SUBAGENT_SURFACE_GUIDE_URL}"`);
  expect(SUBAGENT_SURFACE_GUIDE_URL).toStartWith("https://opencodex.me/guides/");
});

test("every locale defines the dialog keys, and Korean uses the wording that was asked for", () => {
  // Read the loaded catalogs, not the source text: a key mentioned only in a comment would
  // satisfy a grep and still render the raw key id to the operator.
  expect(LOCALES.length).toBe(9);
  for (const { code } of LOCALES) {
    for (const key of KEYS) {
      const value = DICTS[code][key as keyof (typeof DICTS)[typeof code]];
      expect(typeof value).toBe("string");
      expect(value.trim().length).toBeGreaterThan(0);
      expect(value).not.toBe(key);
    }
  }

  expect(DICTS.ko["subagentSurface.continue"]).toBe("계속하기");
  expect(DICTS.ko["subagentSurface.switchToV1"]).toBe("v1으로 바꾸기");
});

test("a runtime that does not send the advisory yields null instead of a raised notice", () => {
  expect(readSubagentSurfaceAdvisory(undefined)).toBeNull();
  expect(readSubagentSurfaceAdvisory({})).toBeNull();
  expect(readSubagentSurfaceAdvisory({ required: true })).toBeNull();
  expect(readSubagentSurfaceAdvisory({ required: "yes", mode: "v2" })).toBeNull();

  expect(readSubagentSurfaceAdvisory({ required: true, mode: "v2" })).toEqual({
    required: true, mode: "v2", recommended: "v1", version: 0, docsUrl: SUBAGENT_SURFACE_GUIDE_URL,
  });
  expect(readSubagentSurfaceAdvisory({
    required: false, mode: "default", version: 3, docsUrl: "https://example.test/guide/",
  })).toEqual({
    required: false, mode: "default", recommended: "v1", version: 3, docsUrl: "https://example.test/guide/",
  });
});

test("the stored default mode is called base in the UI", () => {
  expect(subagentSurfaceLabel("default")).toBe("base");
  expect(subagentSurfaceLabel("v1")).toBe("v1");
  expect(subagentSurfaceLabel("v2")).toBe("v2");
});

/**
 * The same v1/base/v2 switch is rendered on three pages. Every one of them must stage a base
 * or v2 click instead of writing it, or the dialog is decoration on whichever page was missed.
 * v1 stays immediate: asking an operator to confirm a move toward the safe default is noise.
 */
test("all three mode switches gate base and v2 but let v1 through", async () => {
  const models = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  const gate = models.slice(models.indexOf("const setMultiAgentMode"));
  const body = gate.slice(0, gate.indexOf("};"));

  expect(body).toContain('if (mode === "v1") { await putV2Setting({ multiAgentMode: "v1" }); return; }');
  expect(body).toContain("setPendingSurface(mode);");
  expect(body).not.toContain("await putV2Setting({ multiAgentMode: mode })");

  const dash = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  const switcher = dash.slice(dash.indexOf("const switchMaMode"));
  const switcherBody = switcher.slice(0, switcher.indexOf("};"));

  expect(switcherBody).toContain('if (mode !== "v1") { setPendingMaMode(mode); return; }');
  expect(switcherBody).toContain('await writeMaMode("v1")');

  // The Subagents page carries a third copy of the switch and used to PUT straight through.
  const subagents = await Bun.file(new URL("../src/pages/Subagents.tsx", import.meta.url)).text();
  const handler = subagents.slice(subagents.indexOf("onUltraModeSave: patch =>"));
  const handlerBody = handler.slice(0, handler.indexOf("},"));

  expect(handlerBody).toContain('patch.multiAgentMode === "default" || patch.multiAgentMode === "v2"');
  expect(handlerBody).toContain("setPendingSurface(patch.multiAgentMode);");
  expect(subagents).toContain("<SubagentSurfaceWarningModal");
});

/** The recommended answer must not leave the notice raised on a mode it just applied. */
test("choosing v1 from a raised advisory sends the mode and the acknowledgement together", async () => {
  const dash = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  const choose = dash.slice(dash.indexOf("const chooseMaV1"));
  const body = choose.slice(0, choose.indexOf("};"));

  expect(body).toContain('await writeMaMode("v1", maAdvisory?.required === true)');

  const writer = dash.slice(dash.indexOf("const writeMaMode"));
  expect(writer.slice(0, writer.indexOf("const switchMaMode"))).toContain(
    "if (acknowledgeAdvisory) payload.multiAgentSurfaceAdvisoryAcknowledged = true;",
  );

  // Continuing to base or v2 also answers the notice. Otherwise the next poll asks again.
  const keep = dash.slice(dash.indexOf("const keepMaMode"));
  expect(keep.slice(0, keep.indexOf("};"))).toContain("await writeMaMode(pending, maAdvisory?.required === true)");
});

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  // happy-dom has no native modal dialog; the component only needs the call to be safe.
  const dialogProto = (testWindow as unknown as { HTMLDialogElement?: { prototype: Record<string, unknown> } }).HTMLDialogElement?.prototype;
  if (dialogProto && typeof dialogProto.showModal !== "function") dialogProto.showModal = function showModal() { (this as { open?: boolean }).open = true; };
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  root = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

function render(node: React.ReactElement): void {
  root = createRoot(container);
  act(() => root!.render(<LanguageProvider>{node}</LanguageProvider>));
}

test("the advisory offers both answers and a link to the guide, and each button calls its own handler", () => {
  const calls: string[] = [];
  render(
    <SubagentSurfaceWarningModal
      reason="advisory"
      mode="v2"
      docsUrl="https://example.test/guide/"
      onContinue={() => calls.push("continue")}
      onChooseV1={() => calls.push("v1")}
      onDismiss={() => calls.push("dismiss")}
    />,
  );

  const dialog = container.querySelector("dialog");
  expect(dialog?.getAttribute("data-subagent-surface-reason")).toBe("advisory");

  const link = container.querySelector('a[href="https://example.test/guide/"]');
  expect(link).not.toBeNull();
  expect(link?.getAttribute("rel")).toBe("noreferrer");

  const actions = Array.from(container.querySelectorAll(".modal-actions button")) as HTMLButtonElement[];
  expect(actions).toHaveLength(2);
  expect(actions[1]!.className).toContain("btn-primary");

  act(() => actions[0]!.click());
  act(() => actions[1]!.click());
  expect(calls).toEqual(["continue", "v1"]);
});

test("a selection names the mode being selected, using the UI label for base", () => {
  render(
    <SubagentSurfaceWarningModal
      reason="selection"
      mode="default"
      docsUrl={SUBAGENT_SURFACE_GUIDE_URL}
      onContinue={() => {}}
      onChooseV1={() => {}}
      onDismiss={() => {}}
    />,
  );

  const heading = container.querySelector("h3")?.textContent ?? "";
  expect(heading).toContain("base");
  expect(heading).not.toContain("{mode}");
  expect(container.querySelector("dialog")?.getAttribute("data-subagent-surface-reason")).toBe("selection");
});

test("the backdrop dismisses without answering either way", () => {
  const calls: string[] = [];
  render(
    <SubagentSurfaceWarningModal
      reason="selection"
      mode="v2"
      docsUrl={SUBAGENT_SURFACE_GUIDE_URL}
      onContinue={() => calls.push("continue")}
      onChooseV1={() => calls.push("v1")}
      onDismiss={() => calls.push("dismiss")}
    />,
  );

  const backdrop = container.querySelector(".modal-backdrop-dismiss") as HTMLButtonElement | null;
  expect(backdrop).not.toBeNull();
  act(() => backdrop!.click());

  expect(calls).toEqual(["dismiss"]);
});

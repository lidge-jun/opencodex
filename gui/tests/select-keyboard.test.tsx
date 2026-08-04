import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { Select } from "../src/ui";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Charlie" },
];

async function mountSelect(node: React.ReactElement): Promise<{ root: Root; trigger: HTMLButtonElement; host: HTMLDivElement }> {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  let root!: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(node);
  });
  const trigger = host.querySelector<HTMLButtonElement>("button.select-trigger")!;
  return { root, trigger, host };
}

function key(target: HTMLElement, name: string) {
  target.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: name, bubbles: true }) as unknown as KeyboardEvent);
}

function listbox() {
  return document.body.querySelector<HTMLElement>('[role="listbox"]');
}

async function assertComboboxContract(portal: boolean) {
  function Harness() {
    const [value, setValue] = useState("a");
    return (
      <div>
        <div data-testid="value">{value}</div>
        <Select value={value} options={OPTIONS} onChange={setValue} label="Pick" portal={portal} />
      </div>
    );
  }
  const { root, host } = await mountSelect(<Harness />);
  const trigger = () => host.querySelector<HTMLButtonElement>("button.select-trigger")!;
  const current = () => host.querySelector('[data-testid="value"]')!.textContent;

  expect(trigger().getAttribute("role")).toBe("combobox");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(trigger().getAttribute("aria-activedescendant")).toBeNull();
  expect(listbox()).toBeNull();

  await act(async () => { key(trigger(), "ArrowDown"); });
  const box = listbox();
  expect(box).not.toBeNull();
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(trigger().getAttribute("aria-controls")).toBe(box!.id);
  const activeId = trigger().getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  expect(document.getElementById(activeId!)).not.toBeNull();

  await act(async () => { key(trigger(), "ArrowDown"); });
  expect(trigger().getAttribute("aria-activedescendant")).not.toBe(activeId);
  await act(async () => { key(trigger(), "Home"); });
  const homeId = trigger().getAttribute("aria-activedescendant")!;
  expect(document.getElementById(homeId)?.textContent).toContain("Alpha");
  await act(async () => { key(trigger(), "End"); });
  const endId = trigger().getAttribute("aria-activedescendant")!;
  expect(document.getElementById(endId)?.textContent).toContain("Charlie");

  await act(async () => { key(trigger(), "Enter"); });
  expect(current()).toBe("c");
  expect(listbox()).toBeNull();
  expect(document.activeElement).toBe(trigger());

  await act(async () => { key(trigger(), "Home"); });
  await act(async () => { key(trigger(), " "); });
  expect(current()).toBe("a");
  expect(listbox()).toBeNull();

  await act(async () => { key(trigger(), "ArrowDown"); });
  await act(async () => { key(trigger(), "ArrowDown"); });
  await act(async () => { key(trigger(), "Escape"); });
  expect(current()).toBe("a");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger());

  await act(async () => { key(trigger(), "ArrowDown"); });
  await act(async () => { key(trigger(), "ArrowDown"); });
  await act(async () => { key(trigger(), "Tab"); });
  expect(current()).toBe("b");
  expect(listbox()).toBeNull();

  await act(async () => { root.unmount(); });
}

test("portaled Select exposes a valid combobox contract", async () => {
  await assertComboboxContract(true);
});

test("non-portal Select exposes a valid combobox contract", async () => {
  await assertComboboxContract(false);
});

test("ArrowDown opens and Enter selects the active option (portal)", async () => {
  let value = "a";
  const { root, trigger } = await mountSelect(
    <Select value={value} options={OPTIONS} onChange={next => { value = next; }} label="Pick" />,
  );
  await act(async () => { key(trigger, "ArrowDown"); });
  expect(listbox()).not.toBeNull();
  expect(trigger.getAttribute("aria-activedescendant")).toBeTruthy();
  await act(async () => { key(trigger, "ArrowDown"); });
  await act(async () => { key(trigger, "Enter"); });
  expect(value).toBe("b");
  expect(listbox()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => { root.unmount(); });
});

test("Home/End and Escape restore focus for non-portal Select", async () => {
  let value = "b";
  const { root, trigger } = await mountSelect(
    <Select value={value} options={OPTIONS} onChange={next => { value = next; }} label="Lang" portal={false} placement="right" />,
  );
  await act(async () => { key(trigger, "End"); });
  await act(async () => { key(trigger, "Enter"); });
  expect(value).toBe("c");
  await act(async () => { key(trigger, "Home"); });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () => { key(trigger, "Escape"); });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  await act(async () => { root.unmount(); });
});

test("disabled Select does not open from keyboard or click", async () => {
  const { root, trigger } = await mountSelect(
    <Select value="a" options={OPTIONS} onChange={() => {}} label="Off" disabled />,
  );
  await act(async () => { key(trigger, "ArrowDown"); });
  expect(listbox()).toBeNull();
  await act(async () => { trigger.click(); });
  expect(listbox()).toBeNull();
  await act(async () => { root.unmount(); });
});

test("empty options do not open", async () => {
  const { root, trigger } = await mountSelect(
    <Select value="" options={[]} onChange={() => {}} label="Empty" />,
  );
  await act(async () => { key(trigger, "ArrowDown"); });
  expect(listbox()).toBeNull();
  await act(async () => { trigger.click(); });
  expect(listbox()).toBeNull();
  await act(async () => { root.unmount(); });
});

test("outside click closes the menu", async () => {
  const { root, trigger } = await mountSelect(
    <Select value="a" options={OPTIONS} onChange={() => {}} label="Pick" />,
  );
  await act(async () => { key(trigger, "ArrowDown"); });
  expect(listbox()).not.toBeNull();
  await act(async () => {
    document.body.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true }) as unknown as MouseEvent);
  });
  expect(listbox()).toBeNull();
  await act(async () => { root.unmount(); });
});

test("clicking an option selects it and returns focus", async () => {
  function Harness() {
    const [value, setValue] = useState("a");
    return (
      <div>
        <div data-testid="value">{value}</div>
        <Select value={value} options={OPTIONS} onChange={setValue} label="Pick" />
      </div>
    );
  }
  const { root, host } = await mountSelect(<Harness />);
  const trigger = host.querySelector<HTMLButtonElement>("button.select-trigger")!;
  await act(async () => { key(trigger, "ArrowDown"); });
  const option = listbox()!.querySelectorAll<HTMLElement>('[role="option"]')[1]!;
  await act(async () => { option.click(); });
  expect(host.querySelector('[data-testid="value"]')!.textContent).toBe("b");
  expect(listbox()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => { root.unmount(); });
});

test("external value change updates active option on next open", async () => {
  function Harness() {
    const [value, setValue] = useState("a");
    return (
      <div>
        <button type="button" data-testid="set-c" onClick={() => setValue("c")}>set-c</button>
        <Select value={value} options={OPTIONS} onChange={setValue} label="Pick" />
      </div>
    );
  }
  const { root, host } = await mountSelect(<Harness />);
  const trigger = host.querySelector<HTMLButtonElement>("button.select-trigger")!;
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="set-c"]')!.click(); });
  await act(async () => { key(trigger, "ArrowDown"); });
  const activeId = trigger.getAttribute("aria-activedescendant")!;
  expect(document.getElementById(activeId)?.textContent).toContain("Charlie");
  await act(async () => { root.unmount(); });
});

test("shrinking options clamps active descendant", async () => {
  function Harness() {
    const [opts, setOpts] = useState(OPTIONS);
    return (
      <div>
        <button type="button" data-testid="shrink" onClick={() => setOpts(OPTIONS.slice(0, 1))}>shrink</button>
        <Select value="a" options={opts} onChange={() => {}} label="Pick" />
      </div>
    );
  }
  const { root, host } = await mountSelect(<Harness />);
  const trigger = host.querySelector<HTMLButtonElement>("button.select-trigger")!;
  await act(async () => { key(trigger, "End"); });
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="shrink"]')!.click(); });
  const activeId = trigger.getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  expect(document.getElementById(activeId!)).not.toBeNull();
  expect(listbox()!.querySelectorAll('[role="option"]').length).toBe(1);
  expect(document.getElementById(activeId!)?.classList.contains("select-option-active")).toBe(true);
  await act(async () => { root.unmount(); });
});

async function assertKeyboardActiveClassMoves(portal: boolean) {
  function Harness() {
    const [value, setValue] = useState("a");
    return (
      <div>
        <div data-testid="value">{value}</div>
        <Select value={value} options={OPTIONS} onChange={setValue} label="Pick" portal={portal} />
      </div>
    );
  }
  const { root, host } = await mountSelect(<Harness />);
  const trigger = () => host.querySelector<HTMLButtonElement>("button.select-trigger")!;
  const opts = () => [...listbox()!.querySelectorAll<HTMLElement>('[role="option"]')];
  const activeEl = () => listbox()!.querySelector<HTMLElement>(".select-option-active");

  await act(async () => { key(trigger(), "ArrowDown"); });
  expect(opts()[0]!.classList.contains("active")).toBe(true);
  expect(opts()[0]!.classList.contains("select-option-active")).toBe(true);
  expect(trigger().getAttribute("aria-activedescendant")).toBe(opts()[0]!.id);

  await act(async () => { key(trigger(), "ArrowDown"); });
  expect(opts()[0]!.classList.contains("select-option-active")).toBe(false);
  expect(opts()[1]!.classList.contains("select-option-active")).toBe(true);
  expect(opts()[0]!.classList.contains("active")).toBe(true);
  expect(trigger().getAttribute("aria-activedescendant")).toBe(opts()[1]!.id);
  expect(activeEl()?.textContent).toContain("Beta");

  await act(async () => { key(trigger(), "Home"); });
  expect(activeEl()?.textContent).toContain("Alpha");
  expect(opts().filter(o => o.classList.contains("select-option-active")).length).toBe(1);

  await act(async () => { key(trigger(), "End"); });
  expect(activeEl()?.textContent).toContain("Charlie");
  expect(trigger().getAttribute("aria-activedescendant")).toBe(opts()[2]!.id);

  await act(async () => {
    // React listens for mouseover to drive onMouseEnter in this environment.
    opts()[1]!.dispatchEvent(new testWindow.MouseEvent("mouseover", { bubbles: true }) as unknown as MouseEvent);
  });
  expect(activeEl()?.textContent).toContain("Beta");
  expect(trigger().getAttribute("aria-activedescendant")).toBe(opts()[1]!.id);

  await act(async () => { activeEl()!.click(); });
  expect(host.querySelector('[data-testid="value"]')!.textContent).toBe("b");
  expect(listbox()).toBeNull();
  expect(document.activeElement).toBe(trigger());

  await act(async () => { root.unmount(); });
}

test("portaled Select moves select-option-active with keyboard and hover", async () => {
  await assertKeyboardActiveClassMoves(true);
});

test("non-portal Select moves select-option-active with keyboard and hover", async () => {
  await assertKeyboardActiveClassMoves(false);
});

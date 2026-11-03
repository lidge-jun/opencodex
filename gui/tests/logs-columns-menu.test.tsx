import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { ColumnsMenu } from "../src/components/v2-logs/columns-menu";

type Key = "effort" | "cost";

async function withMenu(exercise: (ui: { container: HTMLElement; win: Window; visible: () => Record<Key, boolean> }) => Promise<void>) {
  const win = new Window({ url: "http://localhost/#logs" });
  const values = { document: win.document, window: win, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let root: Root | undefined;
  let current: Record<Key, boolean> = { effort: true, cost: true };
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const container = document.createElement("div");
    document.body.append(container);
    function Harness() {
      const [visible, setVisible] = useState(current);
      useEffect(() => { current = visible; }, [visible]);
      return (
        <ColumnsMenu<Key>
          options={[{ key: "effort", label: "Effort" }, { key: "cost", label: "Cost" }]}
          visible={visible}
          onToggle={key => setVisible(previousVisible => ({ ...previousVisible, [key]: !previousVisible[key] }))}
          label="Columns"
          menuLabel="Show or hide columns"
        />
      );
    }
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    await act(async () => { root!.render(<Harness />); });
    await exercise({ container, win, visible: () => current });
  } finally {
    try {
      if (root) await act(async () => { root!.unmount(); });
    } finally {
      win.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
}

test("ColumnsMenu toggles columns as menuitemcheckbox rows and closes on Escape back to its trigger", async () => {
  await withMenu(async ui => {
    const trigger = ui.container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { trigger.click(); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = [...ui.container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')];
    expect(items.map(item => item.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    expect(document.activeElement).toBe(items[0]);

    await act(async () => { items[1]!.click(); });
    expect(ui.visible()).toEqual({ effort: true, cost: false });
    expect(ui.container.querySelectorAll('[role="menuitemcheckbox"]')[1]!.getAttribute("aria-checked")).toBe("false");

    const down = new ui.win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    await act(async () => { document.activeElement!.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);

    await act(async () => {
      document.dispatchEvent(new ui.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(ui.container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

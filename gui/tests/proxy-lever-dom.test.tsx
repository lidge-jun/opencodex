import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ProxyLever } from "../src/components/ui-v2/proxy-lever";

/*
 * The sidebar proxy lever fires on release by how far it was pulled: the middle notch reloads
 * Codex models, the bottom stops the proxy, and a short pull springs back without doing either.
 * A click (or Enter) is the harmless middle notch; End is the stop.
 */
async function withLever(exercise: (ui: { lever: HTMLButtonElement; win: Window; calls: string[] }) => Promise<void>) {
  const win = new Window({ url: "http://localhost/" });
  const values = { document: win.document, window: win, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let root: Root | undefined;
  const calls: string[] = [];
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ProxyLever restartLabel="Reload" stopLabel="Stop" hint="Pull halfway: Reload. Pull all the way down: Stop."
          restarting={false} stopping={false} onRestart={() => calls.push("restart")} onStop={() => { calls.push("stop"); }}
          onPreview={preview => calls.push(`preview:${preview}`)} />,
      );
    });
    await exercise({ lever: container.querySelector("button")!, win, calls });
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

async function pull(lever: HTMLButtonElement, win: Window, dy: number) {
  const fire = (type: string, clientY: number) =>
    lever.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientY }) as unknown as Event);
  await act(async () => { fire("pointerdown", 100); });
  await act(async () => { fire("pointermove", 100 + dy / 2); });
  await act(async () => { fire("pointermove", 100 + dy); });
  await act(async () => { fire("pointerup", 100 + dy); });
}

test("a short pull springs back and fires nothing", async () => {
  await withLever(async ({ lever, win, calls }) => {
    await pull(lever, win, 5);
    expect(actions(calls)).toEqual([]);
  });
});

test("pulling to the middle notch reloads; pulling to the bottom stops", async () => {
  await withLever(async ({ lever, win, calls }) => {
    await pull(lever, win, 13);
    expect(actions(calls)).toEqual(["restart"]);
    await pull(lever, win, 40);
    expect(actions(calls)).toEqual(["restart", "stop"]);
  });
});

test("a click takes the harmless notch; End is the stop", async () => {
  await withLever(async ({ lever, win, calls }) => {
    await act(async () => { lever.click(); });
    expect(actions(calls)).toEqual(["restart"]);
    const end = new win.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
    await act(async () => { lever.dispatchEvent(end as unknown as Event); });
    expect(end.defaultPrevented).toBe(true);
    expect(actions(calls)).toEqual(["restart", "stop"]);
    expect(lever.getAttribute("aria-description")).toContain("Pull halfway");
  });
});

function actions(calls: string[]): string[] {
  return calls.filter(call => !call.startsWith("preview:"));
}

test("while pulled, the lever reports the zone a release would fire, then clears", async () => {
  await withLever(async ({ lever, win, calls }) => {
    await pull(lever, win, 13);
    expect(calls.filter(call => call.startsWith("preview:"))).toEqual(["preview:rest", "preview:restart", "preview:null"]);
    calls.length = 0;
    await pull(lever, win, 40);
    expect(calls.filter(call => call.startsWith("preview:"))).toEqual(["preview:restart", "preview:stop", "preview:null"]);
  });
});

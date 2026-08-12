import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ConsequenceDialog, { type ConsequenceCopy } from "../src/pages/integrations/ConsequenceDialog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

const COPY: ConsequenceCopy = {
  titleKey: "integrations.dialog.grok.title",
  changesKey: "integrations.dialog.grok.changes",
  breakageKey: "integrations.dialog.grok.breakage",
  undoKey: "integrations.dialog.grok.undo",
  confirmKey: "integrations.dialog.grok.confirm",
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "ko-KR" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(options: { path?: string; onClose?: () => void; onConfirm?: () => void | Promise<void> } = {}) {
  const path = options.path ?? "/live/home/.grok/config.toml";
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ConsequenceDialog
          copy={{ ...COPY, vars: { path } }}
          onClose={options.onClose ?? (() => {})}
          onConfirm={options.onConfirm ?? (() => {})}
        />
      </LanguageProvider>,
    );
  });
  return container.querySelector("dialog")!;
}

test("renders the four Korean slots in order with the live path and no side effect", async () => {
  const livePath = "/custom/grok-home/config.toml";
  await mount({ path: livePath });

  const title = container.querySelector("h3")!;
  const paragraphs = [...container.querySelectorAll(".integration-consequence-body > p")];
  expect([title.textContent, ...paragraphs.map(paragraph => paragraph.textContent)]).toEqual([
    "Grok Build 연동을 해제할까요?",
    `${livePath}에서 opencodex가 표시해 둔 블록만 제거합니다. 블록 바깥에 직접 쓴 내용은 그대로 둡니다.`,
    "해제하면 Grok Build에서 opencodex 모델 별칭이 사라집니다. xAI 계정으로 쓰던 모델은 그대로입니다.",
    "opencodex가 loopback 주소로 실행 중이면, 다시 켤 때 지금 쓸 수 있는 모델 목록으로 블록을 새로 씁니다.",
  ]);
  expect(container.querySelector(".integration-consequence-body code")?.textContent).toBe(livePath);
  expect(paragraphs).toHaveLength(3);
  expect(container.querySelector(".modal-actions .btn-primary")?.textContent?.trim()).toBe("해제");
});

test("Escape and backdrop dismissal both invoke onClose", async () => {
  let closes = 0;
  const dialog = await mount({ onClose: () => { closes += 1; } });
  const WindowEvent = (testWindow as unknown as { Event: typeof Event }).Event;
  await act(async () => {
    dialog.dispatchEvent(new WindowEvent("cancel", { bubbles: false, cancelable: true }));
  });
  expect(closes).toBe(1);

  await act(async () => { container.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click(); });
  expect(closes).toBe(2);
});

test("clicking the action invokes onConfirm", async () => {
  let confirms = 0;
  await mount({ onConfirm: () => { confirms += 1; } });
  await act(async () => { container.querySelector<HTMLButtonElement>(".modal-actions .btn-primary")!.click(); });
  expect(confirms).toBe(1);
});

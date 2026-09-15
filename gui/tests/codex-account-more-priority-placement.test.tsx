import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CodexAccountPoolCards } from "../src/components/codex-account-pool-cards";
import type { CodexAccountEntry } from "../src/components/codex-account-pool-types";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
type GlobalName = (typeof globals)[number];
const prioritySelector = "#codex-account-priority-pool-1";

let previous: Record<GlobalName, PropertyDescriptor | undefined>;
let testWindow: Window;
let root: Root | null = null;
let host: HTMLElement;

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  previous = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previous;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  host = testWindow.document.createElement("div") as never as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  for (const key of globals) restoreProperty(globalThis, key, previous[key]);
  await testWindow.happyDOM?.close?.();
});

function account(priority: number): CodexAccountEntry {
  return {
    id: "pool-1",
    email: "pool@example.test",
    isMain: false,
    paused: false,
    priority,
    hasCredential: true,
    quota: null,
    quotaAutoRefresh: {
      fiveHourAvailable: false,
      weeklyAvailable: false,
      fiveHourEnabled: false,
      weeklyEnabled: false,
    },
  };
}

async function mount(priority: number): Promise<void> {
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAccountPoolCards
          pool={[account(priority)]}
          activeId={null}
          accountModeState={null}
          switchActionLabel="Switch"
          threshold={80}
          onOpenReset={() => undefined}
          onSwitch={() => undefined}
          onTogglePause={() => undefined}
          pauseUpdatingId={null}
          pauseBusy={false}
          onPriorityChange={() => undefined}
          priorityUpdatingId={null}
          switchingId={null}
          pinnedId={null}
          onReauth={() => undefined}
          onEditAlias={() => undefined}
          onRemove={() => undefined}
        />
      </LanguageProvider>,
    );
  });
}

test("default priority selector is rendered once inside the open more-actions panel", async () => {
  await mount(0);
  const more = host.querySelector<HTMLDetailsElement>("details.codex-account-more");
  expect(more).not.toBeNull();
  expect(host.querySelectorAll(prioritySelector)).toHaveLength(0);

  await act(async () => {
    more!.querySelector<HTMLElement>("summary")!.click();
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  });

  expect(more!.open).toBe(true);
  expect(host.querySelectorAll(prioritySelector)).toHaveLength(1);
  expect(more!.querySelector(prioritySelector)).not.toBeNull();
  expect(host.querySelector(`.codex-account-identity ${prioritySelector}`)).toBeNull();
});

test("non-default priority selector is rendered once inline and out of the closed disclosure", async () => {
  await mount(2);
  const more = host.querySelector<HTMLDetailsElement>("details.codex-account-more");
  expect(more).not.toBeNull();
  expect(more!.open).toBe(false);
  expect(host.querySelectorAll(prioritySelector)).toHaveLength(1);
  expect(more!.querySelector(prioritySelector)).toBeNull();
  expect(host.querySelector(`.codex-account-identity ${prioritySelector}`)).not.toBeNull();
});

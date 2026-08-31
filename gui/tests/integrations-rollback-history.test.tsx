import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { RollbackHistory } from "../src/pages/integrations/RollbackHistory";
import type { IntegrationJournalRow } from "../src/pages/integrations/integration-api";

/**
 * The rollback journal's shape, not its wire contract.
 *
 * The server caps the journal at 50 rows and both Integrations surfaces mapped
 * all of them into individually bordered strips under the real controls. These
 * tests pin the three properties that fix stops it recurring: the newest row is
 * reachable without opening anything, the rest are collapsed, and they reveal a
 * page at a time rather than all at once.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

function row(overrides: Partial<IntegrationJournalRow> & { opId: string }): IntegrationJournalRow {
  return {
    clientId: "hermes",
    kind: "apply",
    at: "2026-08-31T10:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "stored",
    undoable: false,
    ...overrides,
  } as IntegrationJournalRow;
}

/** Newest first, which is the order the journal route returns. */
function rows(count: number): IntegrationJournalRow[] {
  return Array.from({ length: count }, (_, index) => row({
    opId: `op-${index}`,
    at: new Date(Date.UTC(2026, 7, 31, 10, 0, 0) - index * 60_000).toISOString(),
  }));
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
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
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(
  journal: IntegrationJournalRow[],
  options: { showClient?: boolean; onRestore?: (value: IntegrationJournalRow) => void } = {},
) {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <RollbackHistory
          rows={journal}
          showClient={options.showClient}
          onRestore={options.onRestore ?? (() => {})}
        />
      </LanguageProvider>,
    );
  });
}

function visibleRows(): HTMLElement[] {
  return Array.from(container.querySelectorAll(".integration-history-row")) as unknown as HTMLElement[];
}

function disclosure(): HTMLDetailsElement | null {
  return container.querySelector(".integration-history-older") as unknown as HTMLDetailsElement | null;
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return (Array.from(container.querySelectorAll("button")) as unknown as HTMLButtonElement[])
    .find(button => (button.textContent ?? "").trim() === text);
}

test("a capped journal renders one row, not fifty", async () => {
  // 50 is the server's `listOperations` default, so this is the real worst case.
  await mount(rows(50));

  const details = disclosure();
  expect(details).not.toBeNull();
  expect(details!.open).toBe(false);
  // Everything past the newest row is inside the closed disclosure.
  expect(visibleRows().filter(node => !node.closest(".integration-history-older"))).toHaveLength(1);
});

test("the newest row's action is reachable without expanding anything", async () => {
  /*
   * This is the whole point of keeping one row visible: the operation a user
   * undoes is almost always the one they just performed, and burying it behind
   * a disclosure would trade one usability problem for another.
   */
  let restored: IntegrationJournalRow | null = null;
  await mount([
    row({ opId: "op-newest", undoable: true }),
    ...rows(20),
  ], { onRestore: value => { restored = value; } });

  const undo = buttonByText("Undo");
  expect(undo).toBeDefined();
  expect(undo!.closest(".integration-history-older")).toBeNull();
  await act(async () => { undo!.click(); });
  expect(restored?.opId).toBe("op-newest");
});

test("older rows reveal a page at a time", async () => {
  await mount(rows(20));
  const details = disclosure()!;
  await act(async () => { details.open = true; });

  const inside = () => visibleRows().filter(node => node.closest(".integration-history-older"));
  // PAGE = 6, matching ClaudeDesktop's lane.
  expect(inside()).toHaveLength(6);

  await act(async () => { buttonByText("Show 6 more")!.click(); });
  expect(inside()).toHaveLength(12);

  await act(async () => { buttonByText("Show 6 more")!.click(); });
  expect(inside()).toHaveLength(18);

  // 19 older rows: the last reveal is partial and says so.
  await act(async () => { buttonByText("Show 1 more")!.click(); });
  expect(inside()).toHaveLength(19);
  expect(buttonByText("Show 1 more")).toBeUndefined();
});

test("a journal that fits shows no disclosure at all", async () => {
  await mount(rows(1));
  expect(disclosure()).toBeNull();
  expect(visibleRows()).toHaveLength(1);
});

test("an expired snapshot offers no control anywhere in the list", async () => {
  await mount([
    row({ opId: "op-live", undoable: true }),
    row({ opId: "op-gone", snapshot: "expired" }),
  ]);
  await act(async () => { disclosure()!.open = true; });

  const expired = visibleRows().find(node => (node.textContent ?? "").includes("Backup expired"));
  expect(expired).toBeDefined();
  expect(expired!.querySelector("button")).toBeNull();
});

test("the overview names the client on every row; a client tab does not", async () => {
  /*
   * The overview is the only surface showing one chronology across clients, so
   * a row there is ambiguous without its client. On a client tab the heading
   * already says it.
   */
  await mount([row({ opId: "op-a", clientId: "aside" })], { showClient: true });
  expect(container.querySelector(".integration-history-client")?.textContent).toBe("aside");

  await act(async () => { root!.unmount(); root = null; });
  await mount([row({ opId: "op-a", clientId: "aside" })]);
  expect(container.querySelector(".integration-history-client")).toBeNull();
});

test("rows share one boundary instead of one border each", async () => {
  /*
   * The visual complaint was texture, not count: every row carried its own
   * border and radius, so a dozen of them read as loose stacked strips. The
   * container owns the boundary now, which is a structural fact the stylesheet
   * depends on.
   */
  await mount(rows(3));
  expect(container.querySelector(".integration-history")).not.toBeNull();
  expect(container.querySelectorAll(".integration-history-list").length).toBeGreaterThan(0);
});

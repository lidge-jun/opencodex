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

/*
 * No `as` cast. An assertion here would let a fixture name a client this build
 * does not have -- `gui/tests` sits outside every tsconfig `include`, so a bad
 * literal would not even be caught by typecheck, and the test would pass while
 * documenting a client that does not exist.
 */
function row(overrides: Partial<IntegrationJournalRow> & { opId: string }): IntegrationJournalRow {
  return {
    clientId: "hermes",
    kind: "apply",
    at: "2026-08-31T10:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "stored",
    undoable: false,
    ...overrides,
  };
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

/** Re-render the same tree with a new journal, the way a refresh does. */
async function rerender(journal: IntegrationJournalRow[]) {
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <RollbackHistory rows={journal} onRestore={() => {}} />
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

test("restoring from inside the fold passes that row, not the newest one", async () => {
  /*
   * The newest row's Undo was covered; a folded row's control was not, and the
   * two are wired separately -- the fold maps over a sliced copy. Passing the
   * wrong row here is the most destructive defect this component could have: the
   * user asks to roll back to a specific point in their history and silently
   * gets a different one, with a confirmation dialog that names the operation
   * they chose. Nothing downstream can catch it, because the request is
   * well-formed and the server has no way to know it was not what was meant.
   */
  let restored: IntegrationJournalRow | null = null;
  const journal = rows(12);
  await mount(journal, { onRestore: value => { restored = value; } });
  await act(async () => { disclosure()!.open = true; });

  const folded = visibleRows().filter(node => node.closest(".integration-history-older"));
  const third = folded[2]!;
  await act(async () => { third.querySelector("button")!.click(); });

  // Row 0 is outside the fold, so the third folded row is journal[3].
  expect(restored).not.toBeNull();
  expect(restored!.opId).toBe(journal[3]!.opId);
  expect(restored!.opId).not.toBe(journal[0]!.opId);
});

test("the overview names the client on every row; a client tab does not", async () => {
  /*
   * The overview is the only surface showing one chronology across clients, so
   * a row there is ambiguous without its client. On a client tab the heading
   * already says it.
   */
  await mount([row({ opId: "op-a", clientId: "dsh" })], { showClient: true });
  expect(container.querySelector(".integration-history-client")?.textContent).toBe("dsh");

  await act(async () => { root!.unmount(); root = null; });
  await mount([row({ opId: "op-a", clientId: "dsh" })]);
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

test("the disclosure is keyboard-operable and its summary is the only added tab stop", async () => {
  /*
   * Collapsing rows behind <details> hides them from the accessibility tree and
   * from Tab in a real browser. happy-dom keeps closed-<details> children in the
   * DOM, so a presence assertion cannot prove reachability -- these assertions
   * pin the two structural facts that DO carry it: the disclosure is a native
   * <details> with a real <summary>, which is natively focusable and operable by
   * Enter/Space. A div-with-onClick would leave the older rows unreachable by
   * keyboard while every DOM-presence assertion still passed.
   */
  await mount(rows(20));
  const details = disclosure()!;
  expect(details.tagName).toBe("DETAILS");
  const summary = details.querySelector("summary");
  expect(summary).not.toBeNull();
  // A div+onClick would render the older rows unreachable by keyboard.
  expect(summary!.tagName).toBe("SUMMARY");

  // The summary is the ONE tab stop the collapse adds: no other node in the
  // region takes one, so the disclosure costs a keyboard user a single keystroke.
  const region = container.querySelector(".integration-history")!;
  const extraStops = Array.from(region.querySelectorAll("[tabindex]"))
    .filter(node => node.getAttribute("tabindex") !== "-1");
  expect(extraStops).toHaveLength(0);
});

test("a refresh that prepends an entry does not re-collapse what was expanded", async () => {
  /*
   * Every restore refreshes the journal, and the refresh prepends the operation
   * the user just performed. If the reveal count reset on that re-render, a user
   * paging back through history would be thrown to the top by their own undo --
   * the one moment they are certainly reading older rows. The count lives in
   * component state and the component is not remounted, so it survives; this
   * pins that, because moving the state up or keying the element on the newest
   * row would silently break it.
   */
  await mount(rows(20));
  const details = disclosure()!;
  await act(async () => { details.open = true; });
  await act(async () => { buttonByText("Show 6 more")!.click(); });
  const revealed = visibleRows().length;
  expect(revealed).toBeGreaterThan(7);

  // The restore lands and the journal comes back one row longer.
  const refreshed = [row({ opId: "op-new", at: new Date(Date.UTC(2026, 7, 31, 11, 0, 0)).toISOString() }), ...rows(20)];
  await rerender(refreshed);

  expect(disclosure()!.open).toBe(true);
  // Same count, not a reset to one visible row plus a fresh page. The reveal
  // budget applies to the older list, so prepending shifts what fills it rather
  // than adding to it -- what matters is that the budget itself survived.
  expect(visibleRows().length).toBe(revealed);
  // And the row the user just created is the one now sitting outside the fold.
  const outside = Array.from(container.querySelectorAll(".integration-history-row"))
    .filter(node => !(node as unknown as HTMLElement).closest(".integration-history-older"));
  expect(outside).toHaveLength(1);
});

/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { useT } from "../src/i18n/shared";
import { spendableGrant, useAnthropicResetGrants, type AnthropicResetGrantSnapshot } from "../src/hooks/useAnthropicResetGrants";
import { AnthropicGrantBadge, AnthropicResetGrantModal } from "../src/components/provider-workspace/AnthropicResetGrants";

// The dialog's one irreversible action: after a claim with an unknown outcome it
// must keep the operation id and retry only that id, never mint a new one.

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let testWindow: Window;

const SNAPSHOT = {
  accountId: "acct-1",
  eligible: true,
  ineligibleReason: null,
  atLimit: false,
  grants: [{
    id: "opus55-launch-promax-20260921",
    label: "Launch reset",
    resetsTotal: 1,
    resetsLeft: 1,
    startsAt: "2026-09-22T16:00:00+00:00",
    endsAt: "2099-10-22T16:00:00+00:00",
    clears: ["five_hour", "seven_day"],
    paused: false,
    usableNow: true,
    useRequiresLimit: false,
    percentUsed: { five_hour: 3, seven_day: 14 },
  }],
  nextGrantId: "opus55-launch-promax-20260921",
  pendingOperation: null,
  journalAvailable: true,
};

test("switching pools rejects stale equal-ID reset reads and sends the selected provider", async () => {
  const { createRoot } = await import("react-dom/client");
  let controller!: ReturnType<typeof useAnthropicResetGrants>;
  const reads: Array<{ provider: string; resolve: (response: Response) => void }> = [];
  let spendBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "POST") {
      spendBody = JSON.parse(String(init.body));
      return Response.json({ provider: "anthropic", code: "consumed", resetsLeft: 0 });
    }
    return new Promise<Response>(resolve => reads.push({ provider: url.searchParams.get("provider") ?? "anthropic", resolve }));
  }) as typeof fetch;
  function PoolHarness({ provider }: { provider: "anthropic" | "anthropic2" }) {
    const current = useAnthropicResetGrants({ apiBase: "", provider, accountIds: ["acct-1"], enabled: true });
    useLayoutEffect(() => { controller = current; }, [current]);
    return null;
  }
  const host = testWindow.document.createElement("div");
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () => { root.render(<PoolHarness provider="anthropic2" />); });
    expect(reads[0]?.provider).toBe("anthropic2");
    await act(async () => { root.render(<PoolHarness provider="anthropic" />); });
    expect(reads[1]?.provider).toBe("anthropic");
    await act(async () => {
      reads[1]!.resolve(Response.json({ ...SNAPSHOT, provider: "anthropic" }));
      await Promise.resolve();
    });
    await act(async () => {
      reads[0]!.resolve(Response.json({ ...SNAPSHOT, provider: "anthropic2", atLimit: true }));
      await Promise.resolve();
    });
    const current = controller.entries["acct-1"];
    expect(current?.status).toBe("ready");
    if (current?.status === "ready") expect(current.snapshot.atLimit).toBe(false);
    await act(async () => { root.render(<PoolHarness provider="anthropic2" />); });
    const outcome = await controller.spend("acct-1", { grantId: "fixture-grant", operationId: "11111111-1111-4111-8111-111111111111" });
    expect(spendBody?.provider).toBe("anthropic2");
    // A response cannot settle B's irreversible operation, even when the IDs match.
    expect(outcome.kind).toBe("unknown");
  } finally {
    reads.forEach(read => read.resolve(Response.json({ ...SNAPSHOT, provider: read.provider })));
    await act(async () => { root.unmount(); });
  }
});

beforeEach(() => {
  testWindow = new Window({ url: "http://localhost/" });
  const keys = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  restoreGlobals = () => {
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreGlobals?.();
  testWindow.close();
});

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

let harnessController: ReturnType<typeof useAnthropicResetGrants> | undefined;

function Harness() {
  const t = useT();
  const controller = useAnthropicResetGrants({ apiBase: "", accountIds: ["acct-1"], enabled: true });
  harnessController = controller;
  const [open, setOpen] = useState(false);
  return (
    <>
      <AnthropicGrantBadge entry={controller.entries["acct-1"]} t={t} onClick={() => setOpen(true)} />
      {open && (
        <AnthropicResetGrantModal accountId="acct-1" accountLabel="acct-1" entry={controller.entries["acct-1"]}
          controller={controller} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Harness /></LanguageProvider>);
  });
  await tick();
  await tick();
  return { container, root };
}

async function click(container: HTMLElement, selector: string): Promise<void> {
  const target = container.querySelector(selector) as HTMLButtonElement | null;
  expect(target).not.toBeNull();
  await act(async () => { target!.click(); });
  await tick();
  await tick();
}

test("the badge counts unspent resets and the dialog retries an unknown outcome with the same id", async () => {
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/anthropic/reset-grants?")) return Response.json(SNAPSHOT);
    if (url === "/api/anthropic/reset-grants/consume") {
      posts.push(JSON.parse(String(init?.body)));
      if (posts.length === 1) throw new TypeError("connection reset");
      return Response.json({ code: "reset", replayed: false, resetsLeft: 0, operationId: posts[1].operationId });
    }
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;

  const { container, root } = await mount();
  const badge = container.querySelector("[data-anthropic-grant-badge]");
  expect(badge?.getAttribute("data-anthropic-grant-badge")).toBe("1");
  expect(badge?.className).toContain("badge-amber");

  await click(container, "[data-anthropic-grant-badge]");
  expect(container.textContent).toContain("Launch reset");
  expect(container.textContent).toContain("1 of 1 left");

  await click(container, "[data-anthropic-grant-use]");
  expect(posts).toHaveLength(0);
  await click(container, "[data-anthropic-grant-confirm]");
  expect(posts).toHaveLength(1);
  expect(container.querySelector("[data-anthropic-grant-use]")).toBeNull();
  expect(container.textContent).toContain("outcome is unknown");

  await click(container, "[data-anthropic-grant-retry]");
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0]).toMatchObject({ accountId: "acct-1", grantId: "opus55-launch-promax-20260921" });
  expect(String(posts[0].operationId)).toMatch(/^[0-9a-f-]{36}$/);
  expect(container.textContent).toContain("Limits reset. 0 reset(s) left.");

  await act(async () => { root.unmount(); });
});

test("a pending attempt held by the server is resumed instead of starting a new one", async () => {
  const pendingId = "5c1f7a55-9b1e-4d8e-a0c4-2f5b3c9d7e61";
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/anthropic/reset-grants?")) {
      return Response.json({ ...SNAPSHOT, pendingOperation: { operationId: pendingId, grantId: SNAPSHOT.grants[0].id, createdAt: Date.now(), retryableUntil: Date.now() + 60_000 } });
    }
    posts.push(JSON.parse(String(init?.body)));
    return Response.json({ code: "already_used", replayed: false, resetsLeft: 0 });
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(container.querySelector("[data-anthropic-grant-use]")).toBeNull();
  await click(container, "[data-anthropic-grant-retry]");
  expect(posts).toEqual([{ accountId: "acct-1", grantId: SNAPSHOT.grants[0].id, operationId: pendingId }]);
  await act(async () => { root.unmount(); });
});

test("a refused same-id retry keeps holding the attempt instead of offering a new id", async () => {
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/anthropic/reset-grants?")) return Response.json(SNAPSHOT);
    posts.push(JSON.parse(String(init?.body)));
    if (posts.length === 1) throw new TypeError("connection reset");
    return Response.json({ error: { code: "ledger_busy", message: "busy" } }, { status: 503 });
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  await click(container, "[data-anthropic-grant-use]");
  await click(container, "[data-anthropic-grant-confirm]");
  await click(container, "[data-anthropic-grant-retry]");
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(container.querySelector("[data-anthropic-grant-retry]")).not.toBeNull();
  expect(container.querySelector("[data-anthropic-grant-use]")).toBeNull();
  expect(container.textContent).toContain("journal is busy");
  await act(async () => { root.unmount(); });
});

test("a replayed refusal reads as that refusal, not as a success", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/anthropic/reset-grants?")) return Response.json(SNAPSHOT);
    return Response.json({ code: "rate_limited", replayed: true, resetsLeft: null });
  }) as typeof fetch;

  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  await click(container, "[data-anthropic-grant-use]");
  await click(container, "[data-anthropic-grant-confirm]");
  expect(container.textContent).toContain("Too many requests. Nothing was used");
  expect(container.textContent).not.toContain("already settled earlier");
  expect(container.querySelector(".pws-status-warn")).not.toBeNull();
  await act(async () => { root.unmount(); });
});

// ---- Grant picker: the user chooses which grant a reset spends. ----

function grant(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, label: id + " reset", resetsTotal: 1, resetsLeft: 1,
    startsAt: null, endsAt: "2099-12-01T00:00:00+00:00", clears: ["five_hour"],
    paused: false, usableNow: true, useRequiresLimit: false, percentUsed: {},
    ...overrides,
  };
}

// Upstream order deliberately puts the later-expiring grant first.
const PICKER = {
  ...SNAPSHOT,
  grants: [
    grant("late", { endsAt: "2099-12-01T00:00:00+00:00", clears: ["five_hour"] }),
    grant("soon", { endsAt: "2099-11-01T00:00:00+00:00", clears: ["seven_day", "seven_day_overage_included"] }),
    grant("paused", { endsAt: "2099-10-01T00:00:00+00:00", paused: true }),
    grant("notyet", { endsAt: "2099-10-02T00:00:00+00:00", usableNow: false }),
    grant("empty", { endsAt: "2099-10-03T00:00:00+00:00", resetsLeft: 0 }),
    grant("limit", { endsAt: "2099-10-04T00:00:00+00:00", useRequiresLimit: true }),
    grant("nodate", { endsAt: null }),
  ],
  nextGrantId: "late",
};

const PICKER_ID = "11111111-2222-4333-8444-555555555555";

function radio(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector(`[role="radio"][data-anthropic-grant="${id}"]`) as HTMLElement | null;
  expect(element).not.toBeNull();
  return element!;
}

function checkedId(container: HTMLElement): string | null {
  const checked = container.querySelectorAll('[role="radio"][aria-checked="true"]');
  expect(checked.length).toBeLessThanOrEqual(1);
  return checked[0]?.getAttribute("data-anthropic-grant") ?? null;
}

async function press(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event);
  });
  await tick();
}

function pickerFetch(posts: Array<Record<string, unknown>>, options: {
  read?: (reads: number) => unknown;
  post?: (body: Record<string, unknown>, count: number) => Response | Promise<Response>;
} = {}): typeof fetch {
  let reads = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/anthropic/reset-grants?")) {
      reads += 1;
      return Response.json(options.read?.(reads) ?? PICKER);
    }
    if (url === "/api/anthropic/reset-grants/consume") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(body);
      return options.post?.(body, posts.length) ?? Response.json({ code: "reset", replayed: false, resetsLeft: 0 });
    }
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;
}

test("the default grant is the usable one that expires first, not upstream order", () => {
  const snapshot = { ...PICKER, pendingOperation: null } as unknown as AnthropicResetGrantSnapshot;
  expect(spendableGrant(snapshot)?.id).toBe("soon");
  // A malformed or missing end date never sorts ahead of a real one.
  const odd = { ...snapshot, grants: [grant("bad", { endsAt: "not-a-date" }), grant("none", { endsAt: null }), grant("real")] } as unknown as AnthropicResetGrantSnapshot;
  expect(spendableGrant(odd)?.id).toBe("real");
  expect(spendableGrant({ ...snapshot, journalAvailable: false })).toBeUndefined();
});

test("grants render as a radio group; unusable grants are disabled with their reason", async () => {
  globalThis.fetch = pickerFetch([]);
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Choose a reset to use");
  expect(checkedId(container)).toBe("soon");
  expect(radio(container, "soon").tabIndex).toBe(0);
  expect(radio(container, "late").tabIndex).toBe(-1);
  const notes: Record<string, string> = {
    paused: "Paused", notyet: "Not usable yet", empty: "No resets left", limit: "Usable once this account hits a limit",
  };
  for (const [id, note] of Object.entries(notes)) {
    const option = radio(container, id);
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.tabIndex).toBe(-1);
    expect(option.textContent).toContain(note);
    await act(async () => { option.click(); });
    expect(checkedId(container)).toBe("soon");
  }
  for (const id of ["late", "soon", "nodate"]) expect(radio(container, id).getAttribute("aria-disabled")).not.toBe("true");
  await act(async () => { root.unmount(); });
});

test("a clicked grant is confirmed by name, expiry and windows, and its id is what gets spent", async () => {
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = pickerFetch(posts);
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(container.textContent).toContain("The reset that expires first is selected");
  await act(async () => { radio(container, "late").click(); });
  expect(checkedId(container)).toBe("late");
  // The default hint would now be false: the chosen grant is not the one expiring first.
  expect(container.textContent).not.toContain("The reset that expires first is selected");
  await click(container, "[data-anthropic-grant-use]");
  const confirm = container.textContent ?? "";
  expect(confirm).toContain("late reset");
  expect(confirm).toContain("Expires");
  expect(confirm).toContain("2099");
  expect(confirm).toContain("Clears: 5-hour limit");
  expect(posts).toHaveLength(0);
  await click(container, "[data-anthropic-grant-confirm]");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ accountId: "acct-1", grantId: "late" });
  expect(String(posts[0].operationId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await act(async () => { root.unmount(); });
});

test("arrow keys move focus and selection across usable grants only; Space selects", async () => {
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = pickerFetch(posts);
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  await act(async () => { radio(container, "soon").focus(); });
  await press(radio(container, "soon"), "ArrowDown");
  expect(checkedId(container)).toBe("nodate");
  expect(testWindow.document.activeElement?.getAttribute("data-anthropic-grant")).toBe("nodate");
  await press(radio(container, "nodate"), "ArrowDown");
  expect(checkedId(container)).toBe("late");
  await press(radio(container, "late"), "ArrowUp");
  expect(checkedId(container)).toBe("nodate");
  await press(radio(container, "nodate"), "Home");
  expect(checkedId(container)).toBe("late");
  await press(radio(container, "late"), "End");
  expect(checkedId(container)).toBe("nodate");
  await press(radio(container, "paused"), " ");
  expect(checkedId(container)).toBe("nodate");
  await click(container, "[data-anthropic-grant-use]");
  await click(container, "[data-anthropic-grant-confirm]");
  expect(posts[0]).toMatchObject({ grantId: "nodate" });
  await act(async () => { root.unmount(); });
});

test("after an unknown outcome the held grant is locked: no picker, retry posts the same grant and id", async () => {
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = pickerFetch(posts, {
    post: (_body, count) => {
      if (count === 1) throw new TypeError("connection reset");
      return Response.json({ code: "reset", replayed: false, resetsLeft: 0 });
    },
  });
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  await act(async () => { radio(container, "late").click(); });
  await click(container, "[data-anthropic-grant-use]");
  await click(container, "[data-anthropic-grant-confirm]");
  expect(container.querySelector('[role="radio"]')).toBeNull();
  expect(container.textContent).toContain("late reset");
  await click(container, "[data-anthropic-grant-retry]");
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0]).toMatchObject({ grantId: "late" });
  await act(async () => { root.unmount(); });
});

test("a server-held attempt on another grant locks the picker and retries that grant", async () => {
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = pickerFetch(posts, {
    read: () => ({ ...PICKER, pendingOperation: { operationId: PICKER_ID, grantId: "late", retryableUntil: Date.now() + 60_000 } }),
  });
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(container.querySelector('[role="radio"]')).toBeNull();
  expect(container.querySelector("[data-anthropic-grant-use]")).toBeNull();
  expect(container.textContent).toContain("late reset");
  await click(container, "[data-anthropic-grant-retry]");
  expect(posts).toEqual([{ accountId: "acct-1", grantId: "late", operationId: PICKER_ID }]);
  await act(async () => { root.unmount(); });
});

test("an unresolved prior attempt on the chosen grant is resumed after the refusal re-reads the account", async () => {
  const posts: Array<Record<string, unknown>> = [];
  let refused = false;
  globalThis.fetch = pickerFetch(posts, {
    read: () => refused
      ? { ...PICKER, pendingOperation: { operationId: PICKER_ID, grantId: "late", retryableUntil: Date.now() + 60_000 } }
      : PICKER,
    post: (body, count) => {
      if (count === 1) {
        refused = true;
        return Response.json({ error: { code: "unresolved_prior_operation", message: "x", pendingOperationId: PICKER_ID } }, { status: 409 });
      }
      return Response.json({ code: "already_used", replayed: false, resetsLeft: 0, operationId: body.operationId });
    },
  });
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  await act(async () => { radio(container, "late").click(); });
  await click(container, "[data-anthropic-grant-use]");
  await click(container, "[data-anthropic-grant-confirm]");
  expect(container.querySelector('[role="radio"]')).toBeNull();
  await click(container, "[data-anthropic-grant-retry]");
  expect(posts[1]).toEqual({ accountId: "acct-1", grantId: "late", operationId: PICKER_ID });
  await act(async () => { root.unmount(); });
});

test("a confirmed grant that stops being usable sends the dialog back to the picker without posting", async () => {
  const posts: Array<Record<string, unknown>> = [];
  let pauseLate = false;
  globalThis.fetch = pickerFetch(posts, {
    read: () => pauseLate ? { ...PICKER, grants: PICKER.grants.map(item => item.id === "late" ? { ...item, paused: true } : item) } : PICKER,
  });
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  await act(async () => { radio(container, "late").click(); });
  await click(container, "[data-anthropic-grant-use]");
  expect(container.querySelector("[data-anthropic-grant-confirm]")).not.toBeNull();
  pauseLate = true;
  await act(async () => { await harnessController!.refresh("acct-1"); });
  await tick();
  expect(container.querySelector("[data-anthropic-grant-confirm]")).toBeNull();
  expect(checkedId(container)).toBe("soon");
  expect(container.textContent).toContain("This reset cannot be used right now");
  expect(posts).toHaveLength(0);
  await act(async () => { root.unmount(); });
});

test("an unavailable journal disables every grant and says why", async () => {
  globalThis.fetch = pickerFetch([], { read: () => ({ ...PICKER, journalAvailable: false }) });
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  for (const option of container.querySelectorAll('[role="radio"]')) expect(option.getAttribute("aria-disabled")).toBe("true");
  expect(checkedId(container)).toBeNull();
  expect((container.querySelector("[data-anthropic-grant-use]") as HTMLButtonElement).disabled).toBe(true);
  expect(container.textContent).toContain("The reset journal is busy or unavailable");
  await act(async () => { root.unmount(); });
});


test("a grant with an unparseable end date and no reported windows confirms without inventing either", async () => {
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = pickerFetch(posts, {
    read: () => ({ ...PICKER, grants: [grant("odd", { endsAt: "not-a-date", startsAt: "also-bad", clears: [] })] }),
  });
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(checkedId(container)).toBe("odd");
  expect(container.textContent).not.toContain("Invalid Date");
  expect(container.textContent).not.toContain("NaN");
  await click(container, "[data-anthropic-grant-use]");
  expect(container.textContent).not.toContain("Expires");
  expect(container.textContent).toContain("The limits this reset clears were not reported.");
  await click(container, "[data-anthropic-grant-confirm]");
  expect(posts[0]).toMatchObject({ grantId: "odd" });
  await act(async () => { root.unmount(); });
});


test("opening the dialog re-reads the account, so an attempt started elsewhere locks the picker", async () => {
  const posts: Array<Record<string, unknown>> = [];
  let startedElsewhere = false;
  globalThis.fetch = pickerFetch(posts, {
    read: () => startedElsewhere
      ? { ...PICKER, pendingOperation: { operationId: PICKER_ID, grantId: "soon", retryableUntil: Date.now() + 60_000 } }
      : PICKER,
  });
  const { container, root } = await mount();
  startedElsewhere = true;
  await click(container, "[data-anthropic-grant-badge]");
  expect(container.querySelector('[role="radio"]')).toBeNull();
  expect(container.querySelector("[data-anthropic-grant-use]")).toBeNull();
  await click(container, "[data-anthropic-grant-retry]");
  expect(posts).toEqual([{ accountId: "acct-1", grantId: "soon", operationId: PICKER_ID }]);
  await act(async () => { root.unmount(); });
});


test("with nothing selectable the radio group still has exactly one tab stop", async () => {
  globalThis.fetch = pickerFetch([], { read: () => ({ ...PICKER, journalAvailable: false }) });
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  const stops = [...container.querySelectorAll('[role="radio"]')].filter(option => (option as HTMLElement).tabIndex === 0);
  expect(stops.map(option => option.getAttribute("data-anthropic-grant"))).toEqual(["late"]);
  // Two grants but no choice: the "expires first is selected" hint would be false.
  expect(container.textContent).not.toContain("The reset that expires first is selected");
  await act(async () => { root.unmount(); });
});

test("the re-read on open keeps the list and badge, and holds the spend button until it lands", async () => {
  let reads = 0;
  let release: (() => void) | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/anthropic/reset-grants?")) throw new Error("unexpected fetch " + url);
    reads += 1;
    if (reads === 1) return Response.json(PICKER);
    await new Promise<void>(resolve => { release = resolve; });
    return Response.json(PICKER);
  }) as typeof fetch;
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  expect(reads).toBe(2);
  expect(container.querySelector("[data-anthropic-grant-badge]")?.getAttribute("data-anthropic-grant-badge")).toBe("6");
  expect(checkedId(container)).toBe("soon");
  expect((container.querySelector("[data-anthropic-grant-use]") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { release!(); });
  await tick();
  await tick();
  expect((container.querySelector("[data-anthropic-grant-use]") as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { root.unmount(); });
});

test("a picked grant stays picked across a re-read while it is still usable", async () => {
  globalThis.fetch = pickerFetch([]);
  const { container, root } = await mount();
  await click(container, "[data-anthropic-grant-badge]");
  await act(async () => { radio(container, "late").click(); });
  await act(async () => { await harnessController!.refresh("acct-1"); });
  await tick();
  expect(checkedId(container)).toBe("late");
  await act(async () => { root.unmount(); });
});


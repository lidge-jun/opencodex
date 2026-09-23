/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { useT } from "../src/i18n/shared";
import { useAnthropicResetGrants } from "../src/hooks/useAnthropicResetGrants";
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

function Harness() {
  const t = useT();
  const controller = useAnthropicResetGrants({ apiBase: "", accountIds: ["acct-1"], enabled: true });
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

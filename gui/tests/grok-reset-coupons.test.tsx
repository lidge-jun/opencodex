/**
 * The Grok reset-coupon surface on xAI account rows.
 *
 * These cases exist because the dangerous paths here are the quiet ones: a
 * replayed *failure* arrives as HTTP 200, an aborted redemption may still be
 * executing upstream, and a per-row retry used to cancel every sibling read.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoots: Root[];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ITEM: WorkspaceItem = {
  name: "xai",
  adapter: "xai",
  baseUrl: "https://api.x.ai",
  authMode: "oauth",
};

type CouponRow = { tokenId: string; validityStart: string; validityEnd: string };

type Harness = {
  coupons: Map<string, CouponRow[]>;
  readStatus: Map<string, number>;
  reads: string[];
  consumes: Array<{ accountId: string; tokenId: string; operationId: string }>;
  consumeReply: () => Promise<Response>;
  holdReads: boolean;
  releaseRead: Array<() => void>;
  inFlight: number;
  peakInFlight: number;
};

let harness: Harness;

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/grok/reset-coupons/consume")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { accountId: string; tokenId: string; operationId: string };
      harness.consumes.push(body);
      return harness.consumeReply();
    }
    if (url.includes("/api/grok/reset-coupons")) {
      const accountId = new URL(url, "http://proxy").searchParams.get("accountId") ?? "";
      harness.reads.push(accountId);
      harness.inFlight += 1;
      harness.peakInFlight = Math.max(harness.peakInFlight, harness.inFlight);
      if (harness.holdReads) {
        await new Promise<void>(resolve => harness.releaseRead.push(resolve));
      }
      harness.inFlight -= 1;
      const status = harness.readStatus.get(accountId) ?? 200;
      if (status !== 200) return json({ error: { code: status === 401 ? "auth_failed" : "upstream_error" } }, status);
      return json({ accountId, tokens: harness.coupons.get(accountId) ?? [], remaining: 0 });
    }
    return json({});
  }) as typeof fetch;
}

async function mountPanel(accounts: Array<Record<string, unknown>>): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  const handlers = {
    onLogin: async () => {},
    onLogout: async () => {},
    onReauth: async () => {},
    onSwitchAccount: async () => {},
    onSwitchApiKey: async () => {},
    onRemoveAccount: async () => {},
    onRemoveApiKey: async () => {},
    onAddApiKey: async () => {},
    onEditAlias: async () => {},
  } as unknown as Parameters<typeof ProviderAuthPanel>[0]["authHandlers"];
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={ITEM}
          apiBase="http://proxy"
          oauth={{ loggedIn: true }}
          accounts={accounts as never}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
}

function badges(host: ParentNode): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-grok-coupon-badge]")];
}

function dialogText(host: ParentNode): string {
  return host.querySelector(".modal-card")?.textContent ?? "";
}

function buttonWithText(host: ParentNode, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>(".modal-card button")]
    .find(button => (button.textContent ?? "").includes(text));
  if (!found) throw new Error(`no dialog button matching ${text}; saw: ${dialogText(host)}`);
  return found;
}

async function openDialog(host: HTMLElement, index = 0): Promise<void> {
  await act(async () => { badges(host)[index].click(); await flush(); });
}

const ACCOUNT = (id: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${id}@example.com`, active: false, ...extra,
});

const COUPON = (tokenId: string, endDays: number): CouponRow => ({
  tokenId,
  validityStart: new Date(Date.now() - 86_400_000).toISOString(),
  validityEnd: new Date(Date.now() + endDays * 86_400_000).toISOString(),
});

beforeEach(() => {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  harness = {
    coupons: new Map(),
    readStatus: new Map(),
    reads: [],
    consumes: [],
    consumeReply: async () => json({ success: true, code: "redeemed", replayed: false }),
    holdReads: false,
    releaseRead: [],
    inFlight: 0,
    peakInFlight: 0,
  };
  installFetch();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountedRoots = [];
});

afterEach(async () => {
  for (const release of harness.releaseRead) release();
  for (const root of mountedRoots) {
    await act(async () => { root.unmount(); });
  }
  mountedRoots = [];
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
});

test("each signed-in xAI row badges its own coupon count, and a reauth row is never read", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 20), COUPON("restok_a2", 5)]);
  harness.coupons.set("acct-b", []);
  const host = await mountPanel([ACCOUNT("acct-a"), ACCOUNT("acct-b"), ACCOUNT("acct-c", { needsReauth: true })]);

  expect(badges(host).map(badge => badge.dataset.grokCouponBadge)).toEqual(["2", "0"]);
  expect(harness.reads.sort()).toEqual(["acct-a", "acct-b"]);
});

test("a failed read badges the row as an error and the dialog separates auth from upstream", async () => {
  harness.readStatus.set("acct-a", 502);
  harness.readStatus.set("acct-b", 401);
  const host = await mountPanel([ACCOUNT("acct-a"), ACCOUNT("acct-b")]);

  expect(badges(host).map(badge => badge.dataset.grokCouponBadge)).toEqual(["error", "error"]);

  await openDialog(host, 0);
  expect(dialogText(host)).toContain("Could not read reset coupons");
  await act(async () => { buttonWithText(host, "Try again").click(); await flush(); });
  expect(harness.reads.filter(id => id === "acct-a").length).toBe(2);
});

test("redeeming spends the nearest-expiry coupon with a client-minted UUIDv4", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_far", 30), COUPON("restok_near", 2)]);
  const host = await mountPanel([ACCOUNT("acct-a")]);

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });

  expect(harness.consumes.length).toBe(1);
  expect(harness.consumes[0].tokenId).toBe("restok_near");
  expect(harness.consumes[0].accountId).toBe("acct-a");
  expect(harness.consumes[0].operationId).toMatch(UUID_V4);
  expect(dialogText(host)).toContain("Coupon redeemed");
});

test("a replayed failure is reported as a failure, never as a completed reset", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.consumeReply = async () => json({ code: "redeem_failed", replayed: true, tokenId: "restok_a1" });
  const host = await mountPanel([ACCOUNT("acct-a")]);

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });

  const alert = host.querySelector('.modal-card [role="alert"]')?.textContent ?? "";
  expect(alert).toContain("Redemption failed");
  expect(dialogText(host)).not.toContain("Coupon redeemed");
});

test("a 409 identity mismatch clears the held operation id", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.consumeReply = async () => json({ error: { code: "operation_id_owned_by_another_account" } }, 409);
  const host = await mountPanel([ACCOUNT("acct-a")]);

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });
  expect(dialogText(host)).toContain("belongs to another account");

  await act(async () => { buttonWithText(host, "Cancel").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });

  expect(harness.consumes.length).toBe(2);
  expect(harness.consumes[1].operationId).not.toBe(harness.consumes[0].operationId);
  expect(harness.consumes[1].operationId).toMatch(UUID_V4);
});

test("ledger capacity gets its own retryable message", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.consumeReply = async () => json({ error: { code: "capacity" } }, 503);
  const host = await mountPanel([ACCOUNT("acct-a")]);

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });

  expect(dialogText(host)).toContain("journal is full");
});

test("an aborted redemption stops posting, re-reads the account, and offers no retry", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.consumeReply = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  const host = await mountPanel([ACCOUNT("acct-a")]);

  await openDialog(host);
  await act(async () => { buttonWithText(host, "Use 1 coupon").click(); await flush(); });
  await act(async () => { buttonWithText(host, "Use coupon").click(); await flush(); });

  expect(dialogText(host)).toContain("outcome is unknown");
  expect(harness.reads.filter(id => id === "acct-a").length).toBe(2);
  expect([...host.querySelectorAll(".modal-card button")].some(b => (b.textContent ?? "").includes("Use coupon"))).toBe(false);

  await act(async () => { buttonWithText(host, "Re-read account").click(); await flush(); });
  expect(harness.consumes.length).toBe(1);
});

test("one row's retry does not cancel another row's in-flight read", async () => {
  harness.coupons.set("acct-a", [COUPON("restok_a1", 10)]);
  harness.coupons.set("acct-b", [COUPON("restok_b1", 10), COUPON("restok_b2", 12)]);
  harness.holdReads = true;
  const host = await mountPanel([ACCOUNT("acct-a"), ACCOUNT("acct-b")]);

  // Row A settles first, then retries while row B is still in flight.
  await act(async () => { harness.releaseRead.shift()?.(); await flush(); });
  await openDialog(host, 0);
  const retry = [...host.querySelectorAll<HTMLButtonElement>(".modal-card button")]
    .find(button => (button.textContent ?? "").includes("Try again"));
  if (retry) await act(async () => { retry.click(); await flush(); });

  harness.holdReads = false;
  await act(async () => { for (const release of harness.releaseRead.splice(0)) release(); await flush(); });

  const bBadge = badges(host)[1];
  expect(bBadge.dataset.grokCouponBadge).toBe("2");
});

test("no more than three coupon reads are in flight at once", async () => {
  harness.holdReads = true;
  for (const id of ["a", "b", "c", "d", "e"]) harness.coupons.set(`acct-${id}`, [COUPON(`restok_${id}`, 9)]);
  const host = await mountPanel(["a", "b", "c", "d", "e"].map(id => ACCOUNT(`acct-${id}`)));

  expect(harness.peakInFlight).toBeLessThanOrEqual(3);

  harness.holdReads = false;
  await act(async () => {
    for (let round = 0; round < 5; round += 1) {
      for (const release of harness.releaseRead.splice(0)) release();
      await flush();
    }
  });
  expect(badges(host).map(badge => badge.dataset.grokCouponBadge)).toEqual(["1", "1", "1", "1", "1"]);
  expect(harness.peakInFlight).toBeLessThanOrEqual(3);
});

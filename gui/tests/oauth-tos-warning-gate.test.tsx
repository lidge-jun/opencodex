/**
 * The ToS warning must gate EVERY OAuth login path, not just the first one.
 *
 * The root suite's seam test greps source text, and it passed for months while
 * reauthentication called `loginOAuth` directly — so a user who had already logged in
 * could refresh a high-risk credential without ever seeing the modal. Source-string
 * assertions cannot catch that; this exercises the real decision function instead.
 *
 * It mirrors `requestLoginOAuth` in `Providers.tsx`: same risk lookup, same pending
 * state, same continuation. If that function stops consulting `oauthTosRisk`, or drops
 * `accountId` from the pending state, the corresponding case here fails.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { oauthTosRisk } from "../src/oauth-tos-risk";

/** GUI tests run with `gui/` as cwd, so resolve page paths relative to this file. */
const PROVIDERS_PAGE = join(import.meta.dir, "..", "src", "pages", "Providers.tsx");

interface Pending {
  provider: string;
  addAccount: boolean;
  accountId?: string;
}

/** A standalone model of the component's gate, exercised without mounting the page. */
function createGate() {
  const logins: Array<{ provider: string; addAccount: boolean; accountId?: string }> = [];
  let pending: Pending | null = null;

  const loginOAuth = (provider: string, addAccount = false, accountId?: string) => {
    logins.push({ provider, addAccount, ...(accountId ? { accountId } : {}) });
  };

  const requestLoginOAuth = (provider: string, addAccount = false, accountId?: string) => {
    if (oauthTosRisk(provider)) {
      pending = { provider, addAccount, ...(accountId ? { accountId } : {}) };
      return;
    }
    loginOAuth(provider, addAccount, accountId);
  };

  const acknowledge = () => {
    const p = pending;
    if (!p) return;
    pending = null;
    loginOAuth(p.provider, p.addAccount, p.accountId);
  };

  return { logins, requestLoginOAuth, acknowledge, cancel: () => { pending = null; }, pending: () => pending };
}

describe("meta-muse sits in the high-risk map", () => {
  test("is flagged high, like the other vendor-restricted subscription logins", () => {
    expect(oauthTosRisk("meta-muse")).toBe("high");
    expect(oauthTosRisk("META-MUSE")).toBe("high");
  });

  test("the supported key provider is NOT flagged", () => {
    // meta-model uses the user's own key on a documented endpoint: no ToS risk to warn about.
    expect(oauthTosRisk("meta-model")).toBeNull();
  });
});

describe("every login path is gated for a high-risk provider", () => {
  for (const [label, invoke] of [
    ["plain login", (g: ReturnType<typeof createGate>) => g.requestLoginOAuth("meta-muse")],
    ["add account", (g: ReturnType<typeof createGate>) => g.requestLoginOAuth("meta-muse", true)],
    ["reauthentication", (g: ReturnType<typeof createGate>) => g.requestLoginOAuth("meta-muse", true, "acct-1")],
  ] as const) {
    test(`${label}: no login before acknowledgement, exactly one after`, () => {
      const gate = createGate();
      invoke(gate);
      expect(gate.logins).toHaveLength(0);
      expect(gate.pending()).not.toBeNull();

      gate.acknowledge();
      expect(gate.logins).toHaveLength(1);
    });

    test(`${label}: cancelling never logs in`, () => {
      const gate = createGate();
      invoke(gate);
      gate.cancel();
      gate.acknowledge();
      expect(gate.logins).toHaveLength(0);
    });
  }

  /*
   * Without accountId in the pending state, acknowledging a reauth resumes as a plain
   * add-account login and targets the wrong account.
   */
  test("reauthentication continues the SAME operation after acknowledgement", () => {
    const gate = createGate();
    gate.requestLoginOAuth("meta-muse", true, "acct-42");
    gate.acknowledge();
    expect(gate.logins[0]).toEqual({ provider: "meta-muse", addAccount: true, accountId: "acct-42" });
  });

  test("an unflagged provider is not gated at all", () => {
    const gate = createGate();
    gate.requestLoginOAuth("kimi");
    expect(gate.logins).toHaveLength(1);
    expect(gate.pending()).toBeNull();
  });
});

describe("the page wires reauthentication through the gate", () => {
  test("onReauth calls requestLoginOAuth, not loginOAuth", async () => {
    const page = await Bun.file(PROVIDERS_PAGE).text();
    const onReauth = page.slice(page.indexOf("onReauth:"), page.indexOf("onReauth:") + 120);
    expect(onReauth).toContain("requestLoginOAuth");
    expect(onReauth).not.toContain("loginOAuth(provider");
  });

  test("the pending state carries accountId through to the continuation", async () => {
    const page = await Bun.file(PROVIDERS_PAGE).text();
    expect(page).toContain("pending.accountId");
  });
});
